-- Multi-Tenant Phase 3 - Import/Clear Voter File domain (final Phase 3
-- workstream: Users -> Roles -> Coordinator/Allocation -> Import/Clear).
--
-- This migration is a single combined Backend EXPAND covering:
--   A. Durable coordinator-operation workspace attribution (a direct
--      dependency of Import's own workspace-scoped allocation-activity
--      guard - see this project's own design-closure record for the full
--      reasoning): historical backfill of the 3 existing Production
--      operation rows (evidence-gated, fails closed on any ambiguity,
--      never guesses), workspace_id attribution added to all 3 v3
--      Coordinator/Allocation operation-writing CORE functions, and to the
--      3 legacy _v2 operation-writing functions (defense-in-depth so a
--      temporary rollback to _v2 cannot recreate NULL historical workspace
--      attribution while Import v3 depends on the invariant).
--   B. A shared, internal, non-client-executable voter-domain Clear core.
--   C. A workspace-aware Coordinator-sync helper (new, additive - the
--      legacy global sync helper is left completely unchanged).
--   D. Import V3: one shared core + PermissionUser wrapper + Owner wrapper.
--   E. Clear V3: one shared core + PermissionUser wrapper + Owner wrapper.
--
-- Explicitly NOT in this migration: RLS changes, NOT NULL changes,
-- unique-index changes, new tables, unrelated backfills, any frontend
-- change. `_v2` Import (election_day_import_voters_v2) and the legacy raw
-- frontend Clear path (SupabaseElectionDayApi.clearElectionDayVoters, a
-- plain PostgREST delete) are both left completely untouched by this
-- migration - this is backend EXPAND only, no cutover.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction. The historical backfill's own safety guarantee (fail the
-- whole migration rather than guess) depends on this: a RAISE EXCEPTION
-- anywhere in this file aborts and rolls back the entire migration,
-- including every CREATE OR REPLACE below it.
begin;

-- ============================================================================
-- A.1 HISTORICAL OPERATION/ITEM WORKSPACE BACKFILL - evidence-gated,
-- idempotent, never guesses.
--
-- For every election_day_coordinator_operations row whose workspace_id is
-- still NULL, derives the set of trustworthy workspace candidates purely
-- from surviving relational evidence:
--   - its own subject_coordinator_id's current workspace_id (coordinator_end
--     rows always have this; initial_allocation/rebalance never do), UNION
--   - every one of its operation_items' to_coordinator_id/from_coordinator_id
--     current workspace_id (covers initial_allocation/rebalance, which have
--     no single subject; also corroborates coordinator_end).
-- Requires EXACTLY ONE distinct non-null workspace across that combined
-- evidence set - RAISES (aborting this entire migration, per the header
-- comment above) on zero candidates or more than one distinct candidate,
-- rather than ever assigning a workspace by guessing.
--
-- Idempotent: only rows with workspace_id IS NULL are ever considered, so a
-- second application of this same migration text (re-run against a database
-- where it already succeeded) finds nothing left to do and is a no-op -
-- required since `supabase db push`/migration replay conventions in this
-- project treat a migration file as potentially re-evaluated.
--
-- Does not insert or delete any operation/operation_item row - UPDATE only.
-- election_day_coordinator_operation_items.workspace_id is set FROM ITS
-- OWN PARENT OPERATION's now-established workspace_id (never re-derived
-- independently), so an item can never disagree with its own parent.
do $$
declare
  v_op record;
  v_candidates uuid[];
  v_before_ops_count bigint;
  v_before_items_count bigint;
  v_after_ops_count bigint;
  v_after_items_count bigint;
begin
  select count(*) into v_before_ops_count from public.election_day_coordinator_operations;
  select count(*) into v_before_items_count from public.election_day_coordinator_operation_items;

  for v_op in
    select o.id from public.election_day_coordinator_operations o
    where o.workspace_id is null
  loop
    select array_agg(distinct ws) into v_candidates
    from (
      select c.workspace_id as ws
      from public.election_day_coordinator_operations o
      join public.election_day_coordinators c on c.id = o.subject_coordinator_id
      where o.id = v_op.id and c.workspace_id is not null
      union
      select c.workspace_id as ws
      from public.election_day_coordinator_operation_items i
      join public.election_day_coordinators c
        on c.id in (i.to_coordinator_id, i.from_coordinator_id)
      where i.operation_id = v_op.id and c.workspace_id is not null
    ) evidence;

    if v_candidates is null or array_length(v_candidates, 1) = 0 then
      raise exception 'IMPORT_CLEAR_BACKFILL_AMBIGUOUS: operation % has zero attributable workspace candidates - refusing to guess.', v_op.id;
    end if;

    if array_length(v_candidates, 1) > 1 then
      raise exception 'IMPORT_CLEAR_BACKFILL_AMBIGUOUS: operation % resolves to % distinct workspaces (%) - refusing to guess.', v_op.id, array_length(v_candidates, 1), v_candidates;
    end if;

    update public.election_day_coordinator_operations
      set workspace_id = v_candidates[1]
      where id = v_op.id;

    update public.election_day_coordinator_operation_items
      set workspace_id = v_candidates[1]
      where operation_id = v_op.id;
  end loop;

  select count(*) into v_after_ops_count from public.election_day_coordinator_operations;
  select count(*) into v_after_items_count from public.election_day_coordinator_operation_items;

  if v_after_ops_count <> v_before_ops_count then
    raise exception 'IMPORT_CLEAR_BACKFILL_INVARIANT_VIOLATED: operations row count changed (% -> %) - this backfill must only UPDATE.', v_before_ops_count, v_after_ops_count;
  end if;

  if v_after_items_count <> v_before_items_count then
    raise exception 'IMPORT_CLEAR_BACKFILL_INVARIANT_VIOLATED: operation_items row count changed (% -> %) - this backfill must only UPDATE.', v_before_items_count, v_after_items_count;
  end if;
end;
$$;

-- ============================================================================
-- A.2 v3 CORE operation-writer workspace attribution - CREATE OR REPLACE,
-- byte-identical to the live 20260829030000 definitions except that every
-- INSERT INTO election_day_coordinator_operations / _operation_items now
-- additionally writes workspace_id = the already-trusted p_workspace_id
-- already resolved/validated earlier in each function body (zero new
-- derivation, zero new parameter, zero signature/business-logic/
-- permission-logic/locking/return-contract change).
-- ============================================================================
create or replace function public.election_day_apply_initial_allocation_core(
  p_workspace_id uuid,
  p_assignments jsonb,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
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
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

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

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct (elem->>'coordinator_id')::uuid order by (elem->>'coordinator_id')::uuid)
    into v_lock_ids
  from jsonb_array_elements(p_assignments) elem;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = p_workspace_id
  order by id
  for update;
  get diagnostics v_locked_coordinator_count = row_count;

  if v_locked_coordinator_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = p_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  perform 1
  from public.election_day_voters
  where coordinator is null
    and workspace_id = p_workspace_id
  order by created_at asc, id asc
  for update;
  get diagnostics v_unassigned_count = row_count;

  if v_unassigned_count = 0 then
    raise exception 'NO_UNASSIGNED_VOTERS';
  end if;

  if v_sum_quantities <> v_unassigned_count then
    raise exception 'ALLOCATION_COUNT_MISMATCH';
  end if;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null
    and workspace_id = p_workspace_id;

  insert into public.election_day_coordinator_operations
    (operation_type, workspace_id, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', p_workspace_id, p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, null, null)
  returning id into v_operation_id;

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
    join public.election_day_coordinators c
      on c.id = am.coordinator_id and c.workspace_id = p_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.coordinator_id, c.display_name as coordinator_display_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, p_workspace_id, u.id, u.full_name, null, null, u.coordinator_id, u.coordinator_display_name
  from updated u;

  return query select v_operation_id, v_unassigned_count, 0;
end;
$$;

comment on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3 (unchanged business logic) + Phase 3 Import/Clear durable workspace attribution (20260829050000): every election_day_coordinator_operations/_operation_items row this core writes now carries workspace_id = the already-trusted p_workspace_id, so a future workspace-scoped allocation-activity guard needs no join through coordinators. No signature/business-logic/permission-logic/locking/return-contract change.';

revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from public;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from anon;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_apply_initial_allocation_core(uuid, jsonb, uuid, uuid, text) from service_role;

create or replace function public.election_day_rebalance_assignments_core(
  p_workspace_id uuid,
  p_sources jsonb,
  p_destinations jsonb,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
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
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

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

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct x.id order by x.id) into v_lock_ids
  from (
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_sources) elem
    union
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_destinations) elem
  ) x;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = p_workspace_id
  order by id
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = p_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  select array_agg(distinct name) into v_source_names
  from (
    select c.display_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
    union
    select c.linked_assignment_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
    where c.linked_assignment_name is not null
  ) names;

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if exists (
    select 1
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = p_workspace_id
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
    (operation_type, workspace_id, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('rebalance', p_workspace_id, p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, null, null)
  returning id into v_operation_id;

  with source_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, src_ord
    from jsonb_array_elements(p_sources) with ordinality as t(elem, src_ord)
  ),
  source_names as (
    select sm.coordinator_id, sm.quantity, sm.src_ord, c.display_name,
      array_remove(array[c.display_name, c.linked_assignment_name], null) as names
    from source_map sm
    join public.election_day_coordinators c
      on c.id = sm.coordinator_id and c.workspace_id = p_workspace_id
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
    join public.election_day_coordinators dc
      on dc.id = am.dest_id and dc.workspace_id = p_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.source_id, am.source_display_name, dc.id as to_id, dc.display_name as to_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, p_workspace_id, u.id, u.full_name, u.source_id, u.source_display_name, u.to_id, u.to_name
  from updated u;

  get diagnostics v_transferred_count = row_count;

  return query select v_operation_id, v_transferred_count;
end;
$$;

comment on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3 (unchanged business logic) + Phase 3 Import/Clear durable workspace attribution (20260829050000): operation/operation_item writes now carry workspace_id = p_workspace_id. No other change.';

revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from public;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from anon;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_rebalance_assignments_core(uuid, jsonb, jsonb, uuid, uuid, text) from service_role;

create or replace function public.election_day_end_coordinator_activity_core(
  p_workspace_id uuid,
  p_coordinator_id uuid,
  p_mode text,
  p_target_coordinator_id uuid,
  p_executed_by_id uuid,
  p_executed_by_owner_id_snapshot uuid,
  p_executed_by_name text
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
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_mode not in ('transfer', 'equal_split') then
    raise exception 'INVALID_MODE';
  end if;

  if p_mode = 'transfer' and (p_target_coordinator_id is null or p_target_coordinator_id = p_coordinator_id) then
    raise exception 'INVALID_TARGET';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if p_mode = 'transfer' then
    perform 1 from public.election_day_coordinators
    where id = any(array[p_coordinator_id, p_target_coordinator_id]::uuid[])
      and workspace_id = p_workspace_id
    order by id
    for update;
  else
    perform 1 from public.election_day_coordinators
    where id = p_coordinator_id
      and workspace_id = p_workspace_id
    for update;
  end if;

  select display_name, linked_assignment_name into v_source_display_name, v_source_linked_name
  from public.election_day_coordinators
  where id = p_coordinator_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if (
    select status from public.election_day_coordinators
    where id = p_coordinator_id and workspace_id = p_workspace_id
  ) <> 'active' then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  if p_mode = 'transfer' then
    select display_name into v_target_display_name
    from public.election_day_coordinators
    where id = p_target_coordinator_id
      and workspace_id = p_workspace_id;

    if not found then
      raise exception 'TARGET_NOT_FOUND';
    end if;

    if (
      select status from public.election_day_coordinators
      where id = p_target_coordinator_id and workspace_id = p_workspace_id
    ) <> 'active' then
      raise exception 'TARGET_NOT_ACTIVE';
    end if;
  end if;

  v_source_names := array_remove(array[v_source_display_name, v_source_linked_name], null);

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;
  get diagnostics v_remaining_count = row_count;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = p_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if p_mode = 'equal_split' then
    perform 1 from public.election_day_coordinators
    where status = 'active' and id <> p_coordinator_id
      and workspace_id = p_workspace_id
    order by id
    for update;
    get diagnostics v_destinations_count = row_count;

    if v_remaining_count > 0 and v_destinations_count = 0 then
      raise exception 'LAST_ACTIVE_COORDINATOR';
    end if;
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, workspace_id, executed_by_id, executed_by_owner_id_snapshot, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('coordinator_end', p_workspace_id, p_executed_by_id, p_executed_by_owner_id_snapshot, p_executed_by_name, p_coordinator_id, v_source_display_name)
  returning id into v_operation_id;

  if v_remaining_count > 0 and p_mode = 'transfer' then
    with moved as (
      update public.election_day_voters v
      set coordinator = v_target_display_name
      where v.id = any(v_locked_voter_ids)
      returning v.id, v.first_name || ' ' || v.last_name as full_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, p_workspace_id, m.id, m.full_name, p_coordinator_id, v_source_display_name, p_target_coordinator_id, v_target_display_name
    from moved m;

    v_moved_count := v_remaining_count;

  elsif v_remaining_count > 0 and p_mode = 'equal_split' then
    with destinations_ordered as (
      select id, display_name,
        (row_number() over (order by id asc) - 1)::integer as idx
      from public.election_day_coordinators
      where status = 'active' and id <> p_coordinator_id
        and workspace_id = p_workspace_id
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
      (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, p_workspace_id, u.id, u.full_name, p_coordinator_id, v_source_display_name, u.dest_id, u.dest_name
    from updated u;

    v_moved_count := v_remaining_count;
  end if;

  update public.election_day_coordinators
  set status = 'ended', ended_at = now()
  where id = p_coordinator_id
    and workspace_id = p_workspace_id;

  return query select v_operation_id, v_moved_count, p_coordinator_id, v_source_display_name;
end;
$$;

comment on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) is
  'Phase 3C Dual-Principal V3 (unchanged business logic) + Phase 3 Import/Clear durable workspace attribution (20260829050000): operation/operation_item writes now carry workspace_id = p_workspace_id. No other change.';

revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from public;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from anon;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from authenticated;
revoke all on function public.election_day_end_coordinator_activity_core(uuid, uuid, text, uuid, uuid, uuid, text) from service_role;

-- ============================================================================
-- A.3 LEGACY _v2 operation-writer workspace attribution - defense-in-depth
-- ONLY (see this migration's header). Byte-identical to the live
-- 20260829020000 definitions except that every INSERT INTO election_day_
-- coordinator_operations / _operation_items now additionally writes
-- workspace_id = the already-resolved v_actor_workspace_id (already derived
-- and ACTOR_WORKSPACE_REQUIRED-guarded earlier in each function body). No
-- other change: same signature, same proof mechanism (legacy
-- election_day_verify_reauth_proof), same permission check, same locking,
-- same business logic, same return contract, same grants.
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
  v_actor_workspace_id uuid;
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
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

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

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct (elem->>'coordinator_id')::uuid order by (elem->>'coordinator_id')::uuid)
    into v_lock_ids
  from jsonb_array_elements(p_assignments) elem;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = v_actor_workspace_id
  order by id
  for update;
  get diagnostics v_locked_coordinator_count = row_count;

  if v_locked_coordinator_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = v_actor_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  perform 1
  from public.election_day_voters
  where coordinator is null
    and workspace_id = v_actor_workspace_id
  order by created_at asc, id asc
  for update;
  get diagnostics v_unassigned_count = row_count;

  if v_unassigned_count = 0 then
    raise exception 'NO_UNASSIGNED_VOTERS';
  end if;

  if v_sum_quantities <> v_unassigned_count then
    raise exception 'ALLOCATION_COUNT_MISMATCH';
  end if;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null
    and workspace_id = v_actor_workspace_id;

  insert into public.election_day_coordinator_operations
    (operation_type, workspace_id, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', v_actor_workspace_id, v_actor_id, v_actor_name, null, null)
  returning id into v_operation_id;

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
    join public.election_day_coordinators c
      on c.id = am.coordinator_id and c.workspace_id = v_actor_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.coordinator_id, c.display_name as coordinator_display_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, v_actor_workspace_id, u.id, u.full_name, null, null, u.coordinator_id, u.coordinator_display_name
  from updated u;

  return query select v_operation_id, v_unassigned_count, 0;
end;
$$;

comment on function public.election_day_apply_initial_allocation_v2(text, jsonb) is
  'Phase 3C containment (unchanged business logic) + Phase 3 Import/Clear defense-in-depth workspace attribution (20260829050000): operation/operation_item writes now carry workspace_id = v_actor_workspace_id (already resolved/guarded earlier in this same function). Purely so a temporary rollback to _v2 cannot recreate NULL historical workspace attribution while Import v3''s allocation-activity guard depends on the invariant. No other change - same signature/proof mechanism/permission/locking/business-logic/grants.';

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
  v_actor_workspace_id uuid;
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
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

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

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  select array_agg(distinct x.id order by x.id) into v_lock_ids
  from (
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_sources) elem
    union
    select (elem->>'coordinator_id')::uuid as id from jsonb_array_elements(p_destinations) elem
  ) x;

  perform 1 from public.election_day_coordinators
  where id = any(v_lock_ids)
    and workspace_id = v_actor_workspace_id
  order by id
  for update;
  get diagnostics v_locked_count = row_count;

  if v_locked_count <> array_length(v_lock_ids, 1) then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.election_day_coordinators
    where id = any(v_lock_ids) and workspace_id = v_actor_workspace_id and status <> 'active'
  ) then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  select array_agg(distinct name) into v_source_names
  from (
    select c.display_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = v_actor_workspace_id
    union
    select c.linked_assignment_name as name
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = v_actor_workspace_id
    where c.linked_assignment_name is not null
  ) names;

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if exists (
    select 1
    from jsonb_array_elements(p_sources) elem
    join public.election_day_coordinators c
      on c.id = (elem->>'coordinator_id')::uuid and c.workspace_id = v_actor_workspace_id
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
    (operation_type, workspace_id, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('rebalance', v_actor_workspace_id, v_actor_id, v_actor_name, null, null)
  returning id into v_operation_id;

  with source_map as (
    select (elem->>'coordinator_id')::uuid as coordinator_id, (elem->>'quantity')::integer as quantity, src_ord
    from jsonb_array_elements(p_sources) with ordinality as t(elem, src_ord)
  ),
  source_names as (
    select sm.coordinator_id, sm.quantity, sm.src_ord, c.display_name,
      array_remove(array[c.display_name, c.linked_assignment_name], null) as names
    from source_map sm
    join public.election_day_coordinators c
      on c.id = sm.coordinator_id and c.workspace_id = v_actor_workspace_id
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
    join public.election_day_coordinators dc
      on dc.id = am.dest_id and dc.workspace_id = v_actor_workspace_id
    where v.id = am.voter_id
    returning v.id, am.full_name, am.source_id, am.source_display_name, dc.id as to_id, dc.display_name as to_name
  )
  insert into public.election_day_coordinator_operation_items
    (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, v_actor_workspace_id, u.id, u.full_name, u.source_id, u.source_display_name, u.to_id, u.to_name
  from updated u;

  get diagnostics v_transferred_count = row_count;

  return query select v_operation_id, v_transferred_count;
end;
$$;

comment on function public.election_day_rebalance_assignments_v2(text, jsonb, jsonb) is
  'Phase 3C containment (unchanged business logic) + Phase 3 Import/Clear defense-in-depth workspace attribution (20260829050000): operation/operation_item writes now carry workspace_id = v_actor_workspace_id. No other change.';

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
  v_actor_workspace_id uuid;
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
  select v.actor_id, v.actor_name, v.role_id
    into v_actor_id, v_actor_name, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_mode not in ('transfer', 'equal_split') then
    raise exception 'INVALID_MODE';
  end if;

  if p_mode = 'transfer' and (p_target_coordinator_id is null or p_target_coordinator_id = p_coordinator_id) then
    raise exception 'INVALID_TARGET';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if p_mode = 'transfer' then
    perform 1 from public.election_day_coordinators
    where id = any(array[p_coordinator_id, p_target_coordinator_id]::uuid[])
      and workspace_id = v_actor_workspace_id
    order by id
    for update;
  else
    perform 1 from public.election_day_coordinators
    where id = p_coordinator_id
      and workspace_id = v_actor_workspace_id
    for update;
  end if;

  select display_name, linked_assignment_name into v_source_display_name, v_source_linked_name
  from public.election_day_coordinators
  where id = p_coordinator_id
    and workspace_id = v_actor_workspace_id;

  if not found then
    raise exception 'COORDINATOR_NOT_FOUND';
  end if;

  if (
    select status from public.election_day_coordinators
    where id = p_coordinator_id and workspace_id = v_actor_workspace_id
  ) <> 'active' then
    raise exception 'COORDINATOR_NOT_ACTIVE';
  end if;

  if p_mode = 'transfer' then
    select display_name into v_target_display_name
    from public.election_day_coordinators
    where id = p_target_coordinator_id
      and workspace_id = v_actor_workspace_id;

    if not found then
      raise exception 'TARGET_NOT_FOUND';
    end if;

    if (
      select status from public.election_day_coordinators
      where id = p_target_coordinator_id and workspace_id = v_actor_workspace_id
    ) <> 'active' then
      raise exception 'TARGET_NOT_ACTIVE';
    end if;
  end if;

  v_source_names := array_remove(array[v_source_display_name, v_source_linked_name], null);

  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;
  get diagnostics v_remaining_count = row_count;

  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if p_mode = 'equal_split' then
    perform 1 from public.election_day_coordinators
    where status = 'active' and id <> p_coordinator_id
      and workspace_id = v_actor_workspace_id
    order by id
    for update;
    get diagnostics v_destinations_count = row_count;

    if v_remaining_count > 0 and v_destinations_count = 0 then
      raise exception 'LAST_ACTIVE_COORDINATOR';
    end if;
  end if;

  insert into public.election_day_coordinator_operations
    (operation_type, workspace_id, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('coordinator_end', v_actor_workspace_id, v_actor_id, v_actor_name, p_coordinator_id, v_source_display_name)
  returning id into v_operation_id;

  if v_remaining_count > 0 and p_mode = 'transfer' then
    with moved as (
      update public.election_day_voters v
      set coordinator = v_target_display_name
      where v.id = any(v_locked_voter_ids)
      returning v.id, v.first_name || ' ' || v.last_name as full_name
    )
    insert into public.election_day_coordinator_operation_items
      (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, v_actor_workspace_id, m.id, m.full_name, p_coordinator_id, v_source_display_name, p_target_coordinator_id, v_target_display_name
    from moved m;

    v_moved_count := v_remaining_count;

  elsif v_remaining_count > 0 and p_mode = 'equal_split' then
    with destinations_ordered as (
      select id, display_name,
        (row_number() over (order by id asc) - 1)::integer as idx
      from public.election_day_coordinators
      where status = 'active' and id <> p_coordinator_id
        and workspace_id = v_actor_workspace_id
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
      (operation_id, workspace_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, v_actor_workspace_id, u.id, u.full_name, p_coordinator_id, v_source_display_name, u.dest_id, u.dest_name
    from updated u;

    v_moved_count := v_remaining_count;
  end if;

  update public.election_day_coordinators
  set status = 'ended', ended_at = now()
  where id = p_coordinator_id
    and workspace_id = v_actor_workspace_id;

  return query select v_operation_id, v_moved_count, p_coordinator_id, v_source_display_name;
end;
$$;

comment on function public.election_day_end_coordinator_activity_v2(text, uuid, text, uuid) is
  'Phase 3C containment (unchanged business logic) + Phase 3 Import/Clear defense-in-depth workspace attribution (20260829050000): operation/operation_item writes now carry workspace_id = v_actor_workspace_id. No other change.';

-- Note: no `revoke`/`grant` statements accompany the 3 v2 CREATE OR REPLACE
-- blocks above - CREATE OR REPLACE FUNCTION never alters an existing
-- function's privileges (same precedent already relied upon by every prior
-- containment migration in this project), and these 3 functions' ACL is
-- already exactly `revoke all from public,anon,authenticated; grant execute
-- to anon,authenticated;` from 20260829020000 - unchanged by this migration.

-- ============================================================================
-- A.4 Workspace-aware allocation-activity guard - NEW, additive. Uses the
-- now-authoritative operation.workspace_id column directly - no join to
-- coordinators, so it remains correct even if a coordinator FK on a
-- historical row is later nulled by a coordinator deletion. The legacy
-- global election_day_has_allocation_activity() is left completely
-- unchanged and still used, unmodified, by every _v2 caller that already
-- calls it (election_day_import_voters_v2, election_day_manage_
-- coordinators_v2's edit/remove-adjacent legacy call sites if any remain).
-- ============================================================================
create or replace function public.election_day_has_allocation_activity_for_workspace(p_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.election_day_coordinator_operations o
    where o.workspace_id = p_workspace_id
  );
$$;

comment on function public.election_day_has_allocation_activity_for_workspace(uuid) is
  'Phase 3 Import/Clear: workspace-scoped allocation-activity guard for Import''s ALLOCATION_ACTIVITY_STARTED check. Filters the now-authoritative election_day_coordinator_operations.workspace_id column DIRECTLY - never a join through election_day_coordinators - so it remains correct independent of any future coordinator deletion nulling a historical FK. Internal-only: not reachable by anon/authenticated/service_role directly, only from inside another SECURITY DEFINER function body (matches election_day_import_voters_core''s own call site). Legacy election_day_has_allocation_activity() (global) is left completely unchanged.';

revoke all on function public.election_day_has_allocation_activity_for_workspace(uuid) from public;
revoke all on function public.election_day_has_allocation_activity_for_workspace(uuid) from anon;
revoke all on function public.election_day_has_allocation_activity_for_workspace(uuid) from authenticated;
revoke all on function public.election_day_has_allocation_activity_for_workspace(uuid) from service_role;

-- ============================================================================
-- B. Shared, internal, non-client-executable voter-domain Clear core.
-- Deletes only the trusted workspace's own election_day_voters rows;
-- election_day_ride_status_events and election_day_reminder_events are
-- workspace-scoped for free via their existing ON DELETE CASCADE FK to
-- election_day_voters (see this project's own Import/Clear design-closure
-- record for the FK inventory). Never touches election_day_coordinators or
-- election_day_coordinator_operations/_operation_items (audit history is
-- preserved exactly as today). No authorization logic of any kind - every
-- wrapper below must authenticate/authorize BEFORE calling this.
-- ============================================================================
create or replace function public.election_day_clear_voter_domain_for_workspace(p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  delete from public.election_day_voters
  where workspace_id = p_workspace_id;
  get diagnostics v_deleted_count = row_count;

  return v_deleted_count;
end;
$$;

comment on function public.election_day_clear_voter_domain_for_workspace(uuid) is
  'Phase 3 Import/Clear: shared, internal, non-client-executable core for the destructive voter-file clear operation. Deletes ONLY election_day_voters WHERE workspace_id = p_workspace_id - dependent election_day_ride_status_events/election_day_reminder_events are removed for free via their existing ON DELETE CASCADE FK to election_day_voters, correctly workspace-scoped because the cascade follows the deleted voter row itself, not a separate predicate. Never touches election_day_coordinators or any coordinator_operations/_operation_items audit row. Acquires the shared election_day_voter_allocation_mutation advisory lock (reentrant-safe if a caller, e.g. election_day_import_voters_core, already holds it in the same transaction). NO authorization logic - every caller must authenticate/authorize before invoking this. Not reachable by anon/authenticated/service_role directly.';

revoke all on function public.election_day_clear_voter_domain_for_workspace(uuid) from public;
revoke all on function public.election_day_clear_voter_domain_for_workspace(uuid) from anon;
revoke all on function public.election_day_clear_voter_domain_for_workspace(uuid) from authenticated;
revoke all on function public.election_day_clear_voter_domain_for_workspace(uuid) from service_role;

-- ============================================================================
-- C. Workspace-aware Coordinator sync - NEW, additive variant. The legacy
-- global election_day_sync_coordinators_from_voters() (20260820000000) is
-- left completely unchanged and remains election_day_import_voters_v2's
-- own sync helper, unmodified. Known, disclosed, Phase-4-deferred
-- limitation carried over unchanged from the legacy helper: the underlying
-- partial unique index on election_day_coordinators.display_name (WHERE
-- status = 'active') is GLOBAL, not per-workspace - the ON CONFLICT target
-- below is therefore intentionally unchanged (it must match the real
-- index), and a same-named ACTIVE coordinator already existing in a
-- DIFFERENT workspace can still cause this workspace-aware insert to
-- silently no-op via ON CONFLICT DO NOTHING for a genuinely new coordinator
-- in THIS workspace. Not fixed here - fixing the index itself is Phase 4
-- scope; local two-workspace verification of this migration uses distinct
-- coordinator display names per workspace specifically because of this.
-- ============================================================================
create or replace function public.election_day_sync_coordinators_from_voters_for_workspace(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  insert into public.election_day_coordinators (display_name, workspace_id)
  select distinct trimmed.name, p_workspace_id
  from (
    select btrim(v.coordinator) as name
    from public.election_day_voters v
    where v.coordinator is not null and btrim(v.coordinator) <> ''
      and v.workspace_id = p_workspace_id
  ) as trimmed
  where not exists (
    select 1 from public.election_day_coordinators c
    where (c.display_name = trimmed.name or c.linked_assignment_name = trimmed.name)
      and c.workspace_id = p_workspace_id
  )
  on conflict (display_name) where status = 'active' do nothing;
end;
$$;

comment on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) is
  'Phase 3 Import/Clear: workspace-aware variant of election_day_sync_coordinators_from_voters(), used only by election_day_import_voters_core. Inspects election_day_voters.coordinator values ONLY within p_workspace_id, and inserts new election_day_coordinators rows with workspace_id = p_workspace_id, deduped against existing coordinators in that SAME workspace. Known limitation, unchanged from the legacy global helper and explicitly deferred to Phase 4: the ON CONFLICT target (display_name) WHERE status = ''active'' matches a GLOBAL partial unique index, not a per-workspace one, so an identically-named active coordinator in a DIFFERENT workspace can still silently absorb this conflict target. The legacy election_day_sync_coordinators_from_voters() itself is completely unchanged by this migration. Internal-only.';

revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from public;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from anon;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from authenticated;
revoke all on function public.election_day_sync_coordinators_from_voters_for_workspace(uuid) from service_role;

-- ============================================================================
-- D. Import V3 - one shared core + PermissionUser wrapper + Owner wrapper.
-- ============================================================================
create or replace function public.election_day_import_voters_core(
  p_workspace_id uuid,
  p_voters jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if public.election_day_has_allocation_activity_for_workspace(p_workspace_id) then
    raise exception 'ALLOCATION_ACTIVITY_STARTED';
  end if;

  perform public.election_day_clear_voter_domain_for_workspace(p_workspace_id);

  insert into public.election_day_voters
    (masad, first_name, last_name, street, house_number, city, phone, coordinator, workspace_id)
  select
    coalesce(x.masad, ''),
    x.first_name,
    x.last_name,
    coalesce(x.street, ''),
    coalesce(x.house_number, 0),
    coalesce(x.city, ''),
    x.phone,
    x.coordinator,
    p_workspace_id
  from jsonb_to_recordset(p_voters) as x(
    masad text,
    first_name text,
    last_name text,
    street text,
    house_number integer,
    city text,
    phone text,
    coordinator text
  );

  get diagnostics v_count = row_count;

  perform public.election_day_sync_coordinators_from_voters_for_workspace(p_workspace_id);

  return v_count;
end;
$$;

comment on function public.election_day_import_voters_core(uuid, jsonb) is
  'Phase 3 Import/Clear: shared, internal, non-client-executable business core for the destructive Import/replace operation - workspace-scoped equivalent of election_day_import_voters_v2''s own body. Acquires the shared election_day_voter_allocation_mutation advisory lock, rejects with ALLOCATION_ACTIVITY_STARTED (same error code as _v2) if election_day_has_allocation_activity_for_workspace(p_workspace_id) is true, clears only the trusted workspace via election_day_clear_voter_domain_for_workspace, inserts every new voter with workspace_id = p_workspace_id, then runs the workspace-aware coordinator sync. Same integer imported-count return contract as election_day_import_voters_v2. NO authorization logic - every caller must authenticate/authorize before invoking this. Not reachable by anon/authenticated/service_role directly.';

revoke all on function public.election_day_import_voters_core(uuid, jsonb) from public;
revoke all on function public.election_day_import_voters_core(uuid, jsonb) from anon;
revoke all on function public.election_day_import_voters_core(uuid, jsonb) from authenticated;
revoke all on function public.election_day_import_voters_core(uuid, jsonb) from service_role;

create or replace function public.election_day_import_voters_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea,
  p_voters jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.role_id, v.workspace_id into v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'import_voters'
  ) v;

  select ('electionDay.import' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  return public.election_day_import_voters_core(v_workspace_id, p_voters);
end;
$$;

comment on function public.election_day_import_voters_v3(bytea, bytea, jsonb) is
  'Phase 3 Import/Clear: PermissionUser-authorized Import/replace. Trusted session + one-time-consumed action-bound proof (election_day_verify_and_consume_reauth_proof_v3, action=''import_voters''), then requires electionDay.import on the resolved actor''s CURRENT role, read live every call. Delegates all business logic to election_day_import_voters_core. service_role-only. NOT wired into the live frontend - election_day_import_voters_v2 remains the only reachable path until a separate, later, explicit frontend cutover.';

revoke all on function public.election_day_import_voters_v3(bytea, bytea, jsonb) from public;
revoke all on function public.election_day_import_voters_v3(bytea, bytea, jsonb) from anon;
revoke all on function public.election_day_import_voters_v3(bytea, bytea, jsonb) from authenticated;
grant execute on function public.election_day_import_voters_v3(bytea, bytea, jsonb) to service_role;

create or replace function public.election_day_import_voters_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea,
  p_voters jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select v.workspace_id into v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'import_voters'
  ) v;

  return public.election_day_import_voters_core(v_workspace_id, p_voters);
end;
$$;

comment on function public.election_day_import_voters_owner_v3(uuid, bytea, jsonb) is
  'Phase 3 Import/Clear: Owner-authorized Import/replace. One-time-consumed Owner proof (election_day_verify_and_consume_owner_proof, action=''import_voters''). Authorization is being a resolved Election Owner holding a valid proof for the target workspace - no PermissionUser role/permission of any kind is checked or relevant, per the approved architecture (Owner authority is intrinsic). Delegates to election_day_import_voters_core (the SAME shared core the PermissionUser wrapper uses). service_role-only. NOT wired into the live frontend - no Owner UI exists yet, matching the existing dormant Owner Coordinator/Allocation wrappers'' own precedent.';

revoke all on function public.election_day_import_voters_owner_v3(uuid, bytea, jsonb) from public;
revoke all on function public.election_day_import_voters_owner_v3(uuid, bytea, jsonb) from anon;
revoke all on function public.election_day_import_voters_owner_v3(uuid, bytea, jsonb) from authenticated;
grant execute on function public.election_day_import_voters_owner_v3(uuid, bytea, jsonb) to service_role;

-- ============================================================================
-- E. Clear Voters V3 - one shared core (B, above) + PermissionUser wrapper
-- + Owner wrapper. Return contract is `void`, matching the existing
-- frontend's current SupabaseElectionDayApi.clearElectionDayVoters(): Promise<void>
-- so a future cutover can wrap it into the same void/true-sentinel pattern
-- (useElectionDay.ts's clearElectionDayDataRaw) with zero contract change.
-- ============================================================================
create or replace function public.election_day_clear_voters_v3(
  p_session_hash bytea,
  p_reauth_proof_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_workspace_id uuid;
  v_has_permission boolean;
begin
  select v.role_id, v.workspace_id into v_actor_role_id, v_workspace_id
  from public.election_day_verify_and_consume_reauth_proof_v3(
    p_session_hash, p_reauth_proof_hash, 'clear_voters'
  ) v;

  select ('electionDay.clearData' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  perform public.election_day_clear_voter_domain_for_workspace(v_workspace_id);
end;
$$;

comment on function public.election_day_clear_voters_v3(bytea, bytea) is
  'Phase 3 Import/Clear: PermissionUser-authorized Clear/delete voter file. Trusted session + one-time-consumed action-bound proof (election_day_verify_and_consume_reauth_proof_v3, action=''clear_voters''), then requires electionDay.clearData on the resolved actor''s CURRENT role, read live every call - the first server-side enforcement of this permission (the legacy frontend path, SupabaseElectionDayApi.clearElectionDayVoters, is a raw unguarded PostgREST delete with zero reauth and zero workspace scope, left completely unchanged by this migration). Delegates to election_day_clear_voter_domain_for_workspace. service_role-only. NOT wired into the live frontend.';

revoke all on function public.election_day_clear_voters_v3(bytea, bytea) from public;
revoke all on function public.election_day_clear_voters_v3(bytea, bytea) from anon;
revoke all on function public.election_day_clear_voters_v3(bytea, bytea) from authenticated;
grant execute on function public.election_day_clear_voters_v3(bytea, bytea) to service_role;

create or replace function public.election_day_clear_voters_owner_v3(
  p_auth_user_id uuid,
  p_reauth_proof_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select v.workspace_id into v_workspace_id
  from public.election_day_verify_and_consume_owner_proof(
    p_auth_user_id, p_reauth_proof_hash, 'clear_voters'
  ) v;

  perform public.election_day_clear_voter_domain_for_workspace(v_workspace_id);
end;
$$;

comment on function public.election_day_clear_voters_owner_v3(uuid, bytea) is
  'Phase 3 Import/Clear: Owner-authorized Clear/delete voter file. One-time-consumed Owner proof (election_day_verify_and_consume_owner_proof, action=''clear_voters''). Intrinsic Owner authority - no PermissionUser role/permission checked. Delegates to election_day_clear_voter_domain_for_workspace (the SAME shared core the PermissionUser wrapper uses). service_role-only. NOT wired into the live frontend - no Owner UI exists yet.';

revoke all on function public.election_day_clear_voters_owner_v3(uuid, bytea) from public;
revoke all on function public.election_day_clear_voters_owner_v3(uuid, bytea) from anon;
revoke all on function public.election_day_clear_voters_owner_v3(uuid, bytea) from authenticated;
grant execute on function public.election_day_clear_voters_owner_v3(uuid, bytea) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this migration
-- needs to be reversed; Supabase CLI migrations have no automatic "down".
-- Note: this rollback restores the pre-migration FUNCTION BODIES for the 3
-- v3 cores and 3 v2 legacy functions from their last verified prior
-- definitions (20260829030000 / 20260829020000 respectively) and drops
-- every new function - it does NOT undo the historical operation/item
-- workspace_id backfill (A.1), which is a data change, not a function
-- change; reversing that would require a separate, explicit, manual
-- decision, same convention as every other backfill in this project):
--
--   begin;
--   drop function if exists public.election_day_clear_voters_owner_v3(uuid, bytea);
--   drop function if exists public.election_day_clear_voters_v3(bytea, bytea);
--   drop function if exists public.election_day_import_voters_owner_v3(uuid, bytea, jsonb);
--   drop function if exists public.election_day_import_voters_v3(bytea, bytea, jsonb);
--   drop function if exists public.election_day_import_voters_core(uuid, jsonb);
--   drop function if exists public.election_day_sync_coordinators_from_voters_for_workspace(uuid);
--   drop function if exists public.election_day_clear_voter_domain_for_workspace(uuid);
--   drop function if exists public.election_day_has_allocation_activity_for_workspace(uuid);
--   -- (then re-run the CREATE OR REPLACE bodies from 20260829020000/
--   -- 20260829030000 to restore the 3 v2 + 3 v3-core functions' pre-migration
--   -- bodies, i.e. without workspace_id in their operation/item INSERTs)
--   commit;
-- ============================================================================
