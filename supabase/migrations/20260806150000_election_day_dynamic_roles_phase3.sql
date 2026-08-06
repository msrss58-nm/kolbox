-- Dynamic Roles & Permissions - Phase 3: legacy cleanup. Removes
-- legacy_role_key (election_day_roles) and role (election_day_permission_users)
-- - both documented since Phase 0/2 as temporary migration-bookkeeping
-- columns, removed entirely once nothing reads them - and the legacy
-- 3-checkbox election_day_create_permission_user RPC that existed to serve
-- them. Every role (built-in or dynamic) becomes an ordinary row with no
-- special marking; every PermissionUser is created/resolved exclusively by
-- role_id, which has been NOT NULL on every row since Phase 0.
--
-- election_day_delete_role/election_day_is_valid_permission/
-- election_day_validate_role_input are untouched - none of them read or
-- return legacy_role_key/role.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project (see election_day_dynamic_roles_phase0/phase2):
-- the Supabase CLI's migration runner pipelines a file's statements via
-- wire-protocol batching, not an implicit transaction.
begin;

-- ============================================================================
-- 1. election_day_create_permission_user - the legacy 3-checkbox path is
-- fully superseded by election_day_create_permission_user_for_role (Phase 2).
-- No code path calls it anymore - dropped outright, not just deprecated.
-- ============================================================================
drop function if exists public.election_day_create_permission_user(text, text, text);

-- ============================================================================
-- 2. election_day_permission_users.role - the legacy text column
-- (user/manager/voting), nullable since Phase 0, unused by any RPC or the
-- frontend now that resolution is exclusively by role_id. Dropping the
-- column also drops its CHECK constraint automatically.
-- ============================================================================
alter table public.election_day_permission_users
  drop column role;

-- ============================================================================
-- 3. election_day_login / election_day_list_permission_users - re-created
-- without `role` in their return shape (the column no longer exists).
-- election_day_create_permission_user_for_role is renamed to
-- election_day_create_permission_user (the short name freed up by step 1's
-- drop of the legacy 3-arg overload) - it's the only creation path left, so
-- the "_for_role" qualifier no longer earns its keep. Changing a
-- RETURNS TABLE shape requires DROP + CREATE, not just CREATE OR REPLACE.
-- ============================================================================
drop function if exists public.election_day_login(text, text);
create or replace function public.election_day_login(p_name text, p_password text)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.name = p_name
      and u.password_hash = extensions.crypt(p_password, u.password_hash);
end;
$$;

comment on function public.election_day_login(text, text) is
  'Verifies name+password against election_day_permission_users.password_hash (pgcrypto bcrypt compare). Returns {id,name,role_id} on match, zero rows on no match. Phase 3: the legacy role text column no longer exists - role_id is the only identity a session resolves by.';

revoke all on function public.election_day_login(text, text) from public;
grant execute on function public.election_day_login(text, text) to anon, authenticated;

drop function if exists public.election_day_list_permission_users();
create or replace function public.election_day_list_permission_users()
returns table (id uuid, name text, role_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  select u.id, u.name, u.role_id
  from public.election_day_permission_users u
  order by u.created_at asc;
$$;

comment on function public.election_day_list_permission_users() is
  'Lists all PermissionUsers with only the safe columns (id, name, role_id) - password_hash is never selected. Phase 3: the legacy role text column no longer exists.';

revoke all on function public.election_day_list_permission_users() from public;
grant execute on function public.election_day_list_permission_users() to anon, authenticated;

drop function if exists public.election_day_create_permission_user_for_role(text, text, uuid);
create or replace function public.election_day_create_permission_user(
  p_name text, p_password text, p_role_id uuid
)
returns table (id uuid, name text, role_id uuid)
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
  if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role_id)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role_id)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user(text, text, uuid) is
  'Dynamic Roles & Permissions Phase 2/3: creates a PermissionUser against an arbitrary role_id - the only creation path now that the legacy 3-checkbox RPC has been dropped. Renamed from election_day_create_permission_user_for_role once the legacy 3-arg overload freed up the short name.';

revoke all on function public.election_day_create_permission_user(text, text, uuid) from public;
grant execute on function public.election_day_create_permission_user(text, text, uuid) to anon, authenticated;

-- ============================================================================
-- 4. election_day_create_role / update_role / clone_role / list_roles -
-- re-created without legacy_role_key in their return shape (the column is
-- dropped in step 5 below). election_day_delete_role is untouched - it
-- never selected or returned legacy_role_key.
-- ============================================================================
drop function if exists public.election_day_create_role(text, text, text[], text);
create or replace function public.election_day_create_role(
  p_name text, p_description text, p_permissions text[], p_scope_type text
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
  v_id uuid;
begin
  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

  insert into public.election_day_roles (name, description, permissions, scope_type)
  values (btrim(p_name), coalesce(p_description, ''), coalesce(p_permissions, '{}'), p_scope_type)
  returning public.election_day_roles.id into v_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_id;
end;
$$;

comment on function public.election_day_create_role(text, text, text[], text) is
  'Dynamic Roles & Permissions Phase 2/3: creates a new, fully editable role. No capability-guard restriction - adding a role can never reduce anyone''s existing access.';

revoke all on function public.election_day_create_role(text, text, text[], text) from public;
grant execute on function public.election_day_create_role(text, text, text[], text) to anon, authenticated;

drop function if exists public.election_day_update_role(uuid, text, text, text[], text);
create or replace function public.election_day_update_role(
  p_role_id uuid, p_name text, p_description text, p_permissions text[], p_scope_type text
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
  v_had_capability boolean;
  v_will_have_capability boolean;
  v_remaining_holders integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtext('election_day_manage_roles_permission_guard')::bigint);
  perform public.election_day_validate_role_input(p_name, p_permissions, p_scope_type);

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
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = p_role_id;
end;
$$;

comment on function public.election_day_update_role(uuid, text, text, text[], text) is
  'Dynamic Roles & Permissions Phase 2/3: edits an existing role. Enforces (checked against actually-assigned users, not role existence): removing electionDay.manageRolesAndPermissions from this role is rejected (CANNOT_REMOVE_LAST_PERMISSION_HOLDER) if it would leave zero users anywhere holding that capability.';

revoke all on function public.election_day_update_role(uuid, text, text, text[], text) from public;
grant execute on function public.election_day_update_role(uuid, text, text, text[], text) to anon, authenticated;

drop function if exists public.election_day_clone_role(uuid, text);
create or replace function public.election_day_clone_role(p_role_id uuid, p_new_name text)
returns table (
  id uuid, name text, description text, permissions text[],
  scope_type text, scope_value jsonb
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
  if not exists (select 1 from public.election_day_roles r where r.id = p_role_id) then
    raise exception 'ROLE_NOT_FOUND';
  end if;

  insert into public.election_day_roles (name, description, permissions, scope_type, scope_value)
  select btrim(p_new_name), r.description, r.permissions, r.scope_type, r.scope_value
  from public.election_day_roles r
  where r.id = p_role_id
  returning public.election_day_roles.id into v_new_id;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.id = v_new_id;
end;
$$;

comment on function public.election_day_clone_role(uuid, text) is
  'Dynamic Roles & Permissions Phase 2/3: clones an existing role''s description/permissions/scope under a new name.';

revoke all on function public.election_day_clone_role(uuid, text) from public;
grant execute on function public.election_day_clone_role(uuid, text) to anon, authenticated;

drop function if exists public.election_day_list_roles();
create or replace function public.election_day_list_roles()
returns table (
  id uuid,
  name text,
  description text,
  permissions text[],
  scope_type text,
  scope_value jsonb
)
language sql
security definer
set search_path = ''
stable
as $$
  select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
  from public.election_day_roles r
  order by r.created_at asc;
$$;

comment on function public.election_day_list_roles() is
  'Dynamic Roles & Permissions, Phase 1/3: lists the election_day_roles catalog (id/name/description/permissions/scope_type/scope_value) for the frontend permission engine. Read-only, STABLE. Has NO caller-identity check, same already-documented/accepted limitation as every other Election Day roster RPC.';

revoke all on function public.election_day_list_roles() from public;
grant execute on function public.election_day_list_roles() to anon, authenticated;

-- ============================================================================
-- 5. election_day_roles.legacy_role_key - temporary migration-bookkeeping
-- anchor only, documented since Phase 0 as removed entirely once nothing
-- reads it. Nothing does anymore (session resolution matches by role_id
-- exclusively since Phase 2). Dropping the column also drops its CHECK
-- constraint and the partial unique index (election_day_roles_legacy_role_key_key)
-- automatically.
-- ============================================================================
alter table public.election_day_roles
  drop column legacy_role_key;

commit;

-- ============================================================================
-- ROLLBACK (manual): not provided in full - this migration is a one-way
-- cleanup of columns/RPCs already documented as temporary since Phase 0/2.
-- Reverting would require re-adding legacy_role_key/role, re-backfilling
-- legacy_role_key from data that no longer distinguishes a legacy account
-- from a dynamic one (Phase 2 already created role_id-only users with
-- role=null indistinguishable from a post-Phase-3 account), and restoring
-- the legacy election_day_create_permission_user RPC - see the Phase 0 and
-- Phase 2 migration files' own rollback blocks for its pre-Phase-3 body if
-- this is ever genuinely needed.
-- ============================================================================
