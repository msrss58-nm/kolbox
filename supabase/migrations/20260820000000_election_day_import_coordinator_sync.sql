-- Coordinator Allocation auto-preload (Option B, approved 2026-08-20 after a
-- rejected client-side auto-write-on-screen-open draft - see task-plan.md's
-- Progress Log / CURRENT_STATUS.md for the full history). `voter.coordinator`
-- - the free-text "אחראי" column set at Excel import time - is the
-- authoritative, pre-existing source of who's already responsible for whom.
-- Previously a manager had to retype every name by hand into "ניהול הקצאות"
-- even when it already existed verbatim in the just-imported voter file.
--
-- This migration:
--   1. Adds `election_day_sync_coordinators_from_voters()`, a private
--      SECURITY DEFINER helper (never directly callable by anon/authenticated
--      - mirrors `election_day_has_allocation_activity`/
--      `election_day_is_valid_permission`'s existing lockdown pattern) that
--      inserts one `election_day_coordinators` row per distinct, non-empty,
--      trimmed `election_day_voters.coordinator` value not already
--      represented by an existing coordinator's `display_name` OR
--      `linked_assignment_name`, in ANY status (active or ended). It is a
--      plain INSERT only - never an UPDATE/DELETE - so an ended coordinator
--      is never reactivated, an existing row is never overwritten, and a
--      name absent from current voter data is never removed (this function
--      only ever adds rows for names it can currently see in
--      `election_day_voters`; it has no "remove what's missing" logic at
--      all). Reads `election_day_voters` directly (not a parameter) so the
--      exact same function serves both call sites below with zero logic
--      duplication.
--   2. Calls this helper from inside `election_day_import_voters_v2`,
--      immediately after the existing atomic delete+insert and before
--      `return v_count` - same transaction, same advisory lock, same
--      `electionDay.import` permission check already in place; no new
--      RPC, no second frontend call, no second reauth prompt. Every other
--      line of the function (permission check, advisory lock, allocation-
--      activity guard, delete+insert semantics, return type) is byte-for-
--      byte unchanged from the last verified definition (20260813110100).
--   3. Runs the same helper once, directly, as a one-time backfill against
--      whatever `election_day_voters` rows already exist today - so the
--      already-imported dataset does not need a re-import to benefit.
--      Idempotent/safe to replay: a `NOT EXISTS` predicate plus an
--      `ON CONFLICT (display_name) WHERE status = 'active' DO NOTHING`
--      safety net (matching the exact partial unique index from Phase 5's
--      original coordinators-table migration) mean running this migration
--      file - or calling the helper - more than once against the same data
--      never errors and never inserts a duplicate row.
--   4. Closes a concurrency gap this change itself introduced: before this
--      migration, `election_day_manage_coordinators_v2` deliberately did NOT
--      take the global `election_day_voter_allocation_mutation` advisory
--      lock, because (per 20260813120000's own header comment) it "never
--      reads or writes election_day_voters at all, only
--      election_day_coordinators" - true at the time, since nothing that
--      held the advisory lock ever wrote to `election_day_coordinators`.
--      Step 1/2 above breaks that premise: `election_day_import_voters_v2`
--      now writes `election_day_coordinators` while holding the advisory
--      lock, so a concurrent `election_day_manage_coordinators_v2` call
--      (e.g. a manual "link") is no longer serialized against it - a narrow
--      TOCTOU window where a `linked_assignment_name` collision could slip
--      past the sync helper's `NOT EXISTS` check. Fixed by making
--      `election_day_manage_coordinators_v2` also acquire the exact same
--      advisory lock, in the exact same relative position the other 3
--      allocation v2 RPCs already use (after the proof/permission check and
--      pure input-shape validation, before any row-level FOR UPDATE lock) -
--      not a new lock, not a new ordering, just extending the already-
--      established, already-verified pattern to the one RPC that predates
--      the reason it now needs it too. Every other line of this function
--      (signature, permission, business logic, error codes, return shape)
--      is unchanged.
--
-- Explicitly NOT touched by this migration: `linked_assignment_name` is
-- never written here (the DB's original "never auto-matched" comment on
-- that column stays true - this is a plain "add", never an auto-link); no
-- existing coordinator row's `status`/`display_name`/`linked_assignment_name`
-- is ever read-then-written-back; no voter row is touched beyond what
-- `election_day_import_voters_v2` already did before this change; no RLS
-- policy changes; no new anon/authenticated-reachable surface (the new
-- helper is revoked from both, same as its sibling internal helpers).
begin;

-- 1. Private helper - internal only, never granted to anon/authenticated.
create or replace function public.election_day_sync_coordinators_from_voters()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.election_day_coordinators (display_name)
  select distinct trimmed.name
  from (
    select btrim(v.coordinator) as name
    from public.election_day_voters v
    where v.coordinator is not null and btrim(v.coordinator) <> ''
  ) as trimmed
  where not exists (
    select 1 from public.election_day_coordinators c
    where c.display_name = trimmed.name
       or c.linked_assignment_name = trimmed.name
  )
  on conflict (display_name) where status = 'active' do nothing;
end;
$$;

comment on function public.election_day_sync_coordinators_from_voters() is
  'Coordinator Allocation auto-preload (Option B, 2026-08-20): inserts one election_day_coordinators row per distinct, non-empty, trimmed election_day_voters.coordinator value not already represented by an existing coordinator''s display_name or linked_assignment_name, in any status - active or ended. Plain INSERT only - never updates/deletes/reactivates an existing row, never touches linked_assignment_name. Reads election_day_voters directly (no parameters) so the same function serves both election_day_import_voters_v2 (called after the atomic delete+insert) and this migration''s own one-time backfill unchanged. Internal helper only - not directly callable by anon/authenticated, same lockdown pattern as election_day_has_allocation_activity/election_day_is_valid_permission.';

revoke all on function public.election_day_sync_coordinators_from_voters() from public, anon, authenticated;

-- 2. election_day_import_voters_v2 - identical to the 20260813110100
-- definition except for the single `perform ... sync_coordinators...` line
-- added right before `return v_count`. Permission check, advisory lock,
-- allocation-activity guard, delete+insert semantics, and return type are
-- unchanged.
create or replace function public.election_day_import_voters_v2(
  p_reauth_proof text,
  p_voters jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_count integer;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.import' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  if public.election_day_has_allocation_activity() then
    raise exception 'ALLOCATION_ACTIVITY_STARTED';
  end if;

  delete from public.election_day_ride_status_events where true;
  delete from public.election_day_voters where true;

  insert into public.election_day_voters
    (masad, first_name, last_name, street, house_number, city, phone, coordinator)
  select
    coalesce(x.masad, ''),
    x.first_name,
    x.last_name,
    coalesce(x.street, ''),
    coalesce(x.house_number, 0),
    coalesce(x.city, ''),
    x.phone,
    x.coordinator
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

  -- New in this migration: same transaction, same advisory lock, same
  -- already-verified `electionDay.import` permission - no second RPC call,
  -- no second reauth prompt. Reads the `election_day_voters` rows just
  -- inserted above.
  perform public.election_day_sync_coordinators_from_voters();

  return v_count;
end;
$$;

comment on function public.election_day_import_voters_v2(text, jsonb) is
  'Security Phase 1 (proof-based, permission-checked replacement for election_day_import_voters), extended 2026-08-20 to also sync election_day_coordinators from the just-imported voter data in the same transaction (see election_day_sync_coordinators_from_voters''s own comment) - no second RPC call, no second reauth prompt. Requires electionDay.import on the resolved actor''s current role, checked strictly before the global election_day_voter_allocation_mutation advisory lock is acquired. Business logic (has_allocation_activity guard raising ALLOCATION_ACTIVITY_STARTED, the atomic delete+insert, NULL-coordinator support) unchanged from the prior verified definition (20260813110100). SECURITY DEFINER (required so the nested election_day_verify_reauth_proof and election_day_sync_coordinators_from_voters calls, both owner-only, succeed for real anon/authenticated callers).';

revoke all on function public.election_day_import_voters_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_import_voters_v2(text, jsonb) to anon, authenticated;

-- 3. One-time backfill for whatever `election_day_voters` rows already
-- exist today, so the already-imported dataset does not require a
-- re-import to benefit. Same helper, same rules, no separate code path.
-- Safe to replay (see the helper's own NOT EXISTS + ON CONFLICT DO NOTHING
-- guards) - a second run finds nothing new to insert.
select public.election_day_sync_coordinators_from_voters();

-- 4. election_day_manage_coordinators_v2 - identical to the 20260813120000
-- definition except for the single advisory-lock line added below (same
-- key, same relative position as the other 3 allocation v2 RPCs already
-- use: after the proof/permission check and the pure NO_ACTIONS input-shape
-- check, before the row-level FOR UPDATE lock). Permission check, business
-- logic for every action (add/edit/remove/link/relink/unlink), error codes,
-- and return shape are unchanged.
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

  -- New in this migration: global Election Day import/allocation mutation
  -- lock - acquired after the auth precondition and all pure input-shape
  -- validation above, before any read/lock of coordinator business state
  -- below. Same lock key, same relative position as
  -- election_day_import_voters_v2 and the other 3 allocation v2 RPCs -
  -- serializes this function against a concurrent import's coordinator
  -- sync (see this migration's header comment, point 4).
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

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
  'Security Phase 2: proof-based, live-permission-checked replacement for election_day_manage_coordinators (which took a raw p_actor_id/p_actor_password pair). Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role (re-read every call, never proof-snapshotted) before any mutation. Business logic (atomic batch add/edit/remove/link/unlink/relink, DISPLAY_NAME_LOCKED/COORDINATOR_LOCKED gating via election_day_has_allocation_activity/election_day_coordinator_participated, the cross-column ownership invariant) is unchanged from v1, byte-for-byte. Extended 2026-08-20 to also take the global election_day_voter_allocation_mutation advisory lock (same key/position as the other 3 allocation v2 RPCs) - closes a TOCTOU gap against election_day_import_voters_v2''s new coordinator-sync step, which now writes election_day_coordinators while holding this same lock (see this migration''s header comment, point 4). The v1 function is untouched and remains temporarily reachable for compatibility (retirement is a separate later phase).';

revoke all on function public.election_day_manage_coordinators_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_manage_coordinators_v2(text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   -- Restores the pre-2026-08-20 election_day_import_voters_v2 body
--   -- (identical to this file's function minus the
--   -- `perform ... sync_coordinators_from_voters();` line) - see
--   -- 20260813110100_election_day_admin_v2_rpcs.sql for that exact text.
--   drop function if exists public.election_day_sync_coordinators_from_voters();
--   -- (then re-run the CREATE OR REPLACE from 20260813110100 to restore
--   -- election_day_import_voters_v2's pre-sync body, and the CREATE OR
--   -- REPLACE from 20260813120000 to restore election_day_manage_
--   -- coordinators_v2's pre-lock body)
--   commit;
--
-- Note: this rollback does NOT remove any election_day_coordinators rows
-- this migration's backfill (or any post-migration import) may have
-- inserted - those are ordinary rows indistinguishable from a manually
-- added coordinator, by design (no special marking, consistent with this
-- codebase's "no protected roles / no hidden flags" convention elsewhere).
-- Removing them, if ever desired, is a separate, explicit, manual decision.
-- ============================================================================
