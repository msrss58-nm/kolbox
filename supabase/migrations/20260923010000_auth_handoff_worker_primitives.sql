-- ===========================================================================
-- KOLBOX Auth origin - the two worker primitives the handoff needs.
--
-- The worker's session cookie (__Host-kb_ed_session) is bound to the election
-- origin and can never be set by the auth origin. So the single credential
-- submission is split across the two origins:
--
--   auth origin    election_day_verify_credentials_v1  - verify, NO session
--   election origin election_day_create_session_for_actor - session, NO password
--
-- Neither half is a login on its own. The second is reachable only after the
-- first succeeded AND its one-time handoff code was consumed AND the target
-- origin's own transaction cookie matched.
-- ===========================================================================

-- ===========================================================================
-- 1. election_day_verify_credentials_v1
--    Byte-for-byte the credential half of election_day_login_v3 - same
--    normalization, same single generic UNAUTHORIZED for unknown code /
--    unknown user / wrong password, same MODULE_NOT_ENABLED raised only
--    AFTER the password verified (so it tells nothing to someone without
--    valid credentials). It simply stops before creating a session.
-- ===========================================================================
create or replace function public.election_day_verify_credentials_v1(
  p_workspace_code text,
  p_name text,
  p_password text
)
returns table (
  actor_id       uuid,
  actor_name     text,
  role_id        uuid,
  workspace_id   uuid,
  workspace_name text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_workspace_id uuid;
  v_workspace_name text;
  v_user_id uuid;
  v_user_name text;
  v_role_id uuid;
begin
  if p_workspace_code is null or btrim(p_workspace_code) = ''
     or p_name is null or btrim(p_name) = ''
     or p_password is null or p_password = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  v_code := upper(btrim(p_workspace_code));

  select w.id, w.name into v_workspace_id, v_workspace_name
  from public.election_workspaces w
  where w.login_code = v_code;

  if v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select u.id, u.name, u.role_id
    into v_user_id, v_user_name, v_role_id
  from public.election_day_permission_users u
  where u.workspace_id = v_workspace_id
    and u.name = btrim(p_name);

  if v_user_id is null
     or not public.election_day_verify_permission_user_password(v_user_id, p_password)
  then
    raise exception 'UNAUTHORIZED';
  end if;

  if not (
    public.election_day_workspace_has_module(v_workspace_id, 'election_day')
    or public.budget_workspace_entitled(v_workspace_id)
  ) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_workspace_name;
end;
$$;

comment on function public.election_day_verify_credentials_v1(text,text,text) is
  'Auth-origin broker only: the credential half of election_day_login_v3 with NO session creation. Same normalization, same single generic UNAUTHORIZED, same post-password MODULE_NOT_ENABLED. Returns the workspace name so the target origin can show it on the confirmation screen. service_role only.';

revoke all on function public.election_day_verify_credentials_v1(text,text,text) from public;
revoke all on function public.election_day_verify_credentials_v1(text,text,text) from anon;
revoke all on function public.election_day_verify_credentials_v1(text,text,text) from authenticated;
grant execute on function public.election_day_verify_credentials_v1(text,text,text) to service_role;

-- ===========================================================================
-- 2. election_day_create_session_for_actor
--    THE most sensitive primitive added by this work: it mints a worker
--    session WITHOUT a password. It is safe only because of the guards
--    around it, which are therefore stated as requirements, not comments:
--      * service_role ONLY - unreachable with the anon key;
--      * the handler calls it ONLY after auth_handoff_complete succeeded in
--        the same request (one-time code already consumed AND the target
--        origin's own HttpOnly transaction cookie matched);
--      * entitlement is re-checked HERE, at issue time, so a workspace that
--        lost its modules between the credential check and the handoff
--        cannot receive a session;
--      * it never sees or generates a raw token - the caller generates it in
--        Node and passes only the sha256, exactly like election_day_login_v3.
-- ===========================================================================
create or replace function public.election_day_create_session_for_actor(
  p_actor_id     uuid,
  p_session_hash bytea
)
returns table (
  actor_id     uuid,
  actor_name   text,
  role_id      uuid,
  workspace_id uuid,
  expires_at   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_name text;
  v_role_id uuid;
  v_workspace_id uuid;
  v_expires_at timestamptz;
begin
  if p_actor_id is null or p_session_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  select u.name, u.role_id, u.workspace_id
    into v_user_name, v_role_id, v_workspace_id
  from public.election_day_permission_users u
  where u.id = p_actor_id;

  -- The actor may have been deleted between the credential check on the auth
  -- origin and this call.
  if v_user_name is null or v_workspace_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- Re-checked at issue time, not inherited from the earlier verification.
  if not (
    public.election_day_workspace_has_module(v_workspace_id, 'election_day')
    or public.budget_workspace_entitled(v_workspace_id)
  ) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  delete from public.election_day_sessions s
  where s.permission_user_id = p_actor_id and s.expires_at < now();

  v_expires_at := now() + interval '24 hours';

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (p_actor_id, v_workspace_id, p_session_hash, v_expires_at);

  return query select p_actor_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
end;
$$;

comment on function public.election_day_create_session_for_actor(uuid,bytea) is
  'Mints a worker session WITHOUT a password, for the final leg of the Auth-origin handoff only. Reachable exclusively by service_role, and only after auth_handoff_complete authorized exactly one mint. Re-checks the workspace entitlement at issue time. Never sees a raw token - only its sha256, like election_day_login_v3.';

revoke all on function public.election_day_create_session_for_actor(uuid,bytea) from public;
revoke all on function public.election_day_create_session_for_actor(uuid,bytea) from anon;
revoke all on function public.election_day_create_session_for_actor(uuid,bytea) from authenticated;
grant execute on function public.election_day_create_session_for_actor(uuid,bytea) to service_role;
