-- Security Phase 2 - hardened v2 coordinator-allocation RPCs. Companion to
-- 20260813110000_election_day_reauth_proof_infrastructure.sql and
-- 20260813110100_election_day_admin_v2_rpcs.sql (Security Phase 1).
--
-- Extends the exact same proof-based auth pattern Security Phase 1 already
-- shipped for 7 admin RPCs + election_day_import_voters to the 4 remaining
-- coordinator-allocation business RPCs from
-- 20260813100000_election_day_manage_coordinators_rpc.sql and
-- 20260813100100_election_day_coordinator_allocation_rpcs.sql, which still
-- took a raw p_actor_id/p_actor_password pair. Same approved versioning
-- strategy as Phase 1: every function here is a BRAND NEW name (_v2 suffix),
-- a genuinely distinct pg_proc object. The 4 original v1 functions
-- (election_day_manage_coordinators, election_day_apply_initial_allocation,
-- election_day_rebalance_assignments, election_day_end_coordinator_activity)
-- are NOT touched by this migration at all - same name, same signature,
-- same grants, same body, still fully functional, still reachable. This is
-- what makes a real compatibility window possible: old and new frontend code
-- can call their respective RPC names simultaneously with zero interference.
-- Retirement (REVOKE EXECUTE on the old names) is a deliberately separate,
-- later, explicitly-approved Security Phase 3 - not part of this migration.
--
-- Every function below follows the same auth prelude as Phase 1's v2 RPCs,
-- in this order:
--   1. resolve the acting identity from the proof alone via
--      election_day_verify_reauth_proof(p_reauth_proof) - never a
--      client-supplied actor_id (UNAUTHORIZED on invalid/expired/forged
--      proof, raised by that helper itself).
--   2. check the resolved actor's CURRENT role holds
--      electionDay.manageCoordinatorAllocation (FORBIDDEN otherwise) - read
--      live from election_day_roles every call, never cached/snapshotted in
--      the proof, so a permission change takes effect immediately regardless
--      of proof validity.
--   3. only then does the original v1 business logic run, copied verbatim
--      (same validation order, same error codes, same locking discipline,
--      same audit-row shape, same return shape) - this migration adds an
--      auth precondition, it does not alter any existing business rule.
-- Every function auth-fails with zero mutation, by construction: the
-- proof/permission check happens before any lock/read/write of coordinator
-- or voter business state in every function body below.
--
-- Locking discipline preserved unchanged from v1 (see the two source
-- migrations' own header comments for the full reasoning):
--   - election_day_manage_coordinators_v2 does NOT take the global
--     election_day_voter_allocation_mutation advisory lock - it never reads
--     or writes election_day_voters at all, only election_day_coordinators,
--     via the same per-batch row-level FOR UPDATE locks v1 already takes.
--   - election_day_apply_initial_allocation_v2,
--     election_day_rebalance_assignments_v2, and
--     election_day_end_coordinator_activity_v2 all acquire the exact same
--     transaction-level advisory lock -
--     pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint)
--     - as v1 and election_day_import_voters_v2, in the same relative
--     position: after the proof/permission auth precondition AND after pure
--     input-shape validation that touches no table, but before any
--     coordinator/voter row lock. This preserves the exact
--     lock-then-guard-then-mutate concurrency ordering already runtime-
--     verified for v1 and for election_day_import_voters_v2 - C1-C4 hold
--     identically for the v2 RPCs since they contend for the same lock key.
--
-- Security mode: all 4 v1 functions here were already SECURITY DEFINER (see
-- 20260813100000/20260813100100 - confirmed by rereading both files before
-- writing this migration), unlike election_day_import_voters' v1 SECURITY
-- INVOKER. No security-mode flip is therefore needed for these 4, unlike
-- election_day_import_voters_v2 in Phase 1 - they simply keep SECURITY
-- DEFINER, which already permits the nested election_day_verify_reauth_proof
-- call (itself owner-only) to succeed for real anon/authenticated callers.
begin;

-- ============================================================================
-- 1. election_day_manage_coordinators_v2 -
-- electionDay.manageCoordinatorAllocation. Business logic identical to
-- election_day_manage_coordinators (20260813100000): atomic batch of
-- add/edit/remove/link/unlink/relink actions, same lock-every-referenced-
-- coordinator-ascending-by-id-up-front discipline, same
-- election_day_has_allocation_activity()/election_day_coordinator_participated()
-- gates, same cross-column ownership invariant, same error codes. v1 never
-- reads p_actor_id/p_actor_password past the auth prelude (no executed_by
-- column on election_day_coordinators), so the v2 auth prelude only needs
-- the resolved actor's role_id, not their id/name.
-- ============================================================================
create or replace function public.election_day_manage_coordinators_v2(
  p_reauth_proof text,
  p_actions jsonb
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_lock_ids uuid[];
  v_action jsonb;
  v_action_type text;
  v_coordinator_id uuid;
  v_display_name text;
  v_linked_name text;
  v_existing_linked_name text;
begin
  -- 1. Resolve the actor from the proof alone (UNAUTHORIZED on any
  -- invalid/expired/forged/blank proof, raised inside the helper itself).
  select v.role_id into v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  -- 2. Verify the actor's CURRENT role holds
  -- electionDay.manageCoordinatorAllocation, read live every call.
  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  if p_actions is null or jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) = 0 then
    raise exception 'NO_ACTIONS';
  end if;

  -- 3. Lock every coordinator row this batch references, once, in a single
  -- ascending-id pass, before processing any action.
  select array_agg(distinct x.id order by x.id)
    into v_lock_ids
  from jsonb_array_elements(p_actions) as elem
  cross join lateral (select nullif(elem->>'coordinator_id', '')::uuid as id) as x
  where x.id is not null;

  if v_lock_ids is not null then
    perform 1 from public.election_day_coordinators
    where id = any(v_lock_ids)
    order by id
    for update;
  end if;

  -- 4. Process each action in the order supplied. Any RAISE EXCEPTION below
  -- propagates out of this function and rolls back every effect of this
  -- call (all-or-nothing) - there is no partial-batch outcome.
  for v_action in select * from jsonb_array_elements(p_actions)
  loop
    v_action_type := v_action->>'action';
    v_coordinator_id := nullif(v_action->>'coordinator_id', '')::uuid;
    v_display_name := nullif(btrim(v_action->>'display_name'), '');
    v_linked_name := nullif(btrim(v_action->>'linked_assignment_name'), '');

    if v_action_type = 'add' then
      if v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.linked_assignment_name = v_display_name
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      insert into public.election_day_coordinators (display_name)
      values (v_display_name);

    elsif v_action_type = 'edit' then
      if v_coordinator_id is null or v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      if not exists (select 1 from public.election_day_coordinators where id = v_coordinator_id) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_has_allocation_activity() then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.linked_assignment_name = v_display_name
          and c.id <> v_coordinator_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      update public.election_day_coordinators
      set display_name = v_display_name
      where id = v_coordinator_id;

    elsif v_action_type = 'remove' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if not exists (select 1 from public.election_day_coordinators where id = v_coordinator_id) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_has_allocation_activity() then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      delete from public.election_day_coordinators where id = v_coordinator_id;

    elsif v_action_type in ('link', 'relink') then
      if v_coordinator_id is null or v_linked_name is null then
        raise exception 'INVALID_LINK';
      end if;

      if not exists (select 1 from public.election_day_coordinators where id = v_coordinator_id) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.status = 'active'
          and c.id <> v_coordinator_id
          and c.display_name = v_linked_name
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and c.linked_assignment_name = v_linked_name
      ) then
        raise exception 'ASSIGNMENT_ALREADY_LINKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = v_linked_name
      where id = v_coordinator_id;

    elsif v_action_type = 'unlink' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      select linked_assignment_name into v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = null
      where id = v_coordinator_id;

    else
      raise exception 'INVALID_ACTION';
    end if;
  end loop;

  -- 5. Return the full current coordinator roster.
  return query select * from public.election_day_coordinators order by created_at asc, id asc;
end;
$$;

comment on function public.election_day_manage_coordinators_v2(text, jsonb) is
  'Security Phase 2: proof-based, live-permission-checked replacement for election_day_manage_coordinators (which took a raw p_actor_id/p_actor_password pair). Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role (re-read every call, never proof-snapshotted) before any mutation. Business logic (atomic batch add/edit/remove/link/unlink/relink, DISPLAY_NAME_LOCKED/COORDINATOR_LOCKED gating via election_day_has_allocation_activity/election_day_coordinator_participated, the cross-column ownership invariant) is unchanged from v1, byte-for-byte. Does NOT take the global election_day_voter_allocation_mutation advisory lock, matching v1''s own documented reasoning - this function only ever touches election_day_coordinators via row-level FOR UPDATE, never election_day_voters. The v1 function is untouched and remains temporarily reachable for compatibility (retirement is a separate later phase).';

revoke all on function public.election_day_manage_coordinators_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_manage_coordinators_v2(text, jsonb) to anon, authenticated;

-- ============================================================================
-- 2. election_day_apply_initial_allocation_v2 -
-- electionDay.manageCoordinatorAllocation. Business logic identical to
-- election_day_apply_initial_allocation (20260813100100): one-time
-- distribution of every currently-unassigned voter (coordinator IS NULL)
-- across the given active coordinators, by quantity only. v1 uses
-- p_actor_id and the actor's own name in the operations audit row
-- (executed_by_id/executed_by_name_snapshot), so the v2 auth prelude
-- captures actor_id/actor_name/role_id together from the single proof
-- verification call.
-- ============================================================================
create or replace function public.election_day_apply_initial_allocation_v2(
  p_reauth_proof text,
  p_assignments jsonb
)
returns table (
  operation_id uuid,
  allocated_count integer,
  remaining_unassigned_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_permission boolean;
  v_elem jsonb;
  v_coordinator_id uuid;
  v_quantity integer;
  v_sum_quantities integer := 0;
  v_lock_ids uuid[];
  v_locked_coordinator_count integer;
  v_unassigned_count integer;
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
begin
  -- 1. Resolve the actor from the proof alone.
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  -- 2. Verify the actor's CURRENT role holds
  -- electionDay.manageCoordinatorAllocation, read live every call.
  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  -- Validate assignment shape/values.
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'INVALID_ASSIGNMENT_SHAPE';
  end if;

  for v_elem in select * from jsonb_array_elements(p_assignments)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;

    begin
      v_coordinator_id := (v_elem->>'coordinator_id')::uuid;
      v_quantity := (v_elem->>'quantity')::integer;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;

    if v_quantity < 0 then
      raise exception 'NEGATIVE_QUANTITY';
    end if;

    v_sum_quantities := v_sum_quantities + v_quantity;
  end loop;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_assignments) elem
  ) <> jsonb_array_length(p_assignments) then
    raise exception 'DUPLICATE_COORDINATOR_IN_ASSIGNMENTS';
  end if;

  if v_sum_quantities <= 0 then
    raise exception 'NO_MEANINGFUL_ASSIGNMENT';
  end if;

  -- Global Election Day import/allocation mutation lock - acquired after
  -- the auth precondition and all pure input-shape validation above, before
  -- any read/lock of coordinator or voter business state below. Same lock
  -- key as v1 and election_day_import_voters_v2 - preserves the exact
  -- lock-then-guard-then-mutate concurrency ordering already
  -- runtime-verified for v1.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock every referenced coordinator, ascending by id, then validate.
  select array_agg(distinct (elem->>'coordinator_id')::uuid order by (elem->>'coordinator_id')::uuid)
    into v_lock_ids
  from jsonb_array_elements(p_assignments) elem;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
  order by id
  for update;
  get diagnostics v_locked_coordinator_count = row_count;

  if v_locked_coordinator_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  -- Lock every currently-unassigned voter, deterministic order, and get the
  -- true post-lock count in one pass.
  perform 1 from public.election_day_voters
  where coordinator is null
  order by created_at asc, id asc
  for update;
  get diagnostics v_unassigned_count = row_count;

  if v_unassigned_count = 0 then
    raise exception 'NO_UNASSIGNED_VOTERS';
  end if;

  if v_sum_quantities <> v_unassigned_count then
    raise exception 'ALLOCATION_COUNT_MISMATCH';
  end if;

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - this array becomes the sole source of truth for the
  -- mapping/update/audit below, never re-derived from the mutable
  -- `coordinator IS NULL` predicate again.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', v_actor_id, v_actor_name, null, null)
  returning id into v_operation_id;

  -- Deterministic mapping: the exact locked voters (v_locked_voter_ids),
  -- ordered by created_at/id, are sliced into contiguous ranges matching
  -- p_assignments' own array order and quantities - no voter id ever comes
  -- from the client, and no row outside the locked set can enter this
  -- mapping (selected = locked = updated = audited).
  with ordered_voters as (
    select v.id, v.first_name || ' ' || v.last_name as full_name,
           row_number() over (order by v.created_at asc, v.id asc) as rn
    from public.election_day_voters v
    where v.id = any(v_locked_voter_ids)
  ),
  ordered_assignments as (
    select (elem->>'coordinator_id')::uuid as coordinator_id,
           (elem->>'quantity')::integer as quantity,
           ordinality
    from jsonb_array_elements(p_assignments) with ordinality as t(elem, ordinality)
  ),
  ranged_assignments as (
    select coordinator_id, quantity,
      coalesce(sum(quantity) over (order by ordinality rows between unbounded preceding and 1 preceding), 0) as range_start
    from ordered_assignments
  ),
  assignment_map as (
    select ov.id as voter_id, ov.full_name, ra.coordinator_id
    from ranged_assignments ra
    join ordered_voters ov
      on ov.rn > ra.range_start and ov.rn <= ra.range_start + ra.quantity
  ),
  updated as (
    update public.election_day_voters v
    set coordinator = c.display_name
    from assignment_map am
    join public.election_day_coordinators c on c.id = am.coordinator_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.coordinator_id, c.display_name as coordinator_display_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, null, null, u.coordinator_id, u.coordinator_display_name
  from updated u;

  return query select v_operation_id, v_unassigned_count, 0;
end;
$$;

comment on function public.election_day_apply_initial_allocation_v2(text, jsonb) is
  'Security Phase 2: proof-based, live-permission-checked replacement for election_day_apply_initial_allocation (which took a raw p_actor_id/p_actor_password pair). Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role (re-read every call, never proof-snapshotted) before any mutation. Business logic (INVALID_ASSIGNMENT_SHAPE/NEGATIVE_QUANTITY/DUPLICATE_COORDINATOR_IN_ASSIGNMENTS/NO_MEANINGFUL_ASSIGNMENT/COORDINATOR_NOT_FOUND/COORDINATOR_NOT_ACTIVE/NO_UNASSIGNED_VOTERS/ALLOCATION_COUNT_MISMATCH checks, the global election_day_voter_allocation_mutation advisory lock acquired after auth+shape validation and before any coordinator/voter lock, deterministic created_at/id-ascending voter selection, locked=updated=audited invariant) unchanged from v1, byte-for-byte. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_apply_initial_allocation_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_apply_initial_allocation_v2(text, jsonb) to anon, authenticated;

-- ============================================================================
-- 3. election_day_rebalance_assignments_v2 -
-- electionDay.manageCoordinatorAllocation. Business logic identical to
-- election_day_rebalance_assignments (20260813100100): mid-day transfer of
-- "remaining" voters from source coordinators to destination coordinators.
-- ============================================================================
create or replace function public.election_day_rebalance_assignments_v2(
  p_reauth_proof text,
  p_sources jsonb,
  p_destinations jsonb
)
returns table (
  operation_id uuid,
  transferred_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_permission boolean;
  v_elem jsonb;
  v_quantity integer;
  v_sum_sources integer := 0;
  v_sum_destinations integer := 0;
  v_lock_ids uuid[];
  v_locked_count integer;
  v_source_names text[];
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
  v_transferred_count integer;
begin
  -- 1. Resolve the actor from the proof alone.
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  -- 2. Verify the actor's CURRENT role holds
  -- electionDay.manageCoordinatorAllocation, read live every call.
  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  -- Validate shape of both arrays.
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) = 0
     or p_destinations is null or jsonb_typeof(p_destinations) <> 'array' or jsonb_array_length(p_destinations) = 0
  then
    raise exception 'INVALID_ASSIGNMENT_SHAPE';
  end if;

  for v_elem in select * from jsonb_array_elements(p_sources)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;
    begin
      v_quantity := (v_elem->>'quantity')::integer;
      perform (v_elem->>'coordinator_id')::uuid;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;
    if v_quantity <= 0 then
      raise exception 'NON_POSITIVE_QUANTITY';
    end if;
    v_sum_sources := v_sum_sources + v_quantity;
  end loop;

  for v_elem in select * from jsonb_array_elements(p_destinations)
  loop
    if v_elem->>'coordinator_id' is null or v_elem->>'quantity' is null then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end if;
    begin
      v_quantity := (v_elem->>'quantity')::integer;
      perform (v_elem->>'coordinator_id')::uuid;
    exception when others then
      raise exception 'INVALID_ASSIGNMENT_SHAPE';
    end;
    if v_quantity <= 0 then
      raise exception 'NON_POSITIVE_QUANTITY';
    end if;
    v_sum_destinations := v_sum_destinations + v_quantity;
  end loop;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_sources) elem
  ) <> jsonb_array_length(p_sources) then
    raise exception 'DUPLICATE_COORDINATOR_IN_SOURCES';
  end if;

  if (
    select count(distinct elem->>'coordinator_id') from jsonb_array_elements(p_destinations) elem
  ) <> jsonb_array_length(p_destinations) then
    raise exception 'DUPLICATE_COORDINATOR_IN_DESTINATIONS';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_sources) s
    join jsonb_array_elements(p_destinations) d
      on s->>'coordinator_id' = d->>'coordinator_id'
  ) then
    raise exception 'SOURCE_DESTINATION_OVERLAP';
  end if;

  if v_sum_sources <> v_sum_destinations then
    raise exception 'REBALANCE_SUM_MISMATCH';
  end if;

  -- Global Election Day import/allocation mutation lock - acquired after
  -- the auth precondition and all pure input-shape validation above, before
  -- any read/lock of coordinator or voter business state below.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock every referenced coordinator (sources + destinations), ascending
  -- by id, in one pass; validate all found and active.
  select array_agg(distinct x.id order by x.id) into v_lock_ids
  from (
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_sources) elem
    union
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_destinations) elem
  ) x;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
  order by id
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  -- Lock every eligible voter across all sources in one deterministic pass.
  select array_agg(distinct name) into v_source_names
  from (
    select c.display_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c on c.id = (elem->>'coordinator_id')::uuid
    union
    select c.linked_assignment_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c on c.id = (elem->>'coordinator_id')::uuid
    where c.linked_assignment_name is not null
  ) names;

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - this array (not the mutable coordinator/remaining
  -- predicate) is the sole source of truth for every step below.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  -- Per-source recount: each source's requested quantity must not exceed
  -- its own true, post-lock eligible count - restricted to the locked id
  -- set captured above, never a live re-match of the predicate.
  if exists (
    select 1
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c on c.id = (elem->>'coordinator_id')::uuid
    where (elem->>'quantity')::integer > (
      select count(*)
      from public.election_day_voters v
      where v.id = any(v_locked_voter_ids)
        and v.coordinator = any(array_remove(array[c.display_name, c.linked_assignment_name], null))
    )
  ) then
    raise exception 'REBALANCE_SOURCE_INSUFFICIENT';
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('rebalance', v_actor_id, v_actor_name, null, null)
  returning id into v_operation_id;

  with source_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, src_ord
    from jsonb_array_elements(p_sources) with ordinality as t(elem, src_ord)
  ),
  source_names as (
    select sm.coordinator_id, sm.quantity, sm.src_ord, c.display_name,
      array_remove(array[c.display_name, c.linked_assignment_name], null) as names
    from source_map sm
    join public.election_day_coordinators c on c.id = sm.coordinator_id
  ),
  eligible_voters as (
    select v.id, v.first_name || ' ' || v.last_name as full_name,
           sn.coordinator_id as source_id, sn.display_name as source_display_name, sn.src_ord,
           row_number() over (partition by sn.coordinator_id order by v.created_at asc, v.id asc) as within_source_rn
    from public.election_day_voters v
    join source_names sn on v.coordinator = any(sn.names)
    where v.id = any(v_locked_voter_ids)
  ),
  selected_source_voters as (
    select ev.*
    from eligible_voters ev
    join source_names sn on sn.coordinator_id = ev.source_id
    where ev.within_source_rn <= sn.quantity
  ),
  ordered_transferred as (
    select *,
      row_number() over (order by src_ord asc, within_source_rn asc) as global_rn
    from selected_source_voters
  ),
  destination_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, dst_ord
    from jsonb_array_elements(p_destinations) with ordinality as t(elem, dst_ord)
  ),
  ranged_destinations as (
    select coordinator_id, quantity,
      coalesce(sum(quantity) over (order by dst_ord rows between unbounded preceding and 1 preceding), 0) as range_start
    from destination_map
  ),
  assignment_map as (
    select ot.id as voter_id, ot.full_name, ot.source_id, ot.source_display_name, rd.coordinator_id as dest_id
    from ordered_transferred ot
    join ranged_destinations rd
      on ot.global_rn > rd.range_start and ot.global_rn <= rd.range_start + rd.quantity
  ),
  updated as (
    update public.election_day_voters v
    set coordinator = dc.display_name
    from assignment_map am
    join public.election_day_coordinators dc on dc.id = am.dest_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.source_id, am.source_display_name, dc.id as to_id, dc.display_name as to_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, u.source_id, u.source_display_name, u.to_id, u.to_name
  from updated u;

  get diagnostics v_transferred_count = row_count;

  return query select v_operation_id, v_transferred_count;
end;
$$;

comment on function public.election_day_rebalance_assignments_v2(text, jsonb, jsonb) is
  'Security Phase 2: proof-based, live-permission-checked replacement for election_day_rebalance_assignments (which took a raw p_actor_id/p_actor_password pair). Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role (re-read every call, never proof-snapshotted) before any mutation. Business logic (SOURCE_DESTINATION_OVERLAP/REBALANCE_SUM_MISMATCH/REBALANCE_SOURCE_INSUFFICIENT/COORDINATOR_NOT_FOUND/COORDINATOR_NOT_ACTIVE/DUPLICATE_COORDINATOR_IN_SOURCES/DUPLICATE_COORDINATOR_IN_DESTINATIONS/NON_POSITIVE_QUANTITY/INVALID_ASSIGNMENT_SHAPE checks, election_day_voter_is_remaining eligibility, display_name AND linked_assignment_name both counting as source ownership, the global election_day_voter_allocation_mutation advisory lock, captured-locked-id-set discipline) unchanged from v1, byte-for-byte. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_rebalance_assignments_v2(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_rebalance_assignments_v2(text, jsonb, jsonb) to anon, authenticated;

-- ============================================================================
-- 4. election_day_end_coordinator_activity_v2 -
-- electionDay.manageCoordinatorAllocation. Business logic identical to
-- election_day_end_coordinator_activity (20260813100100): ends one active
-- coordinator's activity, moving its "remaining" voters either to one named
-- target (mode = 'transfer') or split equally across every other active
-- coordinator (mode = 'equal_split').
-- ============================================================================
create or replace function public.election_day_end_coordinator_activity_v2(
  p_reauth_proof text,
  p_coordinator_id uuid,
  p_mode text,
  p_target_coordinator_id uuid
)
returns table (
  operation_id uuid,
  transferred_count integer,
  ended_coordinator_id uuid,
  ended_coordinator_display_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_permission boolean;
  v_source_display_name text;
  v_source_linked_name text;
  v_source_names text[];
  v_target_display_name text;
  v_destinations_count integer;
  v_remaining_count integer;
  v_locked_voter_ids uuid[];
  v_operation_id uuid;
  v_moved_count integer := 0;
begin
  -- 1. Resolve the actor from the proof alone.
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  -- 2. Verify the actor's CURRENT role holds
  -- electionDay.manageCoordinatorAllocation, read live every call.
  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  if p_mode not in ('transfer', 'equal_split') then
    raise exception 'INVALID_MODE';
  end if;

  if p_mode = 'transfer' and (p_target_coordinator_id is null or p_target_coordinator_id = p_coordinator_id) then
    raise exception 'INVALID_TARGET';
  end if;

  -- Global Election Day import/allocation mutation lock - acquired after
  -- the auth precondition and all pure input-shape validation above, before
  -- any read/lock of coordinator or voter business state below.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock the coordinator rows this call can possibly touch, ascending by
  -- id, in one pass: the source, plus (transfer mode only) the named
  -- target. equal_split's destination set is "every other active
  -- coordinator", locked separately below once the source's own status is
  -- confirmed.
  if p_mode = 'transfer' then
    perform 1 from public.election_day_coordinators
    where id = any(array[p_coordinator_id, p_target_coordinator_id]::uuid[])
    order by id
    for update;
  else
    perform 1 from public.election_day_coordinators
    where id = p_coordinator_id
    for update;
  end if;

  select display_name, linked_assignment_name into v_source_display_name, v_source_linked_name
  from public.election_day_coordinators
  where id = p_coordinator_id;

  if not found then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if (select status from public.election_day_coordinators where id = p_coordinator_id) <> 'active' then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  if p_mode = 'transfer' then
    select display_name into v_target_display_name
    from public.election_day_coordinators
    where id = p_target_coordinator_id;

    if not found then
      raise exception 'TARGET_NOT_FOUND';
    end if;

    if (select status from public.election_day_coordinators where id = p_target_coordinator_id) <> 'active' then
      raise exception 'TARGET_NOT_ACTIVE';
    end if;
  end if;

  v_source_names := array_remove(array[v_source_display_name, v_source_linked_name], null);

  -- Lock the source's remaining voters, deterministic order, get the count.
  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;
  get diagnostics v_remaining_count = row_count;

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - this array is the sole source of truth for the
  -- transfer/equal_split move and its audit items below, never a live
  -- re-match of the coordinator/remaining predicate.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if p_mode = 'equal_split' then
    -- Lock every other currently active coordinator now - after the
    -- source's own status is confirmed, before deciding whether the
    -- last-active-coordinator guard applies.
    perform 1 from public.election_day_coordinators
    where status = 'active' and id <> p_coordinator_id
    order by id
    for update;
    get diagnostics v_destinations_count = row_count;

    if v_remaining_count > 0 and v_destinations_count = 0 then
      raise exception 'LAST_ACTIVE_COORDINATOR';
    end if;
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('coordinator_end', v_actor_id, v_actor_name, p_coordinator_id, v_source_display_name)
  returning id into v_operation_id;

  if v_remaining_count > 0 and p_mode = 'transfer' then
    with moved as (
      update public.election_day_voters v
      set coordinator = v_target_display_name
      where v.id = any(v_locked_voter_ids)
      returning v.id, v.first_name || ' ' || v.last_name as full_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, m.id, m.full_name, p_coordinator_id, v_source_display_name, p_target_coordinator_id, v_target_display_name
    from moved m;

    v_moved_count := v_remaining_count;

  elsif v_remaining_count > 0 and p_mode = 'equal_split' then
    with destinations_ordered as (
      select id, display_name,
        (row_number() over (order by id asc) - 1)::integer as idx
      from public.election_day_coordinators
      where status = 'active' and id <> p_coordinator_id
    ),
    dest_quantities as (
      select id, display_name, idx,
        (v_remaining_count / v_destinations_count)
          + case when idx < (v_remaining_count % v_destinations_count) then 1 else 0 end as quantity
      from destinations_ordered
    ),
    ranged_destinations as (
      select id, display_name, quantity,
        coalesce(sum(quantity) over (order by idx rows between unbounded preceding and 1 preceding), 0) as range_start
      from dest_quantities
    ),
    ordered_source_voters as (
      select v.id, v.first_name || ' ' || v.last_name as full_name,
        row_number() over (order by v.created_at asc, v.id asc) as rn
      from public.election_day_voters v
      where v.id = any(v_locked_voter_ids)
    ),
    assignment_map as (
      select osv.id as voter_id, osv.full_name, rd.id as dest_id, rd.display_name as dest_name
      from ordered_source_voters osv
      join ranged_destinations rd
        on osv.rn > rd.range_start and osv.rn <= rd.range_start + rd.quantity
    ),
    updated as (
      update public.election_day_voters v
      set coordinator = am.dest_name
      from assignment_map am
      where v.id = am.voter_id
      returning v.id, am.full_name, am.dest_id, am.dest_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, u.id, u.full_name, p_coordinator_id, v_source_display_name, u.dest_id, u.dest_name
    from updated u;

    v_moved_count := v_remaining_count;
  end if;

  update public.election_day_coordinators
  set status = 'ended', ended_at = now()
  where id = p_coordinator_id;

  return query select v_operation_id, v_moved_count, p_coordinator_id, v_source_display_name;
end;
$$;

comment on function public.election_day_end_coordinator_activity_v2(text, uuid, text, uuid) is
  'Security Phase 2: proof-based, live-permission-checked replacement for election_day_end_coordinator_activity (which took a raw p_actor_id/p_actor_password pair). Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role (re-read every call, never proof-snapshotted) before any mutation. Business logic (transfer vs equal_split modes, deterministic even-split with remainder to earliest-id destinations, LAST_ACTIVE_COORDINATOR only when remaining>0 and 0 other active coordinators, a coordinator_end operation row always written on success even with 0 items moved, source coordinator always ends - never deleted, INVALID_MODE/INVALID_TARGET/COORDINATOR_NOT_FOUND/COORDINATOR_NOT_ACTIVE/TARGET_NOT_FOUND/TARGET_NOT_ACTIVE checks, the global election_day_voter_allocation_mutation advisory lock) unchanged from v1, byte-for-byte. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_end_coordinator_activity_v2(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.election_day_end_coordinator_activity_v2(text, uuid, text, uuid) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_end_coordinator_activity_v2(text, uuid, text, uuid);
--   drop function if exists public.election_day_rebalance_assignments_v2(text, jsonb, jsonb);
--   drop function if exists public.election_day_apply_initial_allocation_v2(text, jsonb);
--   drop function if exists public.election_day_manage_coordinators_v2(text, jsonb);
--   commit;
--
-- (v1 functions were never touched by this migration - no v1 rollback is
-- needed or provided here.)
-- ============================================================================
