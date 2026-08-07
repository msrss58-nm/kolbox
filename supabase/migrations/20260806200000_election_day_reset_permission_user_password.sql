-- Reset Permission User Password: lets a manager-capable session reset an
-- existing PermissionUser's password without deleting/recreating the
-- account (which would also change its id and orphan any future audit
-- trail tied to that id). Mirrors election_day_create_permission_user's
-- hashing (extensions.crypt + extensions.gen_salt('bf')) - the only
-- correct way to write password_hash in this table.
--
-- SECURITY FIX (replaces an earlier draft of this same migration, which was
-- never applied to any database): the previous version trusted a
-- client-supplied `p_reset_by text` parameter as the acting user's identity,
-- with no server-side check of who was actually calling or whether they
-- were allowed to. That is NOT what this version does. This RPC now
-- performs genuine server-side re-authentication of the ACTOR (the manager
-- performing the reset):
--   1. `p_actor_password` is bcrypt-verified against the actor's own
--      `password_hash` row (`extensions.crypt(p_actor_password,
--      password_hash) = password_hash`) - wrong actor id or wrong password
--      both raise UNAUTHORIZED, indistinguishably.
--   2. The actor's `role_id` is joined to `election_day_roles` and must
--      hold `'electionDay.manageUsers'` in its `permissions` array -
--      otherwise FORBIDDEN.
--   3. Only once both checks pass is `p_target_user_id` looked up at all -
--      an unauthorized caller can never learn whether a given target id
--      exists (USER_NOT_FOUND is only reachable after 1-2 succeed).
--   4. `p_new_password` null/blank raises INVALID_PASSWORD.
--   5. `reset_by` is looked up server-side from the ALREADY-VERIFIED
--      actor's own `name` column - never a client-supplied parameter. This
--      is the key fix versus the previous draft, which let any caller claim
--      to be anyone in the audit trail.
--
-- This is still NOT a caller-identity check in the way real server-side
-- auth (e.g. Supabase Auth + RLS keyed off auth.uid()) would provide - it's
-- a re-authentication *of the actor as supplied by the client*, using this
-- table's own password_hash column, the same trust primitive
-- election_day_login already uses. Unlike EVERY OTHER Election Day roster
-- RPC (election_day_login, election_day_create_permission_user,
-- election_day_delete_permission_user, election_day_list_permission_users,
-- the role-management RPCs), which have NO caller-identity check
-- whatsoever, this RPC is the first one in this table's history to actually
-- verify a password and a permission before doing anything - that limitation
-- on every OTHER RPC is unchanged and still documented elsewhere; this
-- migration does not fix those. Also, like election_day_login, this RPC's
-- bcrypt compare on p_actor_password has no rate limiting - the same
-- already-accepted, pre-existing limitation as the login RPC itself, not a
-- new gap introduced here.
--
-- reset_at/reset_by are audit-only columns, additive to
-- election_day_permission_users:
--   - reset_by now records the ACTUAL verified actor's name (looked up
--     server-side from their own row after steps 1-2 pass above) - not a
--     self-reported client value.
--   - reset_at is set server-side via now() inside the RPC below, never
--     accepted as a client-supplied value.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project - the Supabase CLI's migration runner
-- pipelines a file's statements via wire-protocol batching, not an
-- implicit transaction.
begin;

-- ============================================================================
-- 1. Additive, nullable audit columns - no default, so existing rows (never
-- reset) simply read null on both.
-- ============================================================================
alter table public.election_day_permission_users
  add column if not exists reset_at timestamptz,
  add column if not exists reset_by text;

comment on column public.election_day_permission_users.reset_at is
  'When password_hash was last reset via election_day_reset_permission_user_password. Set server-side via now() inside the RPC - never client-supplied. Null if the account''s password has never been reset.';
comment on column public.election_day_permission_users.reset_by is
  'Name of the acting manager who performed the reset, looked up server-side inside the RPC from the already-verified actor''s own row (see election_day_reset_permission_user_password) - not a client-supplied value.';

-- ============================================================================
-- 2. election_day_reset_permission_user_password - re-authenticates the
-- acting manager (bcrypt-verifies p_actor_password against their own
-- password_hash, then checks their role holds electionDay.manageUsers)
-- before resetting p_target_user_id's password_hash in place (id/name/
-- role_id all untouched). Never selects or returns password_hash, and
-- never raises/logs the raw new password anywhere. Self-reset works with no
-- special-casing: caller just passes p_target_user_id = p_actor_id.
-- ============================================================================
create or replace function public.election_day_reset_permission_user_password(
  p_actor_id uuid,
  p_actor_password text,
  p_target_user_id uuid,
  p_new_password text
)
returns table (id uuid, name text, role_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_password_hash text;
  v_actor_role_id uuid;
  v_actor_name text;
  v_has_manage_users boolean;
begin
  -- 1. Verify the actor's own credentials first - wrong id or wrong
  -- password both raise the same UNAUTHORIZED, indistinguishably.
  select u.password_hash, u.role_id, u.name
    into v_actor_password_hash, v_actor_role_id, v_actor_name
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  if v_actor_password_hash is null
     or extensions.crypt(p_actor_password, v_actor_password_hash) <> v_actor_password_hash
  then
    raise exception 'UNAUTHORIZED';
  end if;

  -- 2. Verify the actor's role actually holds electionDay.manageUsers.
  select ('electionDay.manageUsers' = any(r.permissions)) into v_has_manage_users
  from public.election_day_roles r
  where r.id = v_actor_role_id;

  if v_has_manage_users is not true then
    raise exception 'FORBIDDEN';
  end if;

  -- 3. Only now check whether the target exists - never before steps 1-2,
  -- so an unauthorized caller can never learn whether a given id exists.
  if not exists (
    select 1 from public.election_day_permission_users u where u.id = p_target_user_id
  ) then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 4. Reject a null/blank new password.
  if p_new_password is null or btrim(p_new_password) = '' then
    raise exception 'INVALID_PASSWORD';
  end if;

  -- 5. Perform the reset - reset_by comes from the already-verified
  -- actor's own name column, never a client-supplied parameter.
  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_actor_name
  where id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$$;

comment on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) is
  'Resets an existing PermissionUser''s password_hash after genuinely re-authenticating the ACTING manager server-side: bcrypt-verifies p_actor_password against the actor''s own password_hash (UNAUTHORIZED on any mismatch or missing actor), then checks the actor''s role holds electionDay.manageUsers (FORBIDDEN otherwise) - only then does p_target_user_id''s existence get checked at all (USER_NOT_FOUND), followed by a null/blank p_new_password check (INVALID_PASSWORD). reset_by is looked up server-side from the verified actor''s own name column, never a client-supplied value - this is the fix versus an earlier, never-applied draft of this migration that trusted a client-supplied p_reset_by text with no identity/permission check at all. Self-reset needs no special-casing: pass p_target_user_id = p_actor_id. Never selects or returns password_hash. Unlike every OTHER Election Day roster RPC (election_day_login, election_day_create_permission_user, election_day_delete_permission_user, election_day_list_permission_users, the role-management RPCs), which have NO caller-identity check at all - that already-documented/accepted limitation is unchanged by this migration. Like election_day_login, this RPC''s bcrypt compare on p_actor_password has no rate limiting - the same already-accepted, pre-existing limitation as the login RPC itself, not a new gap.';

revoke all on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) from public;
grant execute on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   drop function if exists public.election_day_reset_permission_user_password(uuid, text, uuid, text);
--   alter table public.election_day_permission_users
--     drop column if exists reset_at,
--     drop column if exists reset_by;
--   commit;
-- ============================================================================
