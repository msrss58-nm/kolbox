-- Coordinator Allocation Management - Phase 3 (RPC core), part B/2.
-- Adds:
--   1. election_day_voter_is_remaining(boolean, uuid) - a small boolean
--      helper mirroring src/features/election-day/followUpStatus.ts's
--      resolveFollowUpStatus "remaining" branch exactly (voted = false, and
--      either no not_voting_reason_id or a reason whose requires_follow_up
--      is not false) - the single SQL source of truth for "still
--      transferable", reused by both RPCs below so their eligibility logic
--      can never drift apart from each other or from the frontend.
--   2. election_day_apply_initial_allocation(p_actor_id, p_actor_password,
--      p_assignments) - one-time distribution of every currently-unassigned
--      voter (coordinator IS NULL) across the given active coordinators.
--   3. election_day_rebalance_assignments(p_actor_id, p_actor_password,
--      p_sources, p_destinations) - mid-day transfer of "remaining" voters
--      from source coordinators to destination coordinators.
--   4. election_day_end_coordinator_activity(p_actor_id, p_actor_password,
--      p_coordinator_id, p_mode, p_target_coordinator_id) - ends one active
--      coordinator's activity, moving its "remaining" voters either to one
--      named target (mode = 'transfer') or split equally across every other
--      active coordinator (mode = 'equal_split').
--
-- All three business RPCs reuse the exact same actor re-authentication +
-- permission-check pattern as election_day_manage_coordinators (part A) and
-- election_day_reset_permission_user_password before it - bcrypt-verify
-- p_actor_password against the actor's own password_hash (UNAUTHORIZED),
-- then require electionDay.manageCoordinatorAllocation on the actor's role
-- (FORBIDDEN). Only then does any locking or business logic run.
--
-- Locking discipline (identical shape in all three): acquire the global
-- Election Day import/allocation mutation lock (see below) first; only then
-- lock every referenced coordinator row, in ascending-id order, in one
-- pass; only then lock the affected voter rows, in a single deterministic
-- created_at/id-ascending pass; only then re-validate counts against what
-- the client asked for. Client-sent "preview" counts/ids are never trusted
-- past this point - a stale preview aborts the whole call with a stable
-- error, never a best-effort partial result. All writes (voter updates +
-- operation + operation_items rows) happen in the same function body, i.e.
-- the same transaction, so a failure at any point leaves the database
-- exactly as it was before the call.
--
-- Global import/allocation mutation lock (added in this same migration,
-- final concurrency hardening pass): election_day_import_voters and all 3
-- business RPCs below acquire the exact same transaction-level advisory
-- lock - pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint)
-- - right after their own auth/permission check succeeds (import has no
-- actor auth, so it acquires the lock as literally its first statement),
-- and before touching any coordinator/voter business state. The lock is
-- released automatically at this transaction's commit or rollback (never
-- explicitly unlocked). This closes the race where an import could pass
-- election_day_has_allocation_activity()'s guard and a business allocation
-- could commit concurrently: with the shared lock, one of the two always
-- fully commits or rolls back before the other's guard check or business
-- read even begins - see each function's own comment below, and the
-- CONCURRENCY PROOF in this change's own review notes. This same lock also
-- serializes the 3 business RPCs against each other (a deliberate,
-- accepted V1 trade-off - see election_day_apply_initial_allocation's
-- comment for the reasoning) - a single hashtext key, chosen the same way
-- and documented the same way as this codebase's one pre-existing precedent
-- for this pattern, election_day_create_non_voting_reason's
-- pg_advisory_xact_lock(hashtext('election_day_manage_non_voting_reasons')::bigint)
-- (see 20260806180000). election_day_manage_coordinators (part A) does NOT
-- take this lock: it never reads or writes election_day_voters at all
-- (only election_day_coordinators, via row-level FOR UPDATE locks that
-- already serialize it against these 3 business RPCs' own coordinator-row
-- locks), so it cannot race the import/allocation domain this lock exists
-- to protect - adding it there would only add unnecessary contention.
begin;

-- ============================================================================
-- 1. election_day_voter_is_remaining - SQL mirror of resolveFollowUpStatus's
-- "remaining" branch (see src/features/election-day/followUpStatus.ts):
-- voted must be false, and if a not_voting_reason_id is set, it must either
-- be unresolvable (deleted reason - fails open to "remaining", same as the
-- frontend) or resolve to requires_follow_up <> false. security definer so
-- it can read the RLS-enabled-zero-policy election_day_not_voting_reasons
-- table (same reasoning as election_day_set_non_voting_reason's own fix -
-- see 20260810130000).
-- ============================================================================
create or replace function public.election_day_voter_is_remaining(p_voted boolean, p_not_voting_reason_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select p_voted = false and (
    p_not_voting_reason_id is null
    or coalesce(
      (select r.requires_follow_up from public.election_day_not_voting_reasons r where r.id = p_not_voting_reason_id),
      true
    ) <> false
  );
$$;

comment on function public.election_day_voter_is_remaining(boolean, uuid) is
  'Coordinator Allocation Management: SQL mirror of resolveFollowUpStatus''s "remaining" branch (voted=false AND not case-closed). Single source of truth for rebalance/coordinator-end voter eligibility - never re-implemented inline, so it cannot drift from the frontend''s own logic or between the two RPCs that use it.';

revoke all on function public.election_day_voter_is_remaining(boolean, uuid) from public, anon, authenticated;
grant execute on function public.election_day_voter_is_remaining(boolean, uuid) to anon, authenticated;

-- ============================================================================
-- 2. election_day_apply_initial_allocation
--
-- p_assignments: jsonb array of {"coordinator_id": "<uuid>", "quantity": <int >= 0>}.
-- Scope is fixed: every voter with coordinator IS NULL right now, and
-- nothing else - already-assigned (including Excel-assigned) voters are
-- never touched. Client sends only quantities, never voter ids - the server
-- is the sole source of truth for which voters actually get allocated.
--
-- Zero-unassigned handling (locked product decision, Phase 3 spec section
-- 12): if there is no unassigned voter at all, this RPC does NOT create a
-- placeholder operation row whose only purpose would be tripping the
-- Phase 2 re-import guard - it raises NO_UNASSIGNED_VOTERS and writes
-- nothing. This is a deliberate asymmetry versus coordinator_end below,
-- which DOES always record an operation row (including zero items) - end
-- has an inherent subject (the coordinator that ended) worth recording even
-- with nothing to move; initial_allocation with nothing to allocate has no
-- such subject and is simply a no-op.
--
-- Why the global advisory lock (see this file's header comment) is also
-- allowed to serialize the 3 business RPCs against EACH OTHER, not just
-- against import: a real concurrent Initial Allocation vs. Rebalance vs.
-- Coordinator End race is possible to defend against with finer-grained
-- locking (each already takes its own coordinator/voter row locks), but
-- doing so correctly - especially the cross-column ownership invariant
-- interacting with a concurrent rebalance - adds meaningful complexity for
-- a V1 scope that is one Election Day, on the order of ~2,000 voters,
-- administered by a small number of managers who are not expected to issue
-- two allocation-changing mutations at the exact same instant. Accepting
-- full serialization here trades a small amount of admin-mutation
-- parallelism (a second manager's allocation call simply waits briefly
-- for the first's transaction to finish, rather than running concurrently)
-- for materially simpler, more obviously correct locking - the explicit
-- trade-off requested and approved for this hardening pass.
-- ============================================================================
create or replace function public.election_day_apply_initial_allocation(
  p_actor_id uuid,
  p_actor_password text,
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
  v_actor_password_hash text;
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
  -- Re-auth + permission (see part A for the shared pattern).
  select u.password_hash, u.role_id, u.name
    into v_actor_password_hash, v_actor_role_id, v_actor_name
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

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

  -- Global Election Day import/allocation mutation lock - see this file's
  -- header comment. Blocks until any in-flight import or other business
  -- mutation (initial allocation / rebalance / coordinator end) has fully
  -- committed or rolled back; released automatically at this
  -- transaction's own commit/rollback. Acquired after all pure input-shape
  -- validation above (which touches no table), and before any read/lock of
  -- coordinator or voter business state below.
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
  -- their row locks (SELECT ... FOR UPDATE cannot be combined with
  -- aggregates, hence the separate plain SELECT) - this array becomes the
  -- sole source of truth for the mapping/update/audit below, never
  -- re-derived from the mutable `coordinator IS NULL` predicate again.
  -- Safe from a race even before considering the advisory lock above: no
  -- other transaction can be mutating election_day_voters right now, since
  -- import and every other business RPC hold the same lock for their own
  -- entire critical section.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', p_actor_id, v_actor_name, null, null)
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

comment on function public.election_day_apply_initial_allocation(uuid, text, jsonb) is
  'Coordinator Allocation Management: one-time distribution of every currently-unassigned voter (coordinator IS NULL) across the given active coordinators, by quantity only (server chooses voters, created_at/id ascending). Re-auth + electionDay.manageCoordinatorAllocation required. Acquires the global election_day_voter_allocation_mutation advisory lock before touching any coordinator/voter state, serializing this call against election_day_import_voters and the other 2 business RPCs. Locks coordinators then voters (ascending order), re-validates SUM(quantities) = COUNT(locked unassigned voters) post-lock (ALLOCATION_COUNT_MISMATCH on a stale client preview), then captures the exact locked voter id set - every downstream mapping/update/audit step is pinned to that id array, never re-derived from the mutable coordinator IS NULL predicate. Raises NO_UNASSIGNED_VOTERS instead of writing a placeholder operation when there is nothing to allocate. Records one initial_allocation operation + one operation_item per voter moved, all in this function''s own transaction.';

revoke all on function public.election_day_apply_initial_allocation(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_apply_initial_allocation(uuid, text, jsonb) to anon, authenticated;

-- ============================================================================
-- 3. election_day_rebalance_assignments
--
-- p_sources / p_destinations: jsonb arrays of {"coordinator_id": "<uuid>",
-- "quantity": <int > 0>}. A source coordinator's eligible voters are those
-- whose election_day_voters.coordinator equals its display_name OR (if
-- linked) its linked_assignment_name, and are still "remaining" per
-- election_day_voter_is_remaining above. Ride/reminder/call-attempt/notes
-- state is never touched - only the coordinator column moves.
-- ============================================================================
create or replace function public.election_day_rebalance_assignments(
  p_actor_id uuid,
  p_actor_password text,
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
  v_actor_password_hash text;
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
  -- Re-auth + permission.
  select u.password_hash, u.role_id, u.name
    into v_actor_password_hash, v_actor_role_id, v_actor_name
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

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

  -- Global Election Day import/allocation mutation lock - see this file's
  -- header comment. Acquired after all pure input-shape validation above,
  -- before any read/lock of coordinator or voter business state below.
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
  -- predicate) is the sole source of truth for every step below: the
  -- per-source recount, the transfer mapping, the final UPDATE, and the
  -- audit items. Safe from a race regardless, thanks to the advisory lock
  -- above: no import or other business RPC can be mutating
  -- election_day_voters concurrently.
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
  values ('rebalance', p_actor_id, v_actor_name, null, null)
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

comment on function public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb) is
  'Coordinator Allocation Management: mid-day transfer of "remaining" voters (election_day_voter_is_remaining) from source coordinators to destination coordinators, by quantity only - server chooses voters (created_at/id ascending per source, mapped deterministically to destination ranges in array order). Re-auth + electionDay.manageCoordinatorAllocation required. Acquires the global election_day_voter_allocation_mutation advisory lock before touching any coordinator/voter state, serializing this call against election_day_import_voters and the other 2 business RPCs. SUM(sources) must equal SUM(destinations); a coordinator cannot be both a source and a destination in the same call (SOURCE_DESTINATION_OVERLAP). Locks all referenced coordinators then all eligible voters (ascending order), captures the exact locked voter id set, then re-validates each source''s requested quantity against its true post-lock eligible count restricted to that id set (REBALANCE_SOURCE_INSUFFICIENT on a stale preview). Every downstream mapping/update/audit step is pinned to the captured id set, never a live re-match of the coordinator/remaining predicate. A source''s eligible set includes voters matched by either its display_name or its linked_assignment_name.';

revoke all on function public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb) to anon, authenticated;

-- ============================================================================
-- 4. election_day_end_coordinator_activity
--
-- p_mode = 'transfer': every "remaining" voter of p_coordinator_id moves to
-- the single active p_target_coordinator_id (required, must not be the
-- source).
-- p_mode = 'equal_split': every "remaining" voter of p_coordinator_id is
-- split as evenly as possible across every OTHER currently active
-- coordinator (ordered by id; any remainder goes to the earliest-ordered
-- destinations first). p_target_coordinator_id is ignored in this mode.
-- If there are 0 other active coordinators and the source still has
-- remaining voters, the call is rejected (LAST_ACTIVE_COORDINATOR) - but a
-- source with 0 remaining voters may always end, even as the last active
-- coordinator.
--
-- The source coordinator is always marked status = 'ended' on success
-- (never deleted). A coordinator_end operation row is ALWAYS written on
-- success, naming the source as subject_coordinator - even when 0 voters
-- moved - so "who ended, when, and who performed it" is always recoverable
-- (deliberately the opposite default from initial_allocation''s "raise
-- instead of writing a placeholder" - end always has a real subject).
-- ============================================================================
create or replace function public.election_day_end_coordinator_activity(
  p_actor_id uuid,
  p_actor_password text,
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
  v_actor_password_hash text;
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
  -- Re-auth + permission.
  select u.password_hash, u.role_id, u.name
    into v_actor_password_hash, v_actor_role_id, v_actor_name
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

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

  -- Global Election Day import/allocation mutation lock - see this file's
  -- header comment. Acquired after all pure input-shape validation above,
  -- before any read/lock of coordinator or voter business state below.
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
  values ('coordinator_end', p_actor_id, v_actor_name, p_coordinator_id, v_source_display_name)
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

comment on function public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid) is
  'Coordinator Allocation Management: ends one active coordinator''s activity. Re-auth + electionDay.manageCoordinatorAllocation required. Acquires the global election_day_voter_allocation_mutation advisory lock before touching any coordinator/voter state, serializing this call against election_day_import_voters and the other 2 business RPCs. mode=transfer moves every "remaining" voter (election_day_voter_is_remaining) to one required, active, non-self target. mode=equal_split splits them as evenly as possible (remainder to earliest-id destinations) across every other active coordinator - rejected with LAST_ACTIVE_COORDINATOR only if there ARE remaining voters and no other active coordinator exists; a source with 0 remaining voters may always end. Captures the exact locked remaining-voter id set once, then pins the transfer/equal_split move and its audit items to that id set, never a live re-match of the coordinator/remaining predicate. Always writes a coordinator_end operation naming the source as subject, even with 0 items moved. Sets the source''s status to ended (ended_at = now()) on success - never deletes it.';

revoke all on function public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid);
--   drop function if exists public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb);
--   drop function if exists public.election_day_apply_initial_allocation(uuid, text, jsonb);
--   drop function if exists public.election_day_voter_is_remaining(boolean, uuid);
--   commit;
-- ============================================================================
