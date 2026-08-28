-- Phase 3C Roles - legacy v2 workspace containment ONLY. See CURRENT_STATUS.md's
-- Phase 3C Roles pre-containment audit entry for the full finding this
-- migration responds to.
--
-- ROOT ISSUE (found in a read-only planning pass, confirmed by direct code
-- inspection and a live Production data audit - not a live exploit):
-- election_day_create_role_v2 / _update_role_v2 / _delete_role_v2 /
-- _clone_role_v2 (all current, anon/authenticated-reachable via the shared
-- legacy general-purpose reauth proof) perform ZERO workspace derivation or
-- scoping. create/clone never write workspace_id on INSERT (it is simply
-- left NULL - the column has no default and no trigger, confirmed via a live
-- Production schema audit); update/delete/clone look up p_role_id with a
-- bare `id = ...` predicate, with no check that the target belongs to the
-- calling actor's own workspace. This is the exact same defect class the
-- Phase 3C Users containment migration (20260828000000) found and fixed for
-- election_day_delete_permission_user_v2 / _reset_permission_user_password_v2
-- - not yet exploitable in Production (exactly one workspace exists today,
-- confirmed live: 5/5 election_day_roles rows carry that one workspace_id,
-- zero NULL, zero PermissionUser<->Role workspace mismatches, zero orphan
-- role references - see the pre-containment audit), but structurally
-- identical, and left open it would become a live cross-tenant privilege
-- path the moment a second workspace is ever provisioned.
--
-- CREATE OR REPLACE, in place, of the 4 EXISTING _v2 role RPCs - same names,
-- same signatures, same grants (ACL unchanged by this update - CREATE OR
-- REPLACE FUNCTION does not alter an existing function's privileges), same
-- legacy proof mechanism (election_day_verify_reauth_proof, action IS NULL,
-- untouched by this migration) - every legitimate same-workspace legacy
-- caller (the only live frontend path today) keeps working with zero
-- code/contract change. Adds, uniformly across all 4:
--   1. actor workspace derived server-side - a second lookup on
--      election_day_permission_users keyed by the proof-resolved actor_id
--      (the legacy verifier itself has no workspace column to return, so
--      this cannot be folded into that shared helper without touching the
--      other 9 legacy actions that also call it - out of scope here, exactly
--      as it was for the Users containment migration).
--   2. (update/delete/clone) target existence + workspace-membership
--      collapsed into ONE check, raising the SAME ROLE_NOT_FOUND for "id
--      doesn't exist" and "id exists in a different workspace" - never
--      distinguishable. Mirrors the Users containment migration's own
--      USER_NOT_FOUND pattern exactly.
--   3. (create only) an explicit ACTOR_WORKSPACE_REQUIRED guard - a create
--      has no target row to naturally fail closed against the way
--      update/delete/clone's own workspace-scoped lookup already does (a
--      NULL v_actor_workspace_id there makes the `v_target_workspace_id IS
--      DISTINCT FROM v_actor_workspace_id` comparison true for any real,
--      non-null target, so those three already fail closed to ROLE_NOT_FOUND
--      with no separate check needed). NOTE: this is a REACHABLE case today,
--      not purely theoretical - election_day_create_permission_user_v2 (the
--      still-live legacy account-creation RPC, untouched by this migration)
--      itself never writes workspace_id either, so a PermissionUser account
--      created today via that path would have workspace_id = NULL and would
--      hit this exact guard on create, and ROLE_NOT_FOUND on
--      update/delete/clone, until a separate fix for that RPC lands (out of
--      scope here).
--   4. (create/clone only) workspace_id is now written explicitly on INSERT
--      - the ACTING CALLER'S OWN server-derived workspace_id, never a
--      client-supplied value and, for clone specifically, never copied from
--      the source role's own workspace_id either (even though at the point
--      of insertion they are already known to match, per the containment
--      check above) - the acting caller's own workspace is the correct
--      authority for where a new row lands, by explicit design decision.
--
-- NOT the final product authorization model. electionDay.manageRolesAndPermissions
-- remains the only permission gate, exactly as today - preserved unchanged,
-- not touched, not tightened, not loosened by this migration. A holder of
-- this permission can still grant it to an arbitrary role (including a role
-- assigned to themselves), i.e. self-escalation within one workspace is NOT
-- addressed by this migration and remains a known, open gap - see
-- CURRENT_STATUS.md for the full record. Owner-only role-management
-- authority (the intended eventual product model) is a separate,
-- not-yet-designed architectural decision, deliberately out of scope here.
--
-- Deliberately NOT changed by this migration (tracked, not silently
-- dropped - see CURRENT_STATUS.md for the full record of each):
--   1. election_day_roles.name stays a GLOBAL `UNIQUE(name)` constraint, not
--      `UNIQUE(workspace_id, name)` - safe today (a live Production audit
--      found zero (workspace_id, name) collisions among the 5 existing
--      roles), but must be revisited before a second workspace with a
--      colliding role name can be safely provisioned.
--   2. No composite FK from election_day_permission_users(role_id,
--      workspace_id) to election_day_roles(id, workspace_id) exists - a
--      cross-workspace PermissionUser<->Role assignment is prevented only by
--      application logic (this migration's own new checks, plus the
--      existing create/reset-user RPCs' own scoping) and by currently-clean
--      data, not by the schema itself.
--   3. election_day_list_roles() remains global/unscoped, anon/authenticated
--      -reachable, with no caller-identity check of any kind - must be
--      replaced (a session-scoped v3 equivalent) and/or retired before a
--      second workspace is ever provisioned, or it will leak every
--      workspace's full role catalog to any anon-key holder.
--   4. election_day_verify_reauth_proof itself is untouched (still the
--      Phase 3C-fixed, action-IS-NULL-only version). The other 9 legacy
--      reauth-gated actions (import, coordinator allocation x4, Users x4 -
--      already separately containment-hardened and cut over) are untouched.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

-- ============================================================================
-- 1. election_day_create_role_v2 (containment).
-- ============================================================================
create or replace function public.election_day_create_role_v2(
  p_reauth_proof text,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_id uuid;
begin
  select v.actor_id, v.role_id into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
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

  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id)
  values (
    btrim(p_name),
    coalesce(p_description, ''),
    coalesce(p_permissions, '{}'),
    p_scope_type,
    v_actor_workspace_id
  )
  returning public.election_day_roles.id into v_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_role_v2(text, text, text, text[], text) is
  'Security Phase 1 + Phase 3C containment: proof-based, permission-checked, WORKSPACE-SCOPED create. Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side (second lookup, the legacy proof verifier has no workspace column) and requires it to be non-null (ACTOR_WORKSPACE_REQUIRED - a real, reachable state for a PermissionUser created via the still-live legacy election_day_create_permission_user_v2, which itself never writes workspace_id), and writes the new role''s workspace_id as the actor''s own, server-derived value (previously always NULL). Business validation (election_day_validate_role_input) unchanged from the pre-containment version. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any actor with a valid workspace.';

-- ============================================================================
-- 2. election_day_update_role_v2 (containment).
-- ============================================================================
create or replace function public.election_day_update_role_v2(
  p_reauth_proof text,
  p_role_id uuid,
  p_name text,
  p_description text,
  p_permissions text[],
  p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
  v_had_capability boolean;
  v_will_have_capability boolean;
  v_remaining_holders integer;
begin
  select v.actor_id, v.role_id into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);
  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, per the containment requirement. Also correctly
  -- rejects a NULL v_actor_workspace_id (no legitimate target can ever have
  -- a NULL workspace_id match it, since "IS DISTINCT FROM" treats two NULLs
  -- as not-distinct only when BOTH sides are NULL, which would require an
  -- already-invalid NULL-workspace role to exist - a state this migration's
  -- own create/clone fixes prevent going forward).
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_had_capability
  from public.election_day_roles r where r.id = p_role_id;

  v_will_have_capability := ('electionDay.manageRolesAndPermissions' = any(coalesce(p_permissions, '{}')));

  if v_had_capability and not v_will_have_capability then
    -- WORKSPACE-SCOPED as of Phase 3C: a holder of manageRolesAndPermissions
    -- in a DIFFERENT workspace must never count as a "remaining holder" for
    -- THIS workspace's last-holder guard.
    select count(*) into v_remaining_holders
    from public.election_day_permission_users pu
    join public.election_day_roles r on r.id = pu.role_id
    where pu.role_id <> p_role_id
      and r.workspace_id = v_actor_workspace_id
      and 'electionDay.manageRolesAndPermissions' = any(r.permissions);

    if v_remaining_holders = 0 then
      raise exception 'CANNOT_REMOVE_LAST_PERMISSION_HOLDER';
    end if;
  end if;

  update public.election_day_roles as r
  set name = btrim(p_name),
      description = coalesce(p_description, ''),
      permissions = coalesce(p_permissions, '{}'),
      scope_type = p_scope_type
  where r.id = p_role_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = p_role_id;
end;
$$;

comment on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) is
  'Security Phase 1 + Phase 3C containment: proof-based, permission-checked, WORKSPACE-SCOPED update. Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side and rejects a target role outside that workspace with the SAME ROLE_NOT_FOUND already used for a nonexistent id (never distinguishable). The CANNOT_REMOVE_LAST_PERMISSION_HOLDER guard''s remaining-holder count is now scoped to r.workspace_id = the actor''s own workspace - a holder in a different workspace can no longer mask the last holder in THIS workspace. Business logic (election_day_validate_role_input, the same pg_advisory_xact_lock serializing concurrent role edits) unchanged from the pre-containment version. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any legitimate same-workspace target.';

-- ============================================================================
-- 3. election_day_delete_role_v2 (containment).
-- ============================================================================
create or replace function public.election_day_delete_role_v2(
  p_reauth_proof text,
  p_role_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
  v_assigned_count integer;
  v_had_capability boolean;
  v_remaining_holders integer;
begin
  select v.actor_id, v.role_id into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, per the containment requirement.
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  -- WORKSPACE-SCOPED as of Phase 3C: an assigned user in a DIFFERENT
  -- workspace must never block a delete in THIS workspace (defense in
  -- depth - today every PermissionUser's own workspace_id already matches
  -- their role's, per the pre-containment Production data audit, but that
  -- invariant is not schema-enforced, see this migration's own header).
  select count(*) into v_assigned_count
  from public.election_day_permission_users
  where role_id = p_role_id
    and workspace_id = v_actor_workspace_id;

  if v_assigned_count > 0 then
    raise exception 'ROLE_HAS_ASSIGNED_USERS';
  end if;

  select ('electionDay.manageRolesAndPermissions' = any(permissions)) into v_had_capability
  from public.election_day_roles where id = p_role_id;

  if v_had_capability then
    -- WORKSPACE-SCOPED as of Phase 3C - same reasoning as the update RPC's
    -- own remaining-holder count above.
    select count(*) into v_remaining_holders
    from public.election_day_permission_users pu
    join public.election_day_roles r on r.id = pu.role_id
    where pu.role_id <> p_role_id
      and r.workspace_id = v_actor_workspace_id
      and 'electionDay.manageRolesAndPermissions' = any(r.permissions);

    if v_remaining_holders = 0 then
      raise exception 'CANNOT_REMOVE_LAST_PERMISSION_HOLDER';
    end if;
  end if;

  delete from public.election_day_roles where id = p_role_id;
end;
$$;

comment on function public.election_day_delete_role_v2(text, uuid) is
  'Security Phase 1 + Phase 3C containment: proof-based, permission-checked, WORKSPACE-SCOPED delete. Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side and rejects a target role outside that workspace with the SAME ROLE_NOT_FOUND already used for a nonexistent id. Both the ROLE_HAS_ASSIGNED_USERS check and the CANNOT_REMOVE_LAST_PERMISSION_HOLDER remaining-holder count are now scoped to the actor''s own workspace_id. Business logic (the same pg_advisory_xact_lock serializing concurrent role edits) unchanged from the pre-containment version. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any legitimate same-workspace target.';

-- ============================================================================
-- 4. election_day_clone_role_v2 (containment).
-- ============================================================================
create or replace function public.election_day_clone_role_v2(
  p_reauth_proof text,
  p_role_id uuid,
  p_new_name text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_role_id uuid;
  v_actor_workspace_id uuid;
  v_has_permission boolean;
  v_target_workspace_id uuid;
  v_new_id uuid;
begin
  select v.actor_id, v.role_id into v_actor_id, v_actor_role_id
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  select u.workspace_id into v_actor_workspace_id
  from public.election_day_permission_users u
  where u.id = v_actor_id;

  if p_new_name is null or btrim(p_new_name) = '' then
    raise exception 'ROLE_NAME_REQUIRED';
  end if;

  select r.workspace_id into v_target_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id;

  -- Same error for "doesn't exist" and "exists in a different workspace" -
  -- never distinguishable, per the containment requirement. Also correctly
  -- rejects a NULL v_actor_workspace_id (see the update RPC's own inline
  -- comment above for the exact reasoning).
  if v_target_workspace_id is null
     or v_target_workspace_id is distinct from v_actor_workspace_id
  then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  -- workspace_id is the ACTING CALLER'S OWN server-derived value, never
  -- copied from the source role's own workspace_id (r.workspace_id) even
  -- though the check above already guarantees they match at this point -
  -- the acting caller's own workspace is the correct authority for where a
  -- new row lands, by explicit design decision, not the source row's.
  insert into public.election_day_roles (name, description, permissions, scope_type, scope_value, workspace_id)
  select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value, v_actor_workspace_id
  from public.election_day_roles r
  where r.id = p_role_id
  returning public.election_day_roles.id into v_new_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_new_id;
end;
$$;

comment on function public.election_day_clone_role_v2(text, uuid, text) is
  'Security Phase 1 + Phase 3C containment: proof-based, permission-checked, WORKSPACE-SCOPED clone. Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. As of Phase 3C: derives the actor''s own workspace_id server-side, rejects a source role outside that workspace with the SAME ROLE_NOT_FOUND already used for a nonexistent id, and writes the cloned row''s workspace_id as the actor''s own server-derived value (previously always NULL) - never copied from the source role''s own workspace_id, even though by construction they already match. Business logic (ROLE_NAME_REQUIRED) unchanged from the pre-containment version. Same name/signature/grants as before - fully compatible with the existing legacy frontend call for any legitimate same-workspace source.';

commit;

-- ============================================================================
-- ROLLBACK (manual, restores the PRE-Phase-3C-Roles behavior - no workspace
-- derivation/scoping of any kind, workspace_id left NULL on create/clone -
-- only do this if a legitimate need to revert is identified; functions were
-- never dropped, so this is the only step needed):
--
--   begin;
--
--   create or replace function public.election_day_create_role_v2(
--     p_reauth_proof text, p_name text, p_description text,
--     p_permissions text[], p_scope_type text
--   )
--   returns table (
--     id uuid, name text, description text, permissions text[],
--     scope_type text, scope_value jsonb
--   )
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid; v_has_permission boolean; v_id uuid;
--   begin
--     select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;
--     select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);
--     insert into public.election_day_roles (name, description, permissions, scope_type)
--     values (btrim(p_name), coalesce(p_description, ''), coalesce(p_permissions, '{}'), p_scope_type)
--     returning public.election_day_roles.id into v_id;
--     return query select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
--     from public.election_day_roles r where r.id = v_id;
--   end;
--   $$;
--
--   create or replace function public.election_day_update_role_v2(
--     p_reauth_proof text, p_role_id uuid, p_name text, p_description text,
--     p_permissions text[], p_scope_type text
--   )
--   returns table (
--     id uuid, name text, description text, permissions text[],
--     scope_type text, scope_value jsonb
--   )
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid; v_has_permission boolean;
--     v_had_capability boolean; v_will_have_capability boolean; v_remaining_holders integer;
--   begin
--     select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;
--     select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);
--     perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);
--     if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
--       raise exception 'ROLE_NOT_FOUND';
--     end if;
--     select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_had_capability
--     from public.election_day_roles r where r.id = p_role_id;
--     v_will_have_capability := ('electionDay.manageRolesAndPermissions' = any(coalesce(p_permissions, '{}')));
--     if v_had_capability and not v_will_have_capability then
--       select count(*) into v_remaining_holders
--       from public.election_day_permission_users pu
--       join public.election_day_roles r on r.id = pu.role_id
--       where pu.role_id <> p_role_id and 'electionDay.manageRolesAndPermissions' = any(r.permissions);
--       if v_remaining_holders = 0 then raise exception 'CANNOT_REMOVE_LAST_PERMISSION_HOLDER'; end if;
--     end if;
--     update public.election_day_roles as r
--     set name = btrim(p_name), description = coalesce(p_description, ''),
--         permissions = coalesce(p_permissions, '{}'), scope_type = p_scope_type
--     where r.id = p_role_id;
--     return query select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
--     from public.election_day_roles r where r.id = p_role_id;
--   end;
--   $$;
--
--   create or replace function public.election_day_delete_role_v2(
--     p_reauth_proof text, p_role_id uuid
--   )
--   returns void language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid; v_has_permission boolean; v_assigned_count integer;
--     v_had_capability boolean; v_remaining_holders integer;
--   begin
--     select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;
--     select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);
--     if not exists (select 1 from public.election_day_roles where id = p_role_id) then
--       raise exception 'ROLE_NOT_FOUND';
--     end if;
--     select count(*) into v_assigned_count from public.election_day_permission_users where role_id = p_role_id;
--     if v_assigned_count > 0 then raise exception 'ROLE_HAS_ASSIGNED_USERS'; end if;
--     select ('electionDay.manageRolesAndPermissions' = any(permissions)) into v_had_capability
--     from public.election_day_roles where id = p_role_id;
--     if v_had_capability then
--       select count(*) into v_remaining_holders
--       from public.election_day_permission_users pu
--       join public.election_day_roles r on r.id = pu.role_id
--       where pu.role_id <> p_role_id and 'electionDay.manageRolesAndPermissions' = any(r.permissions);
--       if v_remaining_holders = 0 then raise exception 'CANNOT_REMOVE_LAST_PERMISSION_HOLDER'; end if;
--     end if;
--     delete from public.election_day_roles where id = p_role_id;
--   end;
--   $$;
--
--   create or replace function public.election_day_clone_role_v2(
--     p_reauth_proof text, p_role_id uuid, p_new_name text
--   )
--   returns table (
--     id uuid, name text, description text, permissions text[],
--     scope_type text, scope_value jsonb
--   )
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare
--     v_actor_role_id uuid; v_has_permission boolean; v_new_id uuid;
--   begin
--     select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;
--     select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
--     from public.election_day_roles r where r.id = v_actor_role_id;
--     if v_has_permission is not true then raise exception 'FORBIDDEN'; end if;
--     if p_new_name is null or btrim(p_new_name) = '' then raise exception 'ROLE_NAME_REQUIRED'; end if;
--     if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
--       raise exception 'ROLE_NOT_FOUND';
--     end if;
--     insert into public.election_day_roles (name, description, permissions, scope_type, scope_value)
--     select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value
--     from public.election_day_roles r where r.id = p_role_id
--     returning public.election_day_roles.id into v_new_id;
--     return query select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
--     from public.election_day_roles r where r.id = v_new_id;
--   end;
--   $$;
--
--   commit;
-- ============================================================================
