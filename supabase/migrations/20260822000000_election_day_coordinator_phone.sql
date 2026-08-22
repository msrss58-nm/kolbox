-- Coordinator Phone / Direct Call (approved 2026-08-22): adds an OPTIONAL
-- phone number to the coordinator entity so a manager can call a coordinator
-- directly from the Dashboard Reminder Supervision detail modal.
--
-- Phone is CONTACT METADATA, not identity - it deliberately never
-- participates in any of the identity/safety rules the previous migration
-- (20260821030000) established: not in the display_name/linked_assignment_name
-- collision check, not in the safe-edit/safe-remove guards, and never matched
-- against election_day_permission_users.name. A coordinator's phone stays
-- editable even when rename/remove are blocked by participation, assigned
-- voters, or a login account, because none of those risks apply to a plain
-- contact field.
--
-- Layered on top of 20260821030000 as a NEW migration rather than amending
-- it - that file is the closed, already-verified identity-safety record;
-- this one is a genuinely separate, unrelated concern (contact info, not
-- identity), so it gets its own CREATE OR REPLACE here instead of growing
-- an unrelated diff into an already-reviewed file.
--
-- RPC surface: `election_day_manage_coordinators_v2`'s `add` action gains an
-- optional `phone` field (normalized/validated the same way as every other
-- phone in this app - reusing electionDayImport.ts/lib/phone.ts's own
-- normalizeIsraeliPhone/isValidIsraeliPhone convention, reimplemented here in
-- SQL since PL/pgSQL cannot import that module). A NEW `update_phone` action
-- is added rather than overloading `edit` - `edit` is now strictly
-- identity/display-name mutation with the full safety-guard chain above, and
-- phone must remain editable after participation/history/assigned-voters/
-- login-account locks, which `edit` deliberately refuses. `update_phone`
-- touches ONLY the phone column - never display_name/status/
-- linked_assignment_name - and carries no participation/collision/lock
-- checks of any kind, by design.
--
-- Everything else (signature, reauth/permission gate, SECURITY DEFINER,
-- search_path hardening, the shared election_day_voter_allocation_mutation
-- advisory lock, the per-batch row-locking pass, add/edit/remove/link/relink/
-- unlink behavior) is unchanged from 20260821030000.
begin;

alter table public.election_day_coordinators
  add column phone text;

comment on column public.election_day_coordinators.phone is
  'Optional contact phone for this coordinator (normalized local Israeli format, e.g. 0501234567) - pure contact metadata, never part of any identity/collision/safety rule. NULL until a manager sets one.';

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
  v_phone_raw text;
  v_phone_digits text;
  v_phone_normalized text;
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

      insert into public.election_day_coordinators (display_name, phone)
      values (v_display_name, v_phone_normalized);

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

    elsif v_action_type = 'update_phone' then
      -- Phone is CONTACT METADATA, not identity: deliberately NO
      -- participation/history check, NO assigned-voters check, NO login-
      -- account check, NO status restriction (works for active or ended
      -- alike) - none of the risks those guards exist for (orphaning a
      -- voter/login match on a rewritten display_name) apply to a plain
      -- phone field. Touches only the phone column.
      if v_coordinator_id is null then
        raise exception 'COORDINATOR_NOT_FOUND';
      end if;

      if not exists (select 1 from public.election_day_coordinators where id = v_coordinator_id) then
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
        -- empty/blank input clears the phone to NULL, same convention as
        -- every nullif(btrim(...), '') field elsewhere in this function.
        v_phone_normalized := null;
      end if;

      update public.election_day_coordinators
      set phone = v_phone_normalized
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
  'Coordinator identity invariant (2026-08-21) plus optional contact phone (2026-08-22): proof-based, live-permission-checked. Resolves the actor via election_day_verify_reauth_proof and requires electionDay.manageCoordinatorAllocation on the actor''s CURRENT role before any mutation, then the global election_day_voter_allocation_mutation advisory lock. add rejects any display_name matching an existing coordinator''s display_name/linked_assignment_name in any status, and accepts an optional normalized+validated phone. edit/remove are gated on: NOT election_day_coordinator_participated(id) AND NOT EXISTS a voter matching the coordinator''s current display_name/linked_assignment_name AND NOT EXISTS a election_day_permission_users.name matching either. update_phone is a new, deliberately UNGUARDED action (no identity/participation/status checks) that touches only the phone column - phone is contact metadata, not identity, and must stay editable after any identity lock. link/relink/unlink are unchanged. Return contract unchanged (full coordinator roster, now including phone).';

revoke all on function public.election_day_manage_coordinators_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_manage_coordinators_v2(text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   -- Re-run the CREATE OR REPLACE from 20260821030000's own body to
--   -- restore the pre-phone definition (no phone column read/written, no
--   -- update_phone action).
--   alter table public.election_day_coordinators drop column phone;
--   commit;
-- ============================================================================
