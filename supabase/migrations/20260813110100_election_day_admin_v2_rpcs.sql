-- Security Phase 1 - hardened v2 admin/import RPCs. Companion to
-- 20260813110000_election_day_reauth_proof_infrastructure.sql.
--
-- Closes the CRITICAL findings from the Security Phase 1 audit: 6 admin
-- RPCs (create/delete a permission-user account, create/update/delete/clone
-- a role) plus election_day_import_voters had ZERO server-side identity
-- check of any kind - reachable by any caller holding only the public anon
-- key. election_day_reset_permission_user_password already had a correct
-- bcrypt-verify-actor + permission-check pattern; it is included here only
-- to migrate it from raw-password to proof-based auth for consistency with
-- the rest of this hardening pass (see the Password Logging Gate work).
--
-- Approved versioning strategy (corrected from an earlier, invalidated
-- CREATE OR REPLACE-based plan - Postgres function identity is name+argument
-- types, not names; CREATE OR REPLACE cannot safely rename an
-- already-assigned input parameter, and even where tolerated gives zero
-- coexistence window - see the Security Phase 1 blueprint's Correction 1):
-- every function here is a BRAND NEW name (_v2 suffix), a genuinely distinct
-- pg_proc object. The original v1 functions (election_day_create_
-- permission_user, election_day_delete_permission_user, election_day_
-- reset_permission_user_password, election_day_create_role, election_day_
-- update_role, election_day_delete_role, election_day_clone_role,
-- election_day_import_voters) are NOT touched by this migration at all -
-- same name, same signature, same grants, same body, still fully
-- functional. This is what makes a real compatibility window possible:
-- old and new frontend code can call their respective RPC names
-- simultaneously with zero interference. Retirement (REVOKE EXECUTE on the
-- old names) is a deliberately separate, later, explicitly-approved
-- Security Phase 3 - not part of this migration.
--
-- Every function below follows the same auth prelude, in this order:
--   1. resolve the acting identity from the proof alone via
--      election_day_verify_reauth_proof(p_reauth_proof) - never a
--      client-supplied actor_id (UNAUTHORIZED on invalid/expired/forged
--      proof, raised by that helper itself).
--   2. check the resolved actor's CURRENT role holds the required
--      permission (FORBIDDEN otherwise) - read live from election_day_roles
--      every call, never cached/snapshotted in the proof, so a permission
--      change takes effect immediately regardless of proof validity.
--   3. only then does the original v1 business logic run, copied verbatim
--      (same validation, same error codes, same collision/guard rules) -
--      this migration adds an auth precondition, it does not alter any
--      existing business rule.
-- Every function auth-fails with zero mutation, by construction: the
-- proof/permission checks happen before any INSERT/UPDATE/DELETE
-- statement in every function body below.
begin;

-- ============================================================================
-- 1. election_day_create_permission_user_v2 - electionDay.manageUsers.
-- Business logic identical to election_day_create_permission_user
-- (20260806150000): name/password required, p_role_id must exist.
--
-- No bootstrap/empty-roster exception of any kind (a narrow one was added
-- and then explicitly rejected during this Security Phase 1 review: a
-- privileged public management endpoint must never become unauthenticated
-- merely because the user table reaches zero rows - a caller could always
-- force that state by first driving the roster to empty). This RPC is
-- uniformly secure in every database state, including an empty one. The
-- first-ever account (fresh install / local test bootstrap) is created
-- through the still-reachable legacy election_day_create_permission_user
-- (unauthenticated by design, unchanged, temporarily kept for exactly this
-- kind of compatibility need - see this migration's own header comment)
-- or another explicit, out-of-band setup mechanism - never through this
-- v2 RPC.
-- ============================================================================
create or replace function public.election_day_create_permission_user_v2(
  p_reauth_proof text,
  p_name text,
  p_password text,
  p_role_id uuid
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_id uuid;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

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

comment on function public.election_day_create_permission_user_v2(text, text, text, uuid) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_create_permission_user (which had ZERO caller auth - see the Security Phase 1 audit). Requires electionDay.manageUsers on the resolved actor''s current role, UNCONDITIONALLY - no empty-roster/bootstrap/first-user exception of any kind (one was briefly added, then explicitly removed: a privileged endpoint must not become unauthenticated just because the user table is empty). Business logic (name/password required, role_id must exist) is unchanged from the v1 function. The v1 function is untouched and remains temporarily reachable for compatibility (retirement is a separate later phase) - fresh-install/local-test bootstrap of the first account goes through that legacy path, never through this one.';

revoke all on function public.election_day_create_permission_user_v2(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.election_day_create_permission_user_v2(text, text, text, uuid) to anon, authenticated;

-- ============================================================================
-- 2. election_day_delete_permission_user_v2 - electionDay.manageUsers.
-- Business logic identical to election_day_delete_permission_user
-- (20260803174740): unconditional delete by id, no extra guard beyond auth
-- (matches v1's existing behavior exactly - this migration does not add new
-- business rules, only the auth precondition that was entirely absent).
-- ============================================================================
create or replace function public.election_day_delete_permission_user_v2(
  p_reauth_proof text,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_has_permission boolean;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  delete from public.election_day_permission_users where id = p_target_user_id;
end;
$$;

comment on function public.election_day_delete_permission_user_v2(text, uuid) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_delete_permission_user (which had ZERO caller auth). Requires electionDay.manageUsers on the resolved actor''s current role. Delete behavior unchanged from v1 (unconditional delete by id, no additional guard). The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_delete_permission_user_v2(text, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_permission_user_v2(text, uuid) to anon, authenticated;

-- ============================================================================
-- 3. election_day_reset_permission_user_password_v2 - electionDay.
-- manageUsers. Business logic identical to election_day_reset_
-- permission_user_password (20260806210000 fix version): target must
-- exist (USER_NOT_FOUND), new password must be non-blank (INVALID_PASSWORD),
-- reset_by taken from the server-resolved actor's own name. NEW behavior
-- (approved Security Phase 1 design, not present in v1): deletes ALL of the
-- TARGET user's outstanding reauth proofs in the same transaction as the
-- password update - a proof issued under the old password must not survive
-- a password change. Targets the reset TARGET specifically, never the
-- acting manager - if actor and target are the same person (self-reset),
-- their own current proof is invalidated as an intended side effect; if a
-- manager resets someone else's password, the manager's own proof is left
-- untouched.
-- ============================================================================
create or replace function public.election_day_reset_permission_user_password_v2(
  p_reauth_proof text,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_permission boolean;
begin
  select v.role_id, v.actor_name into v_actor_role_id, v_actor_name
  from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

  if not exists (
    select 1 from public.election_day_permission_users u where u.id = p_target_user_id
  ) then
    raise exception 'USER_NOT_FOUND';
  end if;

  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_actor_name
  where public.election_day_permission_users.id = p_target_user_id;

  delete from public.election_day_reauth_proofs where actor_id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$$;

comment on function public.election_day_reset_permission_user_password_v2(text, uuid, text) is
  'Security Phase 1: proof-based replacement for election_day_reset_permission_user_password (which already had a correct bcrypt-verify-actor + permission-check pattern - migrated here for consistency with the rest of this hardening pass, not because it was a security gap). Requires electionDay.manageUsers on the resolved actor''s current role. Business logic (USER_NOT_FOUND / INVALID_PASSWORD checks, reset_by from the server-resolved actor) unchanged from v1. New in v2: deletes ALL of the TARGET user''s outstanding reauth proofs in the same transaction as the password update (approved design - a proof issued under the old password must not outlive a password change); targets p_target_user_id specifically, never the acting manager''s own proof, unless they are the same person. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_reset_permission_user_password_v2(text, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_reset_permission_user_password_v2(text, uuid, text) to anon, authenticated;

-- ============================================================================
-- 4. election_day_create_role_v2 - electionDay.manageRolesAndPermissions.
-- Business logic identical to election_day_create_role (20260806150000):
-- no capability-guard restriction (approved product decision - adding a
-- role can never reduce anyone's existing access), validated via the
-- existing internal election_day_validate_role_input helper.
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
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_id uuid;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

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

comment on function public.election_day_create_role_v2(text, text, text, text[], text) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_create_role (which had ZERO caller auth - a caller could create a role holding every permission in the system). Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. Business validation (election_day_validate_role_input) unchanged from v1; no capability-guard restriction on create itself, matching v1''s existing approved product decision. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_create_role_v2(text, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.election_day_create_role_v2(text, text, text, text[], text) to anon, authenticated;

-- ============================================================================
-- 5. election_day_update_role_v2 - electionDay.manageRolesAndPermissions.
-- Business logic identical to election_day_update_role (20260806150000),
-- including its own internal advisory lock guarding the
-- CANNOT_REMOVE_LAST_PERMISSION_HOLDER check.
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
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_had_capability boolean;
  v_will_have_capability boolean;
  v_remaining_holders integer;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

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

comment on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_update_role (which had ZERO caller auth - a caller could grant any existing role electionDay.manageRolesAndPermissions/manageUsers/etc.). Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. Business logic (ROLE_NOT_FOUND, CANNOT_REMOVE_LAST_PERMISSION_HOLDER checked against actually-assigned users, the same pg_advisory_xact_lock serializing concurrent role edits) unchanged from v1. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) from public, anon, authenticated;
grant execute on function public.election_day_update_role_v2(text, uuid, text, text, text[], text) to anon, authenticated;

-- ============================================================================
-- 6. election_day_delete_role_v2 - electionDay.manageRolesAndPermissions.
-- Business logic identical to election_day_delete_role (20260806100000).
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
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_assigned_count integer;
  v_had_capability boolean;
  v_remaining_holders integer;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

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

comment on function public.election_day_delete_role_v2(text, uuid) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_delete_role (which had ZERO caller auth). Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. Business logic (ROLE_NOT_FOUND, ROLE_HAS_ASSIGNED_USERS, CANNOT_REMOVE_LAST_PERMISSION_HOLDER, the same advisory lock) unchanged from v1. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_delete_role_v2(text, uuid) from public, anon, authenticated;
grant execute on function public.election_day_delete_role_v2(text, uuid) to anon, authenticated;

-- ============================================================================
-- 7. election_day_clone_role_v2 - electionDay.manageRolesAndPermissions.
-- Business logic identical to election_day_clone_role (20260806150000): no
-- capability-guard restriction (a clone only ever adds an equivalent role,
-- never removes coverage - matches v1's existing approved product decision).
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
  v_actor_role_id uuid;
  v_has_permission boolean;
  v_new_id uuid;
begin
  select v.role_id into v_actor_role_id from public.election_day_verify_reauth_proof(p_reauth_proof) v;

  select ('electionDay.manageRolesAndPermissions' = any(r.permissions)) into v_has_permission
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_permission is not true then
    raise exception 'FORBIDDEN';
  end if;

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

comment on function public.election_day_clone_role_v2(text, uuid, text) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_clone_role (which had ZERO caller auth - a caller could clone the highest-privilege role verbatim). Requires electionDay.manageRolesAndPermissions on the resolved actor''s current role. Business logic (ROLE_NAME_REQUIRED, ROLE_NOT_FOUND) unchanged from v1. The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_clone_role_v2(text, uuid, text) from public, anon, authenticated;
grant execute on function public.election_day_clone_role_v2(text, uuid, text) to anon, authenticated;

-- ============================================================================
-- 8. election_day_import_voters_v2 - electionDay.import. Business logic
-- (the allocation-activity guard + global advisory lock + full atomic
-- delete/insert) copied verbatim from the LATEST verified election_day_
-- import_voters (20260813100200 - the version with the Phase-3 concurrency
-- advisory lock, itself runtime-verified in the prior Runtime PostgreSQL
-- Verification phase) - NOT an earlier pre-lock definition, per the
-- explicit requirement not to regress that hardening.
--
-- Security mode change vs v1: v1 is SECURITY INVOKER (sufficient there
-- because election_day_voters already has fully open RLS for anon/
-- authenticated). v2 must be SECURITY DEFINER instead: it needs to call
-- election_day_verify_reauth_proof, which is revoked from anon/authenticated
-- and only callable by the shared owner role - a SECURITY INVOKER v2 would
-- have that nested call fail with a permission error for every real
-- (anon/authenticated) caller. This is a deliberate, necessary consequence
-- of adding proof-based auth, not an oversight. The auth/permission check
-- runs strictly BEFORE the advisory lock is acquired, so the lock-then-
-- guard-then-mutate ordering that the concurrency hardening depends on
-- (see 20260813100200''s own header comment and the C1-C4 concurrency
-- verification) is completely preserved, just with a new precondition
-- ahead of it.
-- ============================================================================
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

  -- Global Election Day import/allocation mutation lock - identical to v1
  -- and to the 3 business allocation RPCs (see 20260813100100/
  -- 20260813100200's header comments). Acquired only after the auth/
  -- permission precondition above, before any read/lock of coordinator or
  -- voter business state below - preserves the exact concurrency
  -- serialization already runtime-verified for v1.
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
  return v_count;
end;
$$;

comment on function public.election_day_import_voters_v2(text, jsonb) is
  'Security Phase 1: proof-based, permission-checked replacement for election_day_import_voters (which had ZERO caller auth - a caller could atomically wipe and replace the entire voter dataset). Requires electionDay.import on the resolved actor''s current role, checked strictly before the global election_day_voter_allocation_mutation advisory lock is acquired - preserves the exact lock-then-guard-then-mutate concurrency ordering already runtime-verified for v1 and the 3 business allocation RPCs. Business logic (has_allocation_activity guard raising ALLOCATION_ACTIVITY_STARTED, the atomic delete+insert, NULL-coordinator support) copied verbatim from the latest verified v1 definition (20260813100200), not an earlier pre-lock version. SECURITY DEFINER (a deliberate change from v1''s SECURITY INVOKER, required so the nested election_day_verify_reauth_proof call - itself owner-only - succeeds for real anon/authenticated callers). The v1 function is untouched and remains temporarily reachable for compatibility.';

revoke all on function public.election_day_import_voters_v2(text, jsonb) from public, anon, authenticated;
grant execute on function public.election_day_import_voters_v2(text, jsonb) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_import_voters_v2(text, jsonb);
--   drop function if exists public.election_day_clone_role_v2(text, uuid, text);
--   drop function if exists public.election_day_delete_role_v2(text, uuid);
--   drop function if exists public.election_day_update_role_v2(text, uuid, text, text, text[], text);
--   drop function if exists public.election_day_create_role_v2(text, text, text, text[], text);
--   drop function if exists public.election_day_reset_permission_user_password_v2(text, uuid, text);
--   drop function if exists public.election_day_delete_permission_user_v2(text, uuid);
--   drop function if exists public.election_day_create_permission_user_v2(text, text, text, uuid);
--   commit;
--
-- (v1 functions were never touched by this migration - no v1 rollback is
-- needed or provided here.)
-- ============================================================================
