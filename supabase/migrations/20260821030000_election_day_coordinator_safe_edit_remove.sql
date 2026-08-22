-- Coordinator Allocation Management - final coordinator identity invariant
-- (approved 2026-08-21, amended in place while still uncommitted/local-only
-- - see CURRENT_STATUS.md's "Coordinator Delete" section for the full,
-- multi-pass investigation record this amendment closes out).
--
-- This file was amended twice before being committed or applied to
-- Production, each time closing a gap the previous version's own review
-- surfaced:
--   Pass 1 (original version of this file): replaced the old GLOBAL
--     `election_day_has_allocation_activity()` gate on `edit`/`remove` with
--     a per-coordinator pair - NOT `election_day_coordinator_participated()`
--     AND NOT EXISTS a voter currently matching the coordinator's CURRENT
--     `display_name`. Closed the original stale-rename gap (a coordinator
--     could be renamed away from a name that still had real assigned
--     voters, since `edit` never cascades to `election_day_voters`).
--   Pass 2 (this version): a follow-up identity-architecture review found
--     two more real gaps in the SAME class - free-text identity that can
--     silently diverge from what it's supposed to represent:
--       (a) the voter-assignment check only looked at `display_name`, never
--           `linked_assignment_name` - but `election_day_end_coordinator_
--           activity_v2` has always treated BOTH columns as equally valid
--           "this coordinator's voters" (its own `v_source_names :=
--           array_remove(array[display_name, linked_assignment_name],
--           null)` pattern) - a coordinator linked to a pre-existing Excel
--           string different from its display_name could pass the old
--           guard while still owning real voters via that linked string.
--       (b) `election_day_permission_users.name` (the separate login
--           roster - NO FK, NO relationship of any kind to
--           `election_day_coordinators`) can coincidentally equal a
--           coordinator's `display_name`/`linked_assignment_name` - this is
--           in fact how `assigned_to_me` scoping works today
--           (`electionDayScope.ts`'s `contacts.filter(c => c.coordinator
--           === sessionUser.name)`). Renaming or deleting a coordinator
--           whose name a live login depends on would silently blind that
--           person to their own assignments, with zero error anywhere.
--       (c) `add` never checked whether the proposed name already belonged
--           to an ENDED coordinator (only checked ACTIVE-active collision,
--           via the DB's own partial unique index, and
--           `linked_assignment_name` collision in any status) - so a new
--           active coordinator could be created sharing a name with an
--           ended one that still has real voters, producing two rows with
--           zero way to tell which one a shared voter-name string actually
--           belongs to.
--
-- Final invariant, implemented below:
--
--   ADD: a new `display_name` is rejected if it matches ANY existing
--   coordinator's `display_name` OR `linked_assignment_name`, in ANY
--   status (active or ended) - closes (c). Ended-name reuse via a brand-new
--   row is blocked; reactivating the SAME row is a separate, not-yet-built
--   feature. Deliberately NOT blocked against an existing
--   `election_day_permission_users.name` - a coordinator is routinely
--   created before its matching login account exists, and blocking that
--   would break normal onboarding order.
--
--   EDIT (rename): allowed only when ALL of:
--     1. NOT election_day_coordinator_participated(id)
--     2. NOT EXISTS a voter currently matching the coordinator's CURRENT
--        display_name OR linked_assignment_name - closes (a)
--     3. NOT EXISTS a election_day_permission_users.name matching the
--        coordinator's CURRENT display_name OR linked_assignment_name -
--        closes (b)
--     4. the NEW display_name does not collide with any OTHER coordinator's
--        display_name or linked_assignment_name, in any status (unchanged
--        shape from pass 1, now also checking display_name, not just
--        linked_assignment_name, for symmetry with ADD's check)
--   All four failure paths raise the same DISPLAY_NAME_LOCKED code (single
--   combined "blocked" reason for the rename UX, unchanged philosophy from
--   pass 1) except failure 4, which keeps the existing COORDINATOR_NAME_
--   COLLISION code (a different kind of block - a naming conflict, not a
--   safety lock).
--
--   REMOVE: allowed only when ALL of:
--     1. NOT election_day_coordinator_participated(id)
--     2. NOT EXISTS a voter matching display_name OR linked_assignment_name
--     3. NOT EXISTS a election_day_permission_users.name matching either
--   Each failure raises a DISTINCT code so the UI can give a specific
--   reason: COORDINATOR_LOCKED (1, participation/history -> use
--   `סיום פעילות`), COORDINATOR_HAS_ASSIGNED_VOTERS (2, currently-assigned
--   voters -> use `העבר הקצאות`), or the new
--   COORDINATOR_HAS_LOGIN_ACCOUNT (3, a live login depends on this identity
--   -> resolve that user relationship first).
--
--   `link`/`relink`/`unlink` are UNCHANGED - confirmed, by direct code
--   review, to have zero effect on `assigned_to_me` scoping (they only ever
--   write `linked_assignment_name`, which `electionDayScope.ts` never
--   reads) - no reason to expand their scope for this invariant.
--
-- Deliberately NOT done here, per explicit scope: no automatic voter-name
-- or PermissionUser-name rewriting on rename (edit still only ever touches
-- `election_day_coordinators.display_name`); no schema/FK/RLS/permission
-- redesign; no new advisory lock (the existing
-- `election_day_voter_allocation_mutation` lock, already acquired before
-- any row lock, already covers every check below, since they all run later
-- in the same lock-held transaction); no PermissionUser-side changes (no
-- rename RPC exists for PermissionUser at all, and none is added here).
--
-- Every other line of this function (signature, permission check, lock
-- acquisition/position, row-level FOR UPDATE locking, link/relink/unlink
-- branches, return contract) is unchanged from the prior verified
-- definition.
--
-- Applied to LOCAL DOCKER ONLY - not applied to Production. This file has
-- never been committed; amending it in place (rather than layering a third
-- migration on top of an undeployed one) is intentional, per this project's
-- own convention for still-uncommitted/not-yet-deployed migrations.
begin;

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
  v_current_display_name text;
  v_current_identity_names text[];
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

  -- Global Election Day import/allocation mutation lock - acquired after the
  -- auth precondition and all pure input-shape validation above, before any
  -- read/lock of coordinator business state below (unchanged from
  -- 20260820000000). Covers every check below - they run later in the same
  -- per-action branch, still inside this same lock-held transaction.
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

      -- Name reservation: the proposed name must match no existing
      -- coordinator's display_name or linked_assignment_name, in ANY
      -- status - blocks both the pre-existing linked_assignment_name
      -- collision case and the newly-closed ended-display_name-reuse case.
      -- Deliberately does NOT check election_day_permission_users - a
      -- coordinator is routinely added before its matching login exists.
      if exists (
        select 1 from public.election_day_coordinators c
        where c.display_name = v_display_name
           or c.linked_assignment_name = v_display_name
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      insert into public.election_day_coordinators (display_name)
      values (v_display_name);

    elsif v_action_type = 'edit' then
      if v_coordinator_id is null or v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_current_identity_names := array_remove(array[v_current_display_name, v_existing_linked_name], null);

      -- Safe-rename guard: a coordinator with real history, with voters
      -- currently matching either of its live identity names, or with a
      -- login account depending on either name, may not be renamed -
      -- renaming never rewrites election_day_voters or
      -- election_day_permission_users, so allowing it here would silently
      -- orphan whichever of those depends on the old name. All three raise
      -- the same DISPLAY_NAME_LOCKED code - the rename UX needs one
      -- combined reason, not three.
      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and (c.display_name = v_display_name or c.linked_assignment_name = v_display_name)
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

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_current_identity_names := array_remove(array[v_current_display_name, v_existing_linked_name], null);

      -- Safe-delete guard: the same three-condition pair as `edit` above,
      -- reported as three distinct codes so the UI can give a specific,
      -- actionable reason for each.
      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
      ) then
        raise exception 'COORDINATOR_HAS_ASSIGNED_VOTERS';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
      ) then
        raise exception 'COORDINATOR_HAS_LOGIN_ACCOUNT';
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
  'Final coordinator identity invariant (2026-08-21): proof-based, live-permission-checked replacement for election_day_manage_coordinators. Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role before any mutation, then the global election_day_voter_allocation_mutation advisory lock. add rejects any display_name matching an existing coordinator''s display_name/linked_assignment_name in any status (ended-name reuse via a new row is blocked; reactivation is a separate future feature). edit/remove are gated on: NOT election_day_coordinator_participated(id) AND NOT EXISTS a voter matching the coordinator''s current display_name/linked_assignment_name AND NOT EXISTS a election_day_permission_users.name matching either - closing both the free-text voter-identity gap and the separate, unrelated-by-FK login-identity gap (assigned_to_me scoping matches purely by name string, with zero relationship to this table). edit raises DISPLAY_NAME_LOCKED for any of the three safety failures (COORDINATOR_NAME_COLLISION for a plain naming conflict with another row); remove raises COORDINATOR_LOCKED / COORDINATOR_HAS_ASSIGNED_VOTERS / COORDINATOR_HAS_LOGIN_ACCOUNT respectively so the client can give a specific reason. link/relink/unlink are unchanged - confirmed to have no effect on assigned_to_me scoping. Return contract unchanged.';

revoke all on function public.election_day_manage_coordinators_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_manage_coordinators_v2(text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   -- Re-run the CREATE OR REPLACE from 20260820000000_election_day_import_
--   -- coordinator_sync.sql (that file's own body for this function) to
--   -- restore the pre-identity-invariant definition (global activity gate
--   -- on edit/remove, no per-coordinator check, no login-identity check).
--   commit;
-- ============================================================================
