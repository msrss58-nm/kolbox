-- Follow-up fix to election_day_reset_permission_user_password (shipped in
-- 20260806200000_election_day_reset_permission_user_password.sql), found via
-- live verification against the real linked database: the function's
-- `returns table (id uuid, name text, role_id uuid)` implicitly declares
-- `id`/`name`/`role_id` as PL/pgSQL OUT variables in scope for the whole
-- function body. The reset UPDATE's `where id = p_target_user_id` was left
-- unqualified, colliding with that OUT variable - Postgres raised
-- `42702 column reference "id" is ambiguous` on every call, breaking the
-- RPC's entire success path (steps 1-4's rejection paths - UNAUTHORIZED/
-- FORBIDDEN/USER_NOT_FOUND/INVALID_PASSWORD - were unaffected, since none of
-- them reach this UPDATE statement). Same "same-day follow-up" pattern
-- already used once before in this project for exactly this kind of issue
-- (see election_day_atomic_import_where_fix after election_day_atomic_import).
--
-- The only change from the previous version: the UPDATE's WHERE clause now
-- explicitly qualifies `id` with the table name, removing the ambiguity.
-- Nothing else about the function's logic, signature, error codes, or
-- security model changes.
begin;

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
  -- FIX: `id` is now explicitly qualified with the table name, since the
  -- function's own `id` OUT parameter (from `returns table (id uuid, ...)`)
  -- otherwise makes a bare `id` ambiguous inside plpgsql (42702).
  update public.election_day_permission_users
  set password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
      reset_at = now(),
      reset_by = v_actor_name
  where public.election_day_permission_users.id = p_target_user_id;

  return query
    select u.id, u.name, u.role_id
    from public.election_day_permission_users u
    where u.id = p_target_user_id;
end;
$$;

comment on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) is
  'Resets an existing PermissionUser''s password_hash after genuinely re-authenticating the ACTING manager server-side: bcrypt-verifies p_actor_password against the actor''s own password_hash (UNAUTHORIZED on any mismatch or missing actor), then checks the actor''s role holds electionDay.manageUsers (FORBIDDEN otherwise) - only then does p_target_user_id''s existence get checked at all (USER_NOT_FOUND), followed by a null/blank p_new_password check (INVALID_PASSWORD). reset_by is looked up server-side from the verified actor''s own name column, never a client-supplied value. Self-reset needs no special-casing: pass p_target_user_id = p_actor_id. Never selects or returns password_hash. Unlike every OTHER Election Day roster RPC (election_day_login, election_day_create_permission_user, election_day_delete_permission_user, election_day_list_permission_users, the role-management RPCs), which have NO caller-identity check at all - that already-documented/accepted limitation is unchanged by this migration. Like election_day_login, this RPC''s bcrypt compare on p_actor_password has no rate limiting - the same already-accepted, pre-existing limitation as the login RPC itself, not a new gap. Fixed 2026-08-07 (follow-up migration): the reset UPDATE''s WHERE clause now explicitly qualifies `id` with the table name to avoid a 42702 ambiguous-column error against this function''s own `id` OUT parameter - found via live verification, previously broke every successful reset attempt.';

revoke all on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) from public;
grant execute on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual): reverting this fix would restore the ambiguous-column
-- bug - not meaningful to roll back on its own. To remove the RPC entirely,
-- see the ROLLBACK block in 20260806200000_election_day_reset_permission_user_password.sql.
-- ============================================================================
