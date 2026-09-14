-- Budget Stage 3 (A/3) - authentication, entitlement and permission foundation.
--
-- Keeps five concerns apart (Stage 2 architecture):
--   1. AUTHENTICATION   - the existing PermissionUser session (cookie hash) and
--                         the existing bcrypt credential, unchanged.
--   2. MEMBERSHIP       - workspace_resolve_session: the session’s actor/role/
--                         workspace, with NO module predicate. Internal only.
--   3. ENTITLEMENT      - budget_workspace_entitled: a module row AND the
--                         catalog’s available flag (the global kill switch).
--   4. PERMISSION       - the budget.* strings, validated by the existing
--                         allowlist; budget.view is required by every other one.
--   5. ELECTION STATE   - untouched. Nothing here reads election_end_at.
--
-- What changes for Election Day: NOTHING observable.
--   * election_day_resolve_session keeps its election_day predicate, so every
--     Election Day RPC still fails closed for a workspace without Election Day.
--   * election_day_login_v3 now admits a workspace entitled to election_day OR
--     (effectively) budget. A workspace with only election_day logs in exactly
--     as before; one with neither still gets MODULE_NOT_ENABLED after the
--     password check. A Budget-only session resolves nowhere in Election Day.
--   * The bcrypt comparison used by election_day_login_v3 and
--     election_day_reauth_v3 moves into ONE internal function,
--     election_day_verify_permission_user_password, so Budget’s step-up reuses
--     the same credential check instead of a second password system.
--
-- ACL: every new function is SECURITY DEFINER, search_path ’’, EXECUTE revoked
-- BY NAME from PUBLIC/anon/authenticated (hosted pg_default_acl hazard) and
-- granted to service_role only where a handler must call it; internal helpers
-- are granted to no role at all.
--
-- MANUAL ROLLBACK (revert the application first):
--   begin;
--   -- restore election_day_login_v3 and election_day_reauth_v3 from
--   -- 20260916000000 / 20260826010000, election_day_is_valid_permission from
--   -- 20260811100400 and election_day_validate_role_input from 20260806100000;
--   drop function if exists public.workspace_session_modules(bytea);
--   drop function if exists public.election_day_workspace_worker_modules(uuid);
--   drop function if exists public.budget_workspace_entitled(uuid);
--   drop function if exists public.workspace_resolve_session(bytea);
--   drop function if exists public.election_day_verify_permission_user_password(uuid, text);
--   commit;

begin;

-- ===========================================================================
-- 1. Shared credential check (one place for the PermissionUser bcrypt compare).
-- ===========================================================================
create or replace function public.election_day_verify_permission_user_password(
  p_actor_id uuid,
  p_password text
)
returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_hash text;
begin
  if p_actor_id is null or p_password is null or p_password = '' then
    return false;
  end if;
  select u.password_hash into v_hash
  from public.election_day_permission_users u
  where u.id = p_actor_id;
  return v_hash is not null and extensions.crypt(p_password, v_hash) = v_hash;
end;
$fn$;

comment on function public.election_day_verify_permission_user_password(uuid, text) is
  'Budget Stage 3: the single PermissionUser credential check (bcrypt via extensions.crypt), shared by election_day_login_v3, election_day_reauth_v3 and the Budget step-up. Internal - granted to no role.';

revoke all on function public.election_day_verify_permission_user_password(uuid, text) from public;
revoke all on function public.election_day_verify_permission_user_password(uuid, text) from anon;
revoke all on function public.election_day_verify_permission_user_password(uuid, text) from authenticated;
revoke all on function public.election_day_verify_permission_user_password(uuid, text) from service_role;

-- ===========================================================================
-- 2. Membership: the session with no module predicate (internal only).
-- ===========================================================================
create or replace function public.workspace_resolve_session(
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  if p_session_hash is null then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select u.id, u.name, u.role_id, s.workspace_id
    from public.election_day_sessions s
    join public.election_day_permission_users u
      on u.id = s.permission_user_id
     and u.workspace_id = s.workspace_id
    where s.token_hash = p_session_hash
      and s.expires_at > now();

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$fn$;

comment on function public.workspace_resolve_session(bytea) is
  'Budget Stage 3: resolves a PermissionUser session to (actor, role, workspace) with NO module predicate. Authentication + membership only - every caller must check its own module entitlement and permission. Internal - granted to no role.';

revoke all on function public.workspace_resolve_session(bytea) from public;
revoke all on function public.workspace_resolve_session(bytea) from anon;
revoke all on function public.workspace_resolve_session(bytea) from authenticated;
revoke all on function public.workspace_resolve_session(bytea) from service_role;

-- ===========================================================================
-- 3. Entitlement.
-- ===========================================================================
create or replace function public.budget_workspace_entitled(
  p_workspace_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $fn$
  select p_workspace_id is not null
     and public.election_day_workspace_has_module(p_workspace_id, 'budget')
     and exists (
       select 1 from public.platform_modules pm
       where pm.key = 'budget' and pm.available
     );
$fn$;

comment on function public.budget_workspace_entitled(uuid) is
  'Budget Stage 3: EFFECTIVE Budget entitlement = the workspace holds the budget module row AND platform_modules.budget.available is true. available is the global kill switch - a Budget row recorded while it is false stays inert. Internal - granted to no role.';

revoke all on function public.budget_workspace_entitled(uuid) from public;
revoke all on function public.budget_workspace_entitled(uuid) from anon;
revoke all on function public.budget_workspace_entitled(uuid) from authenticated;
revoke all on function public.budget_workspace_entitled(uuid) from service_role;

create or replace function public.election_day_workspace_worker_modules(
  p_workspace_id uuid
)
returns text[]
language sql
security definer
set search_path = ''
stable
as $fn$
  select array_remove(array[
    case when public.election_day_workspace_has_module(p_workspace_id, 'election_day')
         then 'election_day' end,
    case when public.budget_workspace_entitled(p_workspace_id)
         then 'budget' end
  ], null);
$fn$;

comment on function public.election_day_workspace_worker_modules(uuid) is
  'Budget Stage 3: the worker-login modules a workspace is effectively entitled to, in a fixed order. Navigation metadata only - every operation re-checks its own entitlement. Internal - granted to no role.';

revoke all on function public.election_day_workspace_worker_modules(uuid) from public;
revoke all on function public.election_day_workspace_worker_modules(uuid) from anon;
revoke all on function public.election_day_workspace_worker_modules(uuid) from authenticated;
revoke all on function public.election_day_workspace_worker_modules(uuid) from service_role;

create or replace function public.workspace_session_modules(
  p_session_hash bytea
)
returns text[]
language plpgsql
security definer
set search_path = ''
stable
as $fn$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id
  from public.workspace_resolve_session(p_session_hash) r;
  return public.election_day_workspace_worker_modules(v_workspace_id);
end;
$fn$;

comment on function public.workspace_session_modules(bytea) is
  'Budget Stage 3: the effective worker modules of a valid session (UNAUTHORIZED otherwise). Called by api/election-day/session.ts after a successful login so the client can route a Budget-only user; it grants nothing. service_role-only.';

revoke all on function public.workspace_session_modules(bytea) from public;
revoke all on function public.workspace_session_modules(bytea) from anon;
revoke all on function public.workspace_session_modules(bytea) from authenticated;
grant execute on function public.workspace_session_modules(bytea) to service_role;

-- ===========================================================================
-- 4. Login: admit election_day OR effectively-entitled budget.
--    Identical to 20260916000000 except (a) the shared credential function and
--    (b) the module predicate.
-- ===========================================================================
create or replace function public.election_day_login_v3(
  p_workspace_code text,
  p_name text,
  p_password text,
  p_session_hash bytea
)
returns table (
  actor_id uuid,
  actor_name text,
  role_id uuid,
  workspace_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_workspace_id uuid;
  v_user_id uuid;
  v_user_name text;
  v_role_id uuid;
  v_expires_at timestamptz;
begin
  if p_workspace_code is null or btrim(p_workspace_code) = ''
     or p_name is null or btrim(p_name) = ''
     or p_password is null or p_password = ''
     or p_session_hash is null
  then
    raise exception 'UNAUTHORIZED';
  end if;

  v_code := upper(btrim(p_workspace_code));

  select w.id into v_workspace_id
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

  -- Platform entitlement. Only reachable with valid credentials. Budget Stage
  -- 3: a worker may log in to a workspace entitled to Election Day OR to
  -- Budget; each module still enforces its own entitlement on every request.
  if not (
    public.election_day_workspace_has_module(v_workspace_id, 'election_day')
    or public.budget_workspace_entitled(v_workspace_id)
  ) then
    raise exception 'MODULE_NOT_ENABLED';
  end if;

  delete from public.election_day_sessions s
  where s.permission_user_id = v_user_id and s.expires_at < now();

  v_expires_at := now() + interval '24 hours';

  insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
  values (v_user_id, v_workspace_id, p_session_hash, v_expires_at);

  return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
end;
$$;

revoke all on function public.election_day_login_v3(text, text, text, bytea) from public;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from anon;
revoke all on function public.election_day_login_v3(text, text, text, bytea) from authenticated;
grant execute on function public.election_day_login_v3(text, text, text, bytea) to service_role;

-- ===========================================================================
-- 5. Election Day reauth: identical to 20260826010000 except the shared
--    credential function. It still resolves through election_day_resolve_session
--    (Election-Day-gated) - Budget has its own step-up functions.
-- ===========================================================================
create or replace function public.election_day_reauth_v3(
  p_session_hash bytea,
  p_password text,
  p_action text,
  p_proof_hash bytea
)
returns table (
  actor_id uuid,
  workspace_id uuid,
  action text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_role_id uuid;
  v_workspace_id uuid;
  v_expires_at timestamptz;
begin
  if p_session_hash is null or p_proof_hash is null
     or p_action is null or btrim(p_action) = ''
     or p_password is null or p_password = ''
  then
    raise exception 'UNAUTHORIZED';
  end if;

  select r.actor_id, r.role_id, r.workspace_id
    into v_actor_id, v_role_id, v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  if not public.election_day_verify_permission_user_password(v_actor_id, p_password) then
    raise exception 'UNAUTHORIZED';
  end if;

  delete from public.election_day_reauth_proofs p
  where p.actor_id = v_actor_id and p.action = p_action and p.expires_at < now();

  v_expires_at := now() + interval '5 minutes';

  insert into public.election_day_reauth_proofs (actor_id, workspace_id, action, proof_hash, expires_at)
  values (v_actor_id, v_workspace_id, p_action, p_proof_hash, v_expires_at);

  return query select v_actor_id, v_workspace_id, p_action, v_expires_at;
end;
$$;

revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from public;
revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from anon;
revoke all on function public.election_day_reauth_v3(bytea, text, text, bytea) from authenticated;
grant execute on function public.election_day_reauth_v3(bytea, text, text, bytea) to service_role;

-- ===========================================================================
-- 6. Permissions: the seven budget.* strings + the budget.view implication.
-- ===========================================================================
create or replace function public.election_day_is_valid_permission(p_permission text)
returns boolean
language sql
immutable
as $$
  select p_permission = any(array[
    'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
    'electionDay.manageUsers', 'electionDay.manageRideCoordinators', 'electionDay.manageRolesAndPermissions',
    'electionDay.manageNonVotingReasons', 'electionDay.manageCoordinatorAllocation',
    'app.accessFullNavigation',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
    'voter.viewReminderHistory',
    'budget.view', 'budget.manageExpenses', 'budget.manageFunderSubmissions', 'budget.manageSuppliers',
    'budget.managePlan', 'budget.viewReports', 'budget.manageSettings'
  ]);
$$;

comment on function public.election_day_is_valid_permission(text) is
  'DB-side mirror of ALL_PERMISSIONS (src/permissions/permissionsMap.ts) - the write-path trust boundary for role create/update. Budget Stage 3 adds the seven budget.* strings.';

revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;

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
  -- Budget Stage 3: every Budget capability implies read access to the module.
  if exists (
       select 1 from unnest(coalesce(p_permissions, '{}')) p
       where p like 'budget.%' and p <> 'budget.view'
     )
     and not ('budget.view' = any(coalesce(p_permissions, '{}')))
  then
    raise exception 'BUDGET_VIEW_REQUIRED';
  end if;
end;
$$;

revoke all on function public.election_day_validate_role_input(text, text[], text) from public, anon, authenticated;

commit;
