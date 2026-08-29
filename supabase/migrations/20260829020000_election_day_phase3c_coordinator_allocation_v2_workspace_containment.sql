-- Phase 3C Coordinator/Allocation - legacy v2 workspace containment ONLY.
-- Same defect class already found and fixed for Roles v2 (20260828030000)
-- and Users v2 (20260828000000): election_day_manage_coordinators_v2 /
-- _apply_initial_allocation_v2 / _rebalance_assignments_v2 /
-- _end_coordinator_activity_v2 perform ZERO workspace derivation or scoping,
-- even though election_day_coordinators.workspace_id and
-- election_day_voters.workspace_id have existed since Multi-Tenant Phase 1
-- (20260823020000) and were backfilled in Phase 2 (20260824010000). Not yet
-- exploitable in Production (confirmed live, read-only, immediately before
-- authoring this migration: exactly one election_workspaces row, one
-- election_owners row, 0 of 5 election_day_coordinators rows and 0 of 1420
-- election_day_voters rows carry a NULL workspace_id - every row already
-- belongs to that one workspace) - but structurally identical to the two
-- already-fixed classes, and left open it would become a live cross-tenant
-- allocation/coordinator-management path the moment a second workspace is
-- ever provisioned.
--
-- CREATE OR REPLACE, in place, of the 4 EXISTING _v2 coordinator/allocation
-- RPCs - same names, same signatures, same grants (ACL unchanged - CREATE OR
-- REPLACE FUNCTION does not alter an existing function's privileges), same
-- legacy proof mechanism (election_day_verify_reauth_proof, action IS NULL),
-- same electionDay.manageCoordinatorAllocation permission gate, same shared
-- election_day_voter_allocation_mutation advisory lock (same key, same
-- relative position - after auth/shape validation, before any row lock -
-- unchanged), same business rules, same error codes, same audit-row shape.
-- Every legitimate same-workspace legacy caller (the only live frontend path
-- today) keeps working with zero code/contract change.
--
-- Adds, uniformly across all 4, mirroring the Roles/Users containment
-- migrations' own established pattern:
--   1. actor workspace derived server-side - a lookup on
--      election_day_permission_users keyed by the proof-resolved actor_id
--      (the legacy verifier itself has no workspace column to return, same
--      limitation noted in both prior containment migrations - cannot be
--      folded into that shared helper without touching the other 7 legacy
--      actions that also call it, out of scope here).
--   2. an explicit ACTOR_WORKSPACE_REQUIRED guard on a NULL actor
--      workspace_id (reachable today - election_day_create_permission_user_v2,
--      untouched by this migration, still never writes workspace_id) -
--      checked BEFORE any lock/read/write of coordinator or voter business
--      state, so a workspace-less actor mutates nothing.
--   3. every coordinator lookup/lock (manage_coordinators_v2's per-action
--      existence checks and its batch FOR UPDATE lock; apply_initial_
--      allocation_v2/rebalance_assignments_v2's referenced-coordinator lock
--      and NOT_ACTIVE check; end_coordinator_activity_v2's source/target/
--      other-active-coordinator locks) now filters on
--      workspace_id = the actor's own derived workspace_id. A cross-workspace
--      or nonexistent id collapses into the SAME pre-existing not-found code
--      (COORDINATOR_NOT_FOUND / TARGET_NOT_FOUND) every one of these
--      functions already raises for a genuinely nonexistent id - never
--      distinguishable, per the containment requirement established by the
--      two prior migrations.
--   4. every voter scan/lock (initial allocation's `coordinator IS NULL`
--      scan; rebalance's/end-coordinator's `coordinator = any(source names)
--      AND election_day_voter_is_remaining(...)` scans) now additionally
--      requires `workspace_id = the actor's own derived workspace_id` at the
--      point the row lock is taken and the id set is captured - every
--      downstream step (mapping, UPDATE, audit-item insert) already only
--      ever operates on that captured id set, so scoping the capture itself
--      is sufficient; no downstream step needed a separate filter.
--   5. manage_coordinators_v2's `add` action now writes the new row's
--      workspace_id as the actor's own server-derived value (previously
--      always NULL, matching the exact "previously always NULL" gap already
--      found and fixed for Roles v2's create/clone).
--   6. manage_coordinators_v2's name/link/voter-identity/login-identity
--      integrity checks (COORDINATOR_NAME_COLLISION, the edit/remove safety
--      guard's voter-match and election_day_permission_users-match checks)
--      are now scoped to the actor's own workspace_id, so a same-named
--      coordinator, voter, or login account in a DIFFERENT workspace can
--      never block or leak into a same-workspace action.
--   7. end_coordinator_activity_v2's LAST_ACTIVE_COORDINATOR guard: the
--      "every other currently active coordinator" set used both to compute
--      v_destinations_count (the guard's own condition) and to build the
--      equal-split destination ranges is now workspace-scoped - "last active
--      coordinator" now correctly means "last active coordinator IN THAT
--      WORKSPACE", not globally.
--
-- NOT changed, per explicit scope (preserved exactly as-is, not silently
-- dropped - tracked here, same as both prior containment migrations'
-- own header comments):
--   1. election_day_coordinators' partial unique index on display_name
--      (WHERE status = 'active', the ON CONFLICT target
--      election_day_sync_coordinators_from_voters relies on) stays a GLOBAL
--      index, not a (workspace_id, display_name) composite - same exact
--      limitation already tracked, unfixed, for election_day_roles.name's
--      global UNIQUE(name) constraint (see 20260828030000's own header).
--      This migration's own new workspace-scoped COORDINATOR_NAME_COLLISION
--      application-level check is therefore not the only enforcement layer -
--      a raw unique-constraint violation could still surface across two
--      different workspaces sharing an identical active coordinator name.
--      Must be revisited before a second workspace can safely provision a
--      colliding coordinator name.
--   2. election_day_coordinator_operations / _operation_items are NOT given
--      a workspace_id write by this migration, even though both tables have
--      carried a nullable workspace_id column since Phase 1 - out of this
--      migration's explicit scope (the approved task instructions list only
--      coordinator/voter reads-and-writes for containment, and explicitly
--      require "existing audit semantics" preserved unchanged). Every
--      operation/operation_item row written by any of these 4 functions,
--      including after this migration, still has workspace_id = NULL. This
--      is a real, tracked gap for a possible future containment pass over
--      these two tables, not an oversight.
--   3. election_day_import_voters_v2 and election_day_sync_coordinators_
--      from_voters are NOT touched by this migration (explicitly out of
--      scope) - election_day_import_voters_v2's INSERT into
--      election_day_voters still never writes workspace_id, so a re-import
--      today would still silently reset every imported voter's workspace_id
--      back to NULL. Tracked, not fixed here.
--   4. No RLS policy change, no table-grant change, no v3 RPC, no frontend
--      change, no change to election_day_verify_reauth_proof or any other
--      legacy action, no change to Users/Roles.
--   5. electionDay.manageCoordinatorAllocation remains the only permission
--      gate - not tightened, not loosened, not made Owner-only. Whether
--      these 4 actions' eventual v3 replacement should be Owner-only or
--      remain PermissionUser-authorized is an explicit, separate, not-yet-
--      made product decision - this migration takes no position on it.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- 1. election_day_manage_coordinators_v2 (containment).
-- Identical business logic to the current live definition (20260822000000 -
-- coordinator identity invariant + optional phone) except for the workspace
-- derivation/guard and the workspace filters described in this migration's
-- own header, points 2-3 and 5-6.
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
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
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
  v_phone_raw text;
  v_phone_digits text;
  v_phone_normalized text;
begin
  -- 1. Resolve the actor from the proof alone (UNAUTHORIZED on any
  -- invalid/expired/forged/blank proof, raised inside the helper itself).
  select v.actor_id, v.role_id
    into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  -- 2. Verify the actor's CURRENT role holds
  -- electionDay.manageCoordinatorAllocation, read live every call.
  select ('electionDay.manageCoordinatorAllocation' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  -- 3. Derive the actor's own workspace server-side (containment). A NULL
  -- workspace fails closed before any lock/read/write of business state -
  -- reachable today since election_day_create_permission_user_v2 never
  -- writes workspace_id.
  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
  end if;

  if p_actions is null or jsonb_typeof(p_actions) <> 'array' or jsonb_array_length(p_actions) = 0 then
    raise exception 'NO_ACTIONS';
  end if;

  -- Global Election Day import/allocation mutation lock - acquired after the
  -- auth+workspace precondition and all pure input-shape validation above,
  -- before any read/lock of coordinator business state below. Unchanged
  -- key/position from the pre-containment definition.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- 4. Lock every coordinator row this batch references, once, in a single
  -- ascending-id pass, before processing any action - now filtered to the
  -- actor's own workspace. A cross-workspace id simply never gets locked
  -- here; every per-action existence check below (also workspace-filtered)
  -- then raises the same COORDINATOR_NOT_FOUND it already raises for a
  -- genuinely nonexistent id.
  select array_agg(distinct x.id order by x.id)
    into v_lock_ids
  from jsonb_array_elements(p_actions) as elem
  cross join lateral (select nullif(elem->>'coordinator_id', '')::uuid as id) as x
  where x.id is not null;

  if v_lock_ids is not null then
    perform 1 from public.election_day_coordinators
    where id = any(v_lock_ids)
      and workspace_id = v_actor_workspace_id
    order by id
    for update;
  end if;

  -- 5. Process each action in the order supplied. Any RAISE EXCEPTION below
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

      -- Name reservation, workspace-scoped (containment) - a same-named
      -- coordinator in a DIFFERENT workspace can no longer block this
      -- create. NOTE: the underlying partial unique index on display_name
      -- (WHERE status = 'active') remains GLOBAL, not workspace-scoped -
      -- see this migration's own header, "NOT changed" point 1.
      if exists (
        select 1 from public.election_day_coordinators c
        where (c.display_name = v_display_name or c.linked_assignment_name = v_display_name)
          and c.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      -- Optional phone on creation - same normalize/validate block
      -- `update_phone` uses below, see that branch's own comment.
      v_phone_raw := nullif(btrim(v_action->>'phone'), '');
      if v_phone_raw is not null then
        v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
        if left(v_phone_digits, 3) = '972' and length(v_phone_digits) = 12 then
          v_phone_normalized := '0' || substr(v_phone_digits, 4);
        elsif length(v_phone_digits) = 9 and left(v_phone_digits, 1) <> '0' then
          v_phone_normalized := '0' || v_phone_digits;
        else
          v_phone_normalized := v_phone_digits;
        end if;
        if v_phone_normalized !~ '^0[0-9]{8,9}$' then
          raise exception 'INVALID_COORDINATOR_PHONE';
        end if;
      else
        v_phone_normalized := null;
      end if;

      -- workspace_id is the ACTING CALLER'S OWN server-derived value
      -- (containment) - previously always NULL.
      insert into public.election_day_coordinators (display_name, phone, workspace_id)
      values (v_display_name, v_phone_normalized, v_actor_workspace_id);

    elsif v_action_type = 'edit' then
      if v_coordinator_id is null or v_display_name is null then
        raise exception 'INVALID_COORDINATOR_NAME';
      end if;

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

      -- Same COORDINATOR_NOT_FOUND for "doesn't exist" and "exists in a
      -- different workspace" (containment) - never distinguishable.
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
      -- combined reason, not three. Both integrity checks are now
      -- workspace-scoped (containment) - a same-named voter/login account
      -- in a DIFFERENT workspace can no longer block this rename.
      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
          and v.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
          and u.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'DISPLAY_NAME_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and (c.display_name = v_display_name or c.linked_assignment_name = v_display_name)
          and c.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      update public.election_day_coordinators
      set display_name = v_display_name
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

    elsif v_action_type = 'remove' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      select display_name, linked_assignment_name
        into v_current_display_name, v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_current_identity_names := array_remove(array[v_current_display_name, v_existing_linked_name], null);

      -- Safe-delete guard: the same three-condition pair as `edit` above,
      -- reported as three distinct codes so the UI can give a specific,
      -- actionable reason for each. Both integrity checks workspace-scoped
      -- (containment), same reasoning as `edit` above.
      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      if exists (
        select 1 from public.election_day_voters v
        where v.coordinator = any(v_current_identity_names)
          and v.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_HAS_ASSIGNED_VOTERS';
      end if;

      if exists (
        select 1 from public.election_day_permission_users u
        where u.name = any(v_current_identity_names)
          and u.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_HAS_LOGIN_ACCOUNT';
      end if;

      delete from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

    elsif v_action_type in ('link', 'relink') then
      if v_coordinator_id is null or v_linked_name is null then
        raise exception 'INVALID_LINK';
      end if;

      if not exists (
        select 1 from public.election_day_coordinators
        where id = v_coordinator_id
          and workspace_id = v_actor_workspace_id
      ) then
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
          and c.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_NAME_COLLISION';
      end if;

      if exists (
        select 1 from public.election_day_coordinators c
        where c.id <> v_coordinator_id
          and c.linked_assignment_name = v_linked_name
          and c.workspace_id = v_actor_workspace_id
      ) then
        raise exception 'ASSIGNMENT_ALREADY_LINKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = v_linked_name
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

    elsif v_action_type = 'unlink' then
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      select linked_assignment_name into v_existing_linked_name
      from public.election_day_coordinators
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

      if not found then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if public.election_day_coordinator_participated(v_coordinator_id) then
        raise exception 'COORDINATOR_LOCKED';
      end if;

      update public.election_day_coordinators
      set linked_assignment_name = null
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

    elsif v_action_type = 'update_phone' then
      -- Phone is CONTACT METADATA, not identity: deliberately NO
      -- participation/history check, NO assigned-voters check, NO login-
      -- account check, NO status restriction - unchanged from the
      -- pre-containment definition. Existence check is now
      -- workspace-scoped (containment).
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if not exists (
        select 1 from public.election_day_coordinators
        where id = v_coordinator_id
          and workspace_id = v_actor_workspace_id
      ) then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      v_phone_raw := nullif(btrim(v_action->>'phone'), '');
      if v_phone_raw is not null then
        v_phone_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
        if left(v_phone_digits, 3) = '972' and length(v_phone_digits) = 12 then
          v_phone_normalized := '0' || substr(v_phone_digits, 4);
        elsif length(v_phone_digits) = 9 and left(v_phone_digits, 1) <> '0' then
          v_phone_normalized := '0' || v_phone_digits;
        else
          v_phone_normalized := v_phone_digits;
        end if;
        if v_phone_normalized !~ '^0[0-9]{8,9}$' then
          raise exception 'INVALID_COORDINATOR_PHONE';
        end if;
      else
        v_phone_normalized := null;
      end if;

      update public.election_day_coordinators
      set phone = v_phone_normalized
      where id = v_coordinator_id
        and workspace_id = v_actor_workspace_id;

    else
      raise exception 'INVALID_ACTION';
    end if;
  end loop;

  -- 6. Return the full current coordinator roster, workspace-scoped
  -- (containment - the pre-containment definition returned the GLOBAL
  -- roster, matching listCoordinators()'s own current unscoped read; scoping
  -- this return value is a genuine, deliberate tightening beyond the
  -- minimum needed to stop cross-workspace mutation, consistent with "no
  -- cross-workspace read leak" for the one surface this function itself
  -- controls).
  return query
    select * from public.election_day_coordinators
    where workspace_id = v_actor_workspace_id
    order by created_at asc, id asc;
end;
$$;

comment on function public.election_day_manage_coordinators_v2(text, jsonb) is
  'Phase 3C containment: proof-based, live-permission-checked, WORKSPACE-SCOPED atomic batch add/edit/remove/link/unlink/relink/update_phone. Derives the actor''s own workspace_id server-side and requires it non-null (ACTOR_WORKSPACE_REQUIRED). Every coordinator lookup/lock, the add action''s COORDINATOR_NAME_COLLISION check, and edit/remove''s voter-match and login-account-match integrity checks are now scoped to the actor''s own workspace_id - a cross-workspace or nonexistent target collapses into the same pre-existing COORDINATOR_NOT_FOUND. add writes the new row''s workspace_id as the actor''s own value (previously always NULL). The returned roster is now workspace-scoped too. Business logic (DISPLAY_NAME_LOCKED/COORDINATOR_LOCKED/COORDINATOR_HAS_ASSIGNED_VOTERS/COORDINATOR_HAS_LOGIN_ACCOUNT gating, phone normalize/validate, the shared election_day_voter_allocation_mutation advisory lock) unchanged. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any actor with a valid workspace. The underlying partial unique index on display_name (WHERE status = active) remains GLOBAL, not workspace-scoped - see this migration''s own header for the tracked limitation.';

-- ============================================================================
-- 2. election_day_apply_initial_allocation_v2 (containment).
-- Identical business logic to the pre-containment definition (20260813120000)
-- except for the workspace derivation/guard and the workspace filters
-- described in this migration's own header, points 2 and 4.
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

  -- 3. Derive the actor's own workspace server-side (containment). Fails
  -- closed before any lock/read/write of business state.
  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
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
  -- the auth+workspace precondition and all pure input-shape validation
  -- above, before any read/lock of coordinator or voter business state
  -- below. Same lock key/position as before containment.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock every referenced coordinator, ascending by id, then validate -
  -- now filtered to the actor's own workspace (containment). A
  -- cross-workspace id is simply never locked, so the count-mismatch check
  -- below already raises COORDINATOR_NOT_FOUND for it - the same code
  -- already used for a genuinely nonexistent id.
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

  -- Lock every currently-unassigned voter IN THE ACTOR'S OWN WORKSPACE
  -- (containment), deterministic order, and get the true post-lock count in
  -- one pass.
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

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - workspace-scoped at capture (containment), so every
  -- downstream step (mapping, UPDATE, audit item) is transitively
  -- workspace-scoped without needing its own separate filter.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator is null
    and workspace_id = v_actor_workspace_id;

  insert into public.election_day_coordinator_operations
    (operation_type, executed_by_id, executed_by_name_snapshot, subject_coordinator_id, subject_coordinator_name_snapshot)
  values ('initial_allocation', v_actor_id, v_actor_name, null, null)
  returning id into v_operation_id;

  -- Deterministic mapping: the exact locked voters (v_locked_voter_ids),
  -- ordered by created_at/id, are sliced into contiguous ranges matching
  -- p_assignments' own array order and quantities - no voter id ever comes
  -- from the client, and no row outside the locked (and now
  -- workspace-scoped) set can enter this mapping.
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
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, null, null, u.coordinator_id, u.coordinator_display_name
  from updated u;

  return query select v_operation_id, v_unassigned_count, 0;
end;
$$;

comment on function public.election_day_apply_initial_allocation_v2(text, jsonb) is
  'Phase 3C containment: proof-based, live-permission-checked, WORKSPACE-SCOPED one-time distribution of every currently-unassigned voter. Derives the actor''s own workspace_id server-side and requires it non-null (ACTOR_WORKSPACE_REQUIRED). Referenced coordinators must belong to the actor''s workspace (a cross-workspace or nonexistent id collapses into the same COORDINATOR_NOT_FOUND). The unassigned-voter scan is workspace_id = actor workspace AND coordinator IS NULL - the locked/captured voter id set is workspace-scoped at capture, so every downstream mapping/update/audit step is transitively scoped. Business logic (shape validation, ALLOCATION_COUNT_MISMATCH exact-sum requirement, the shared election_day_voter_allocation_mutation advisory lock, deterministic created_at/id-ascending selection) unchanged from the pre-containment version. Same name/signature/grants as before.';

-- ============================================================================
-- 3. election_day_rebalance_assignments_v2 (containment).
-- Identical business logic to the pre-containment definition (20260813120000)
-- except for the workspace derivation/guard and the workspace filters
-- described in this migration's own header, points 2 and 4.
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

  -- 3. Derive the actor's own workspace server-side (containment). Fails
  -- closed before any lock/read/write of business state.
  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if v_actor_workspace_id is null then
    raise exception 'ACTOR_WORKSPACE_REQUIRED';
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
  -- the auth+workspace precondition and all pure input-shape validation
  -- above, before any read/lock of coordinator or voter business state
  -- below. Same lock key/position as before containment.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock every referenced coordinator (sources + destinations), ascending
  -- by id, in one pass; validate all found, active, and now IN THE ACTOR'S
  -- OWN WORKSPACE (containment) - a cross-workspace id is simply never
  -- locked, so the count-mismatch check below already raises
  -- COORDINATOR_NOT_FOUND for it.
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

  -- Lock every eligible voter across all sources in one deterministic pass -
  -- source-coordinator lookup itself already workspace-verified above.
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

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - workspace-scoped at capture (containment), so every
  -- downstream step is transitively scoped.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  -- Per-source recount: each source's requested quantity must not exceed
  -- its own true, post-lock eligible count - restricted to the locked
  -- (workspace-scoped) id set captured above, never a live re-match of the
  -- predicate.
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
    (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
  select v_operation_id, u.id, u.full_name, u.source_id, u.source_display_name, u.to_id, u.to_name
  from updated u;

  get diagnostics v_transferred_count = row_count;

  return query select v_operation_id, v_transferred_count;
end;
$$;

comment on function public.election_day_rebalance_assignments_v2(text, jsonb, jsonb) is
  'Phase 3C containment: proof-based, live-permission-checked, WORKSPACE-SCOPED mid-day transfer of "remaining" voters. Derives the actor''s own workspace_id server-side and requires it non-null (ACTOR_WORKSPACE_REQUIRED). Source/destination coordinators must belong to the actor''s workspace (a cross-workspace or nonexistent id collapses into the same COORDINATOR_NOT_FOUND). Voter selection/recount/mapping is restricted to the actor''s own workspace throughout - the locked/captured voter id set is workspace-scoped at capture, so every downstream step is transitively scoped. Business logic (SOURCE_DESTINATION_OVERLAP/REBALANCE_SUM_MISMATCH/REBALANCE_SOURCE_INSUFFICIENT checks, election_day_voter_is_remaining eligibility, display_name AND linked_assignment_name both counting as source ownership, the shared election_day_voter_allocation_mutation advisory lock) unchanged from the pre-containment version. Same name/signature/grants as before.';

-- ============================================================================
-- 4. election_day_end_coordinator_activity_v2 (containment).
-- Identical business logic to the pre-containment definition (20260813120000)
-- except for the workspace derivation/guard and the workspace filters
-- described in this migration's own header, points 2, 4, and 7.
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

  -- 3. Derive the actor's own workspace server-side (containment). Fails
  -- closed before any lock/read/write of business state.
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

  -- Global Election Day import/allocation mutation lock - acquired after
  -- the auth+workspace precondition and all pure input-shape validation
  -- above, before any read/lock of coordinator or voter business state
  -- below. Same lock key/position as before containment.
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_voter_allocation_mutation')::bigint);

  -- Lock the coordinator rows this call can possibly touch, ascending by
  -- id, in one pass - now filtered to the actor's own workspace
  -- (containment). equal_split's destination set is "every other active
  -- coordinator IN THE SAME WORKSPACE", locked separately below once the
  -- source's own status/workspace is confirmed.
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

  -- Same COORDINATOR_NOT_FOUND for "doesn't exist" and "exists in a
  -- different workspace" (containment) - never distinguishable.
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

    -- Same TARGET_NOT_FOUND for "doesn't exist" and "exists in a different
    -- workspace" (containment).
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

  -- Lock the source's remaining voters IN THE ACTOR'S OWN WORKSPACE
  -- (containment), deterministic order, get the count.
  perform 1
  from public.election_day_voters v
  where v.coordinator = any(v_source_names)
    and v.workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(v.voted, v.not_voting_reason_id)
  order by v.created_at asc, v.id asc
  for update;
  get diagnostics v_remaining_count = row_count;

  -- Capture the exact locked voter id set now, while this transaction holds
  -- their row locks - workspace-scoped at capture (containment), so every
  -- downstream step is transitively scoped.
  select array_agg(id) into v_locked_voter_ids
  from public.election_day_voters
  where coordinator = any(v_source_names)
    and workspace_id = v_actor_workspace_id
    and public.election_day_voter_is_remaining(voted, not_voting_reason_id);

  if p_mode = 'equal_split' then
    -- Lock every OTHER currently active coordinator IN THE SAME WORKSPACE
    -- (containment) - "last active coordinator" now correctly means "last
    -- active coordinator in this workspace", not globally.
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
      (operation_id, voter_id, voter_name_snapshot, from_coordinator_id, from_coordinator_name_snapshot, to_coordinator_id, to_coordinator_name_snapshot)
    select v_operation_id, u.id, u.full_name, p_coordinator_id, v_source_display_name, u.dest_id, u.dest_name
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
  'Phase 3C containment: proof-based, live-permission-checked, WORKSPACE-SCOPED end-of-activity for one coordinator. Derives the actor''s own workspace_id server-side and requires it non-null (ACTOR_WORKSPACE_REQUIRED). Source/target/other-active-coordinator lookups are all restricted to the actor''s own workspace (a cross-workspace or nonexistent id collapses into the same COORDINATOR_NOT_FOUND / TARGET_NOT_FOUND). The remaining-voter set is workspace-scoped at capture, so every downstream move/audit step is transitively scoped. LAST_ACTIVE_COORDINATOR now correctly means last active coordinator IN THE ACTOR''S WORKSPACE - the same workspace-scoped "every other active coordinator" set feeds both the guard''s count and the equal-split destination ranges, so they cannot disagree. Business logic (transfer vs equal_split modes, deterministic even-split with remainder to earliest-id destinations, a coordinator_end operation row always written on success, source coordinator always ends - never deleted, the shared election_day_voter_allocation_mutation advisory lock) unchanged from the pre-containment version. Same name/signature/grants as before.';

commit;

-- ============================================================================
-- ROLLBACK (manual, restores the PRE-containment behavior - no workspace
-- derivation/scoping of any kind, workspace_id left NULL on manage_
-- coordinators_v2's add - only do this if a legitimate need to revert is
-- identified; functions were never dropped, so re-running the exact prior
-- CREATE OR REPLACE bodies is the only step needed):
--
--   - election_day_manage_coordinators_v2: re-run the body from
--     20260822000000_election_day_coordinator_phone.sql.
--   - election_day_apply_initial_allocation_v2,
--     election_day_rebalance_assignments_v2,
--     election_day_end_coordinator_activity_v2: re-run the bodies from
--     20260813120000_election_day_allocation_v2_rpcs.sql.
--
-- (v1 functions and every other RPC were never touched by this migration -
-- no other rollback is needed.)
-- ============================================================================
