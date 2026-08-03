-- The only sanctioned access path into election_day_permission_users (see
-- the companion migration, which locks the table down with RLS-enabled and
-- zero policies). All four functions are SECURITY DEFINER (run as the
-- table owner, bypassing RLS) with `set search_path = ''` and fully
-- schema-qualified references everywhere inside - this is the standard
-- Postgres hardening against search_path-hijacking attacks on SECURITY
-- DEFINER functions (a malicious search_path could otherwise make an
-- unqualified reference resolve to an attacker-created object instead of
-- the real table/extension function).

-- election_day_login ------------------------------------------------------
-- Verifies name+password against the stored bcrypt hash and returns only
-- the safe fields {id, name, role} - never password_hash itself. Returns
-- zero rows (not an error) on no match, so the caller can distinguish
-- "wrong credentials" from a genuine server error.
create or replace function public.election_day_login(p_name text, p_password text)
returns table (id uuid, name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select u.id, u.name, u.role
    from public.election_day_permission_users u
    where u.name = p_name
      and u.password_hash = extensions.crypt(p_password, u.password_hash);
end;
$$;

comment on function public.election_day_login(text, text) is
  'Verifies name+password against election_day_permission_users.password_hash (pgcrypto bcrypt compare). Returns {id,name,role} on match, zero rows on no match. The only read path into this table that can ever succeed for a caller who does not already know a valid password.';

revoke all on function public.election_day_login(text, text) from public;
grant execute on function public.election_day_login(text, text) to anon, authenticated;

-- election_day_create_permission_user --------------------------------------
-- Hashes the password server-side before it ever reaches storage - the
-- plaintext password arrives over HTTPS in the RPC call arguments and is
-- never written anywhere except through extensions.crypt(...) into
-- password_hash.
create or replace function public.election_day_create_permission_user(
  p_name text,
  p_password text,
  p_role text
)
returns table (id uuid, name text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_role not in ('user', 'manager') then
    raise exception 'invalid role: %', p_role;
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_password is null or btrim(p_password) = '' then
    raise exception 'password is required';
  end if;

  insert into public.election_day_permission_users (name, password_hash, role)
  values (btrim(p_name), extensions.crypt(p_password, extensions.gen_salt('bf')), p_role)
  returning public.election_day_permission_users.id into v_id;

  return query
    select u.id, u.name, u.role
    from public.election_day_permission_users u
    where u.id = v_id;
end;
$$;

comment on function public.election_day_create_permission_user(text, text, text) is
  'Creates a new PermissionUser, hashing the password server-side (pgcrypto bcrypt) before storage. Plaintext password never lands in any column.';

revoke all on function public.election_day_create_permission_user(text, text, text) from public;
grant execute on function public.election_day_create_permission_user(text, text, text) to anon, authenticated;

-- election_day_list_permission_users ----------------------------------------
-- Powers the "ניהול הרשאות משתמשים" roster table - id/name/role only, never
-- password_hash. Manager-first sort stays a client-side concern (as today,
-- in PermissionUsersModal.tsx) - this RPC just returns creation order.
create or replace function public.election_day_list_permission_users()
returns table (id uuid, name text, role text)
language sql
security definer
set search_path = ''
stable
as $$
  select u.id, u.name, u.role
  from public.election_day_permission_users u
  order by u.created_at asc;
$$;

comment on function public.election_day_list_permission_users() is
  'Lists all PermissionUsers with only the safe columns (id, name, role) - password_hash is never selected. Backs the "ניהול הרשאות משתמשים" table.';

revoke all on function public.election_day_list_permission_users() from public;
grant execute on function public.election_day_list_permission_users() to anon, authenticated;

-- election_day_delete_permission_user ----------------------------------------
create or replace function public.election_day_delete_permission_user(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.election_day_permission_users where id = p_id;
end;
$$;

comment on function public.election_day_delete_permission_user(uuid) is
  'Deletes a PermissionUser by id. The table has no anon/authenticated DELETE policy, so this RPC is the only way to remove a row.';

revoke all on function public.election_day_delete_permission_user(uuid) from public;
grant execute on function public.election_day_delete_permission_user(uuid) to anon, authenticated;

-- ============================================================================
-- ROLLBACK (manual):
--
--   drop function if exists public.election_day_delete_permission_user(uuid);
--   drop function if exists public.election_day_list_permission_users();
--   drop function if exists public.election_day_create_permission_user(text, text, text);
--   drop function if exists public.election_day_login(text, text);
-- ============================================================================
