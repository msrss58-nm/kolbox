-- Dynamic Roles & Permissions - Phase 2: real role management (create /
-- update / delete / clone a role) plus creating a PermissionUser against an
-- arbitrary role_id instead of only the 3 legacy checkboxes.
--
-- Session resolution itself (Phase 1) is updated alongside this migration to
-- match a session against its role_id directly (`resolveSessionRole.ts`),
-- not its legacy role text - required because a dynamic-role user created
-- here always has role = null (no legacy text equivalent), and matching by
-- legacy text alone would either fail to resolve such a session or, worse,
-- mis-resolve it against the first coincidentally-null-legacy-key row.
-- role_id has been NOT NULL on every row (legacy or dynamic) since Phase 0,
-- so this is a strictly more correct single resolution path, not a
-- dual-path special case.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project (see election_day_dynamic_roles_phase0 /
-- election_day_list_roles_rpc): the Supabase CLI's migration runner
-- pipelines a file's statements, it does not implicitly wrap them in a
-- transaction.
begin;

-- ============================================================================
-- Shared validation helpers
-- ============================================================================

-- Permissions allowlist mirrored from src/permissions/permissionsMap.ts's
-- ALL_PERMISSIONS - the DB-side trust boundary for election_day_create_role/
-- election_day_update_role, which (unlike Phase 0's migration-only insert)
-- accept arbitrary caller-supplied permission arrays. An unrecognized
-- permission string is rejected outright (raises), never silently dropped -
-- unlike normalizeRoleRecord's read-path leniency, a write-path validation
-- failure should be loud, not silent.
create or replace function public.election_day_is_valid_permission(p_permission text)
returns boolean
language sql
immutable
as $$
  select p_permission = any(array[
    'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
    'electionDay.manageUsers', 'electionDay.manageRideCoordinators', 'electionDay.manageRolesAndPermissions',
    'app.accessFullNavigation',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
  ]);
$$;

comment on function public.election_day_is_valid_permission(text) is
  'Dynamic Roles & Permissions Phase 2: DB-side mirror of ALL_PERMISSIONS (src/permissions/permissionsMap.ts) - the write-path trust boundary for role create/update, which accept arbitrary caller-supplied permission arrays unlike Phase 0''s migration-only seed insert.';

-- Internal helper only - never called directly by the client, only from
-- within election_day_validate_role_input/create_role/update_role (all of
-- which run as SECURITY DEFINER). A nested call made from inside a SECURITY
-- DEFINER function checks EXECUTE privilege against that function's OWNER,
-- not the original anon/authenticated caller, so no anon/authenticated
-- grant is needed here. Revoking only `from public` is NOT sufficient on
-- this Supabase project: its default privileges already grant EXECUTE on
-- every new public-schema function directly to `anon`/`authenticated` (not
-- merely via PUBLIC), so `anon`/`authenticated` must be revoked explicitly
-- too, or they retain direct callability regardless of the PUBLIC grant -
-- confirmed live (see CURRENT_STATUS.md's Phase 2 entry).
revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;

-- Shared validation - raises on the first invalid input found. Reused by
-- create/update (clone never accepts caller-supplied name/permissions/scope
-- beyond a new name, so it validates only that separately).
create or replace function public.election_day_validate_role_input(
  p_name text, p_permissions text[], p_scope_type text
)
returns void
language plpgsql
as $$
declare
  v_permission text;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'ROLE_NAME_REQUIRED';
  end if;
  if p_scope_type not in ('all', 'assigned_to_me') then
    raise exception 'INVALID_SCOPE_TYPE';
  end if;
  foreach v_permission in array coalesce(p_permissions, '{}')
  loop
    if not public.election_day_is_valid_permission(v_permission) then
      raise exception 'INVALID_PERMISSION: %', v_permission;
    end if;
  end loop;
end;
$$;

-- Internal helper only - never called directly by the client, only from
-- within election_day_create_role/update_role (both SECURITY DEFINER) -
-- same reasoning (and same `anon, authenticated` requirement) as
-- election_day_is_valid_permission's revoke above.
revoke all on function public.election_day_validate_role_input(text, text[], text) from public, anon, authenticated;

-- ============================================================================
-- election_day_create_role - no capability-guard restriction (approved
-- product decision: adding a role can never reduce anyone's existing
-- access).
-- ============================================================================
create or replace function public.election_day_create_role(
  p_name text, p_description text, p_permissions text[], p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb, legacy_role_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  insert into public.election_day_roles (name, description, permissions, scope_type, legacy_role_key)
  values (btrim(p_name), coalesce(p_description, ''), coalesce(p_permissions, '{}'), p_scope_type, null)
  returning public.election_day_roles.id into v_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.legacy_role_key
    from public.election_day_roles r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_role(text, text, text[], text) is
  'Dynamic Roles & Permissions Phase 2: creates a new, fully editable role (legacy_role_key always null). No capability-guard restriction - adding a role can never reduce anyone''s existing access.';

revoke all on function public.election_day_create_role(text, text, text[], text) from public;
grant execute on function public.election_day_create_role(text, text, text[], text) to anon, authenticated;

-- ============================================================================
-- election_day_update_role - approved product decision: if this update
-- would REMOVE electionDay.manageRolesAndPermissions from a role, at least
-- one user OTHER than one assigned to THIS role must remain actually-
-- assigned to some role that still holds it - checked against real assigned
-- users, never merely a role's existence. pg_advisory_xact_lock serializes
-- concurrent update/delete-role calls against this same guard so two
-- simultaneous edits can't both pass the check and jointly leave zero
-- holders; the lock is scoped to this transaction (the whole RPC call) and
-- released automatically when it ends.
-- ============================================================================
create or replace function public.election_day_update_role(
  p_role_id uuid, p_name text, p_description text, p_permissions text[], p_scope_type text
)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb, legacy_role_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_had_capability boolean;
  v_will_have_capability boolean;
  v_remaining_holders integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);
  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  -- Every bare column reference below is explicitly aliased (`r.id`,
  -- `r.permissions`) rather than left bare - this function's own
  -- `returns table (id, ..., permissions, ...)` introduces PL/pgSQL
  -- variables of those exact names in scope for the whole function body,
  -- so an unaliased `id`/`permissions` in a query is ambiguous between the
  -- table column and the output variable (caught live: "column reference
  -- \"id\" is ambiguous").
  if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_had_capability
  from public.election_day_roles r where r.id = p_role_id;

  v_will_have_capability := ('electionDay.manageRolesAndPermissions' = any(coalesce(p_permissions, '{}')));

  if v_had_capability and not v_will_have_capability then
    select count(*) into v_remaining_holders
    from public.election_day_permission_users pu
    join public.election_day_roles r on r.id = pu.role_id
    where pu.role_id <> p_role_id
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
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.legacy_role_key
    from public.election_day_roles r
    where r.id = p_role_id;
end;
$$;

comment on function public.election_day_update_role(uuid, text, text, text[], text) is
  'Dynamic Roles & Permissions Phase 2: edits an existing role''s name/description/permissions/scope. Enforces (checked against actually-assigned users, not role existence): removing electionDay.manageRolesAndPermissions from this role is rejected (CANNOT_REMOVE_LAST_PERMISSION_HOLDER) if it would leave zero users anywhere holding that capability. legacy_role_key is never writable through this RPC.';

revoke all on function public.election_day_update_role(uuid, text, text, text[], text) from public;
grant execute on function public.election_day_update_role(uuid, text, text, text[], text) to anon, authenticated;

-- ============================================================================
-- election_day_delete_role - a role with any assigned users is already
-- unconditionally blocked at the FK level (Phase 0's `on delete restrict`);
-- this RPC checks the same condition itself first so the caller gets a
-- clear ROLE_HAS_ASSIGNED_USERS error instead of a raw
-- foreign_key_violation. The manageRolesAndPermissions guard is additionally
-- checked exactly like update_role's (same advisory lock) for defense in
-- depth, even though in practice a role reaching the delete path already has
-- zero assigned users by the check above.
-- ============================================================================
create or replace function public.election_day_delete_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assigned_count integer;
  v_had_capability boolean;
  v_remaining_holders integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);

  if not exists (select 1 from public.election_day_roles where id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  select count(*) into v_assigned_count
  from public.election_day_permission_users
  where role_id = p_role_id;

  if v_assigned_count > 0 then
    raise exception 'ROLE_HAS_ASSIGNED_USERS';
  end if;

  select ('electionDay.manageRolesAndPermissions' = any(permissions)) into v_had_capability
  from public.election_day_roles where id = p_role_id;

  if v_had_capability then
    select count(*) into v_remaining_holders
    from public.election_day_permission_users pu
    join public.election_day_roles r on r.id = pu.role_id
    where pu.role_id <> p_role_id
      and 'electionDay.manageRolesAndPermissions' = any(r.permissions);

    if v_remaining_holders = 0 then
      raise exception 'CANNOT_REMOVE_LAST_PERMISSION_HOLDER';
    end if;
  end if;

  delete from public.election_day_roles where id = p_role_id;
end;
$$;

comment on function public.election_day_delete_role(uuid) is
  'Dynamic Roles & Permissions Phase 2: deletes a role. Rejects (ROLE_HAS_ASSIGNED_USERS) if any user is currently assigned to it - the FK (ON DELETE RESTRICT, Phase 0) is the unbreakable backstop, this check just gives a friendlier error first. Also rejects (CANNOT_REMOVE_LAST_PERMISSION_HOLDER) if deleting a role holding electionDay.manageRolesAndPermissions would leave zero actually-assigned users with that capability anywhere.';

revoke all on function public.election_day_delete_role(uuid) from public;
grant execute on function public.election_day_delete_role(uuid) to anon, authenticated;

-- ============================================================================
-- election_day_clone_role - no capability-guard restriction (approved: only
-- create/update/delete carry it) - a clone only ever adds an equivalent
-- role, never removes coverage.
-- ============================================================================
create or replace function public.election_day_clone_role(p_role_id uuid, p_new_name text)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb, legacy_role_key text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_id uuid;
begin
  if p_new_name is null or btrim(p_new_name) = '' then
    raise exception 'ROLE_NAME_REQUIRED';
  end if;
  -- Aliased (`r.id`) for the same reason as election_day_update_role above -
  -- this function's own `returns table (id, ...)` makes a bare `id` ambiguous.
  if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_roles (name, description, permissions, scope_type, scope_value, legacy_role_key)
  select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value, null
  from public.election_day_roles r
  where r.id = p_role_id
  returning public.election_day_roles.id into v_new_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.legacy_role_key
    from public.election_day_roles r
    where r.id = v_new_id;
end;
$$;

comment on function public.election_day_clone_role(uuid, text) is
  'Dynamic Roles & Permissions Phase 2: clones an existing role''s description/permissions/scope under a new name. Always legacy_role_key = null (a clone is never a legacy anchor).';

revoke all on function public.election_day_clone_role(uuid, text) from public;
grant execute on function public.election_day_clone_role(uuid, text) to anon, authenticated;

-- ============================================================================
-- election_day_create_permission_user_for_role - creates a PermissionUser
-- against an arbitrary role_id, not one of the 3 legacy checkboxes. The
-- legacy `role` text column is left null (no legacy equivalent for a
-- dynamic role) - session resolution (updated alongside this migration)
-- matches by role_id directly, so a null legacy role text here is not a gap.
-- ============================================================================
create or replace function public.election_day_create_permission_user_for_role(
  p_name text, p_password text, p_role_id uuid
)
returns table (id uuid, name text, role text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;
  -- Aliased (`r.id`) for the same reason as election_day_update_role above -
  -- this function's own `returns table (id, ...)` makes a bare `id` ambiguous.
  if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role, role_id)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), null, p_role_id)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role, u.role_id
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user_for_role(text, text, uuid) is
  'Dynamic Roles & Permissions Phase 2: creates a PermissionUser against an arbitrary role_id (legacy role text left null). The 3-checkbox election_day_create_permission_user RPC is unchanged in behavior and still the path for the built-in legacy roles.';

revoke all on function public.election_day_create_permission_user_for_role(text, text, uuid) from public;
grant execute on function public.election_day_create_permission_user_for_role(text, text, uuid) to anon, authenticated;

-- ============================================================================
-- election_day_login / election_day_list_permission_users /
-- election_day_create_permission_user - all three extended to also return
-- role_id (NOT NULL on every row since Phase 0). Phase 2's session
-- resolution needs it on every creation/login/list path to identify a
-- dynamic-role user's actual RoleRecord, since its legacy role text is null.
-- Changing a RETURNS TABLE shape requires DROP + CREATE, not just
-- CREATE OR REPLACE.
-- ============================================================================
drop function if exists public.election_day_login(text, text);
create or replace function public.election_day_login(p_name text, p_password text)
returns table (id uuid, name text, role text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select u.id, u.name, u.role, u.role_id
    from public.election_day_permission_users u
    where u.name = p_name
      and u.password_hash = extensions.crypt(p_password, u.password_hash);
end;
$$;

comment on function public.election_day_login(text, text) is
  'Verifies name+password against election_day_permission_users.password_hash (pgcrypto bcrypt compare). Returns {id,name,role,role_id} on match, zero rows on no match. Phase 2: added role_id so a dynamic-role user (role=null) still resolves to its actual RoleRecord.';

revoke all on function public.election_day_login(text, text) from public;
grant execute on function public.election_day_login(text, text) to anon, authenticated;

drop function if exists public.election_day_list_permission_users();
create or replace function public.election_day_list_permission_users()
returns table (id uuid, name text, role text, role_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  select u.id, u.name, u.role, u.role_id
  from public.election_day_permission_users u
  order by u.created_at asc;
$$;

comment on function public.election_day_list_permission_users() is
  'Lists all PermissionUsers with only the safe columns (id, name, role, role_id) - password_hash is never selected. Phase 2: added role_id so the roster UI can resolve/display a dynamic-role user''s actual role name.';

revoke all on function public.election_day_list_permission_users() from public;
grant execute on function public.election_day_list_permission_users() to anon, authenticated;

drop function if exists public.election_day_create_permission_user(text, text, text);
create or replace function public.election_day_create_permission_user(
  p_name text,
  p_password text,
  p_role text
)
returns table (id uuid, name text, role text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_role_id uuid;
begin
  if p_role not in ('user', 'manager', 'voting') then
    raise exception 'invalid role: %', p_role;
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;

  select r.id into v_role_id
  from public.election_day_roles r
  where r.legacy_role_key = p_role;

  if v_role_id is null then
    raise exception
      'no election_day_roles row found for legacy_role_key: % - cannot create user without a valid role_id',
      p_role;
  end if;

  insert into public.election_day_permission_users (name, password_hash, role, role_id)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role, v_role_id)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role, u.role_id
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user(text, text, text) is
  'Creates a new PermissionUser via the legacy 3-checkbox path (user/manager/voting), resolving role_id via legacy_role_key. Phase 2: also returns role_id in the result row (signature otherwise unchanged from Phase 0).';

revoke all on function public.election_day_create_permission_user(text, text, text) from public;
grant execute on function public.election_day_create_permission_user(text, text, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_create_permission_user_for_role(text, text, uuid);
--   drop function if exists public.election_day_clone_role(uuid, text);
--   drop function if exists public.election_day_delete_role(uuid);
--   drop function if exists public.election_day_update_role(uuid, text, text, text[], text);
--   drop function if exists public.election_day_create_role(text, text, text[], text);
--   drop function if exists public.election_day_validate_role_input(text, text[], text);
--   drop function if exists public.election_day_is_valid_permission(text);
--
--   -- Revert election_day_create_permission_user/election_day_login/
--   -- election_day_list_permission_users to their pre-Phase-2 (no role_id)
--   -- return shapes - see 20260805190000_election_day_list_roles_rpc.sql /
--   -- 20260805150834_election_day_voting_role.sql for the exact prior bodies.
--   drop function if exists public.election_day_create_permission_user(text, text, text);
--   create or replace function public.election_day_create_permission_user(
--     p_name text, p_password text, p_role text
--   ) returns table (id uuid, name text, role text)
--   language plpgsql security definer set search_path = ''
--   as $$
--   declare v_id uuid; v_role_id uuid;
--   begin
--     if p_role not in ('user', 'manager', 'voting') then
--       raise exception 'invalid role: %', p_role;
--     end if;
--     if p_name is null or btrim(p_name) = '' then
--       raise exception 'name is required';
--     end if;
--     if p_password is null or btrim(p_password) = '' then
--       raise exception 'password is required';
--     end if;
--     select r.id into v_role_id from public.election_day_roles r where r.legacy_role_key = p_role;
--     if v_role_id is null then
--       raise exception 'no election_day_roles row found for legacy_role_key: %', p_role;
--     end if;
--     insert into public.election_day_permission_users (name, password_hash, role, role_id)
--     values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role, v_role_id)
--     returning public.election_day_permission_users.id into v_id;
--     return query select u.id, u.name, u.role from public.election_day_permission_users u where u.id = v_id;
--   end;
--   $$;
--
--   drop function if exists public.election_day_list_permission_users();
--   create or replace function public.election_day_list_permission_users()
--   returns table (id uuid, name text, role text)
--   language sql security definer set search_path = '' stable
--   as $$
--     select u.id, u.name, u.role from public.election_day_permission_users u order by u.created_at asc;
--   $$;
--
--   drop function if exists public.election_day_login(text, text);
--   create or replace function public.election_day_login(p_name text, p_password text)
--   returns table (id uuid, name text, role text)
--   language plpgsql security definer set search_path = ''
--   as $$
--   begin
--     return query
--       select u.id, u.name, u.role from public.election_day_permission_users u
--       where u.name = p_name and u.password_hash = extensions.crypt(p_password, u.password_hash);
--   end;
--   $$;
--   commit;
-- ============================================================================
