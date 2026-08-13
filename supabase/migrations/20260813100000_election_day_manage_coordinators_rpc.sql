-- Coordinator Allocation Management - Phase 3 (RPC core), part A/2.
-- Adds:
--   1. election_day_coordinator_participated(uuid) - a small boolean helper,
--      reused by this file's own manage_coordinators RPC (link/unlink/relink
--      locking below) and by Phase 3 part B's rebalance/end RPCs indirectly
--      via the same "has this coordinator entity ever been touched by a
--      business operation" question.
--   2. election_day_manage_coordinators(p_actor_id, p_actor_password,
--      p_actions) - one atomic batch RPC for add/edit/remove/link/unlink/
--      relink, replacing what would otherwise be N sequential frontend
--      mutations with no shared transaction.
--
-- Server authorization on the batch RPC reuses, byte-for-byte in structure,
-- the actor re-authentication pattern already shipped and verified in
-- election_day_reset_permission_user_password (see
-- 20260806210000_election_day_reset_permission_user_password_fix.sql, the
-- true latest live definition - confirmed by reading both that file and its
-- pre-fix predecessor before writing this migration): bcrypt-verify
-- p_actor_password against the actor's own password_hash (UNAUTHORIZED on
-- any mismatch or missing actor - id and wrong-password indistinguishable),
-- then check the actor's role holds the required permission
-- (electionDay.manageCoordinatorAllocation here, in place of
-- electionDay.manageUsers) via election_day_roles.permissions (FORBIDDEN
-- otherwise). Only then does any business logic run. Password is never
-- selected back out, never returned, never written to any audit row.
--
-- Does NOT take the global election_day_voter_allocation_mutation advisory
-- lock added (in the same final-hardening pass) to election_day_import_voters
-- and the 3 business RPCs in part B - audited explicitly: this function
-- never reads or writes election_day_voters at all, only
-- election_day_coordinators, via the row-level FOR UPDATE locks already
-- taken above - which already serializes it against those 3 business RPCs'
-- own coordinator-row locks on any coordinator id this batch touches. It
-- therefore cannot race the import/allocation domain the global lock exists
-- to protect, and adding it here would only add unnecessary contention with
-- no correctness benefit.
begin;

-- ============================================================================
-- 1. election_day_coordinator_participated - true once a coordinator entity
-- has been referenced by any recorded operation (as an operation_items
-- from/to, or as an operations row's subject - i.e. it has ended). Used to
-- lock link/unlink/relink once a coordinator's assignment identity has
-- actually been relied upon by history, per the approved design (section 6
-- of the Phase 3 spec) - this is a per-coordinator gate, distinct from
-- election_day_has_allocation_activity()'s global "has ANY operation ever
-- happened" gate used for add/edit/remove.
-- ============================================================================
create or replace function public.election_day_coordinator_participated(p_coordinator_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select
    exists (
      select 1 from public.election_day_coordinator_operation_items i
      where i.from_coordinator_id = p_coordinator_id
         or i.to_coordinator_id = p_coordinator_id
    )
    or exists (
      select 1 from public.election_day_coordinator_operations o
      where o.subject_coordinator_id = p_coordinator_id
    );
$$;

comment on function public.election_day_coordinator_participated(uuid) is
  'Coordinator Allocation Management: true once a coordinator entity has been referenced by any recorded operation (moved voters in either direction, or ended). Gates link/unlink/relink (per-coordinator lock), distinct from election_day_has_allocation_activity()''s global gate used for edit/remove. security definer so it can read the RLS-enabled-zero-policy coordinator_operations/operation_items tables, same reasoning as election_day_has_allocation_activity(). Reveals only a boolean, not any audit row content.';

revoke all on function public.election_day_coordinator_participated(uuid) from public, anon, authenticated;
grant execute on function public.election_day_coordinator_participated(uuid) to anon, authenticated;

-- ============================================================================
-- 2. election_day_manage_coordinators - atomic batch of add/edit/remove/
-- link/unlink/relink actions. One re-auth, one permission check, one
-- transaction (the function body itself), all-or-nothing: any single action
-- failing raises a stable error that aborts the whole call, so the caller
-- never has to reconcile a partially-applied batch.
--
-- p_actions is a jsonb array, each element shaped:
--   {"action": "add",    "display_name": "..."}
--   {"action": "edit",   "coordinator_id": "...", "display_name": "..."}
--   {"action": "remove", "coordinator_id": "..."}
--   {"action": "link",   "coordinator_id": "...", "linked_assignment_name": "..."}
--   {"action": "relink", "coordinator_id": "...", "linked_assignment_name": "..."}
--   {"action": "unlink", "coordinator_id": "..."}
--
-- Locking: every coordinator_id referenced anywhere in the batch is locked
-- FOR UPDATE up front, in a single ascending-id-ordered pass, before any
-- action is processed - a stable lock order across the whole batch (and
-- consistent with the same "lock by id ascending" discipline part B's
-- rebalance/end RPCs use), so a concurrent batch/rebalance/end call touching
-- an overlapping set of coordinators can never deadlock against this one.
-- Every status/participation check below reads state only after this lock,
-- never a pre-lock snapshot.
--
-- Cross-column ownership invariant (locked design, section 5 of the Phase 3
-- spec): in addition to the two existing partial/full unique indexes on
-- election_day_coordinators (active-only unique display_name, all-status
-- unique linked_assignment_name), this RPC explicitly rejects a proposed
-- display_name that collides with ANOTHER coordinator's linked_assignment_name
-- (any status - a linked string's ownership must never become ambiguous even
-- after the linking entity ends), and a proposed linked_assignment_name that
-- collides with another ACTIVE coordinator's display_name (matching the
-- existing index's own active-only scope - a display name is free to be
-- reused once its previous holder has ended). Same-row equality (a
-- coordinator's own display_name equal to its own linked_assignment_name) is
-- allowed - every check below excludes the row being modified.
--
-- Global activity gate (election_day_has_allocation_activity - unchanged
-- from Phase 2, not touched here): edit display_name and remove are blocked
-- once ANY operation has ever been recorded (DISPLAY_NAME_LOCKED /
-- COORDINATOR_LOCKED); add remains allowed always (a mid-day new coordinator
-- is a normal event). link/unlink/relink are instead gated per-coordinator
-- by election_day_coordinator_participated above, not by the global flag.
create or replace function public.election_day_manage_coordinators(
  p_actor_id uuid,
  p_actor_password text,
  p_actions jsonb
)
returns setof public.election_day_coordinators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_password_hash text;
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_permission boolean;
  v_lock_ids uuid[];
  v_action jsonb;
  v_action_type text;
  v_coordinator_id uuid;
  v_display_name text;
  v_linked_name text;
  v_existing_linked_name text;
begin
  -- 1. Re-authenticate the actor (identical pattern to
  -- election_day_reset_permission_user_password).
  select u.password_hash, u.role_id, u.name
    into v_actor_password_hash, v_actor_role_id, v_actor_name
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- 2. Verify the actor's role holds electionDay.manageCoordinatorAllocation.
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

  -- 5. Return the full current coordinator roster - small (a handful to a
  -- few dozen rows per election day), enough for the future Phase 4 UI to
  -- refresh its whole view from a single response with no extra round trip.
  return query select * from public.election_day_coordinators order by created_at asc, id asc;
end;
$$;

comment on function public.election_day_manage_coordinators(uuid, text, jsonb) is
  'Coordinator Allocation Management: atomic batch of add/edit/remove/link/unlink/relink actions on election_day_coordinators. Re-authenticates the actor (bcrypt) and requires electionDay.manageCoordinatorAllocation before any mutation, mirroring election_day_reset_permission_user_password''s pattern. One transaction, all-or-nothing. edit display_name/remove are blocked once any coordinator_operations row exists (DISPLAY_NAME_LOCKED / COORDINATOR_LOCKED); link/unlink/relink are blocked per-coordinator once that entity has participated in any operation (COORDINATOR_LOCKED, via election_day_coordinator_participated). Enforces the cross-column ownership invariant: a proposed display_name may never equal another coordinator''s linked_assignment_name, and a proposed linked_assignment_name may never equal another ACTIVE coordinator''s display_name (COORDINATOR_NAME_COLLISION), nor an assignment string already linked elsewhere (ASSIGNMENT_ALREADY_LINKED). Returns the full current coordinator roster.';

revoke all on function public.election_day_manage_coordinators(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_manage_coordinators(uuid, text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_manage_coordinators(uuid, text, jsonb);
--   drop function if exists public.election_day_coordinator_participated(uuid);
--   commit;
-- ============================================================================
