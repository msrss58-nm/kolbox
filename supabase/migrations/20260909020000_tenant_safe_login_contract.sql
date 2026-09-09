-- Tenant-Safe PermissionUser Login - CONTRACT phase.
--
-- ============================================================================
-- SCOPE - one statement of consequence: drop election_day_login_v2.
-- ============================================================================
-- Removes the superseded PermissionUser login RPC now that every caller has
-- been cut over to election_day_login_v3. Touches nothing else: no table, no
-- column, no constraint, no index, no policy, no grant, no trigger, no other
-- function, and no row of business data. Creates nothing.
--
-- ============================================================================
-- WHY v2 MUST GO, AND WHY NOW
-- ============================================================================
-- election_day_login_v2 resolves a PermissionUser with:
--
--   select u.id, ... into v_user_id, ...
--   from public.election_day_permission_users u
--   where u.name = btrim(p_name);
--
-- PL/pgSQL's SELECT ... INTO *without* STRICT does not raise on multiple
-- matching rows - it silently keeps an arbitrary one. Stage 3A
-- (20260909000000) correctly re-scoped election_day_permission_users.name
-- from a global UNIQUE(name) to UNIQUE(workspace_id, name), so two workspaces
-- may now legitimately hold the same username. From that moment v2 is
-- non-deterministic: because the password is verified AFTER the row is
-- chosen, a user with the correct password can be rejected (the other
-- workspace's row was picked) and, with a colliding password, could be
-- authenticated into the WRONG workspace.
--
-- v2 has never been able to misfire in Production only because exactly one
-- workspace exists. That is a coincidence of the current data, not a
-- guarantee - and Stage 3B exists specifically to create a second workspace.
-- Retiring v2 BEFORE that happens is the whole point of this migration: it
-- must not be possible for the ambiguous path to still be reachable at the
-- moment a second workspace appears.
--
-- ============================================================================
-- WHY THIS IS SAFE TO APPLY NOW (verified, not assumed)
-- ============================================================================
--   * The deployed application no longer references v2 at all. The single
--     caller, api/election-day/session.ts, was cut over to call
--     election_day_login_v3 unconditionally and its "no workspace code ->
--     fall back to v2" branch was deleted outright; the workspace code is now
--     a required field end to end (client, store, login screen, endpoint).
--     That application change is deployed to Production BEFORE this migration
--     is applied - deliberately in that order, so there is never an instant
--     where live code calls a function that no longer exists.
--   * A repository-wide grep confirms no other code path - frontend, API,
--     script or RPC - calls election_day_login_v2.
--   * A pg_proc scan confirms no other database function references it in its
--     body, so dropping it cannot break a nested SECURITY DEFINER call.
--   * Production holds exactly ONE PermissionUser (נחום משה, workspace
--     מודיעין), whose real v3 login was verified end to end beforehand, and
--     zero bare `name:`-shaped rate-limit buckets remain - nothing was still
--     depending on the code-less path.
--
-- ============================================================================
-- WHAT IS DELIBERATELY *NOT* DONE HERE
-- ============================================================================
-- The original single-tenant public.election_day_login(p_name, p_password) is
-- left in place. It is already non-live and unreachable by the browser: Phase
-- 4A (20260830010000) revoked anon/authenticated EXECUTE, leaving it
-- service_role-only, and its only remaining code reference is the dead
-- ApiClient method `verifyPermissionUserLogin`, which a repository-wide grep
-- confirms has ZERO callers (it exists only as an interface declaration, two
-- implementations and one wiring line).
--
-- Dropping it was considered and rejected as scope expansion rather than
-- cleanup: it would additionally require editing the generated
-- src/services/supabase/database.types.ts, both ApiClient implementations,
-- the interface and the composition root - none of which this CONTRACT needs,
-- and none of which changes any live behaviour. It remains a documented,
-- non-blocking follow-up. Removing a genuinely dead-but-harmless function is
-- not worth widening an authentication migration's blast radius.
--
-- ============================================================================
-- ROLLBACK NOTE - READ BEFORE RELYING ON IT
-- ============================================================================
-- Unlike the EXPAND migration, this one is NOT cleanly reversible in the
-- sense that matters. The verbatim CREATE FUNCTION text needed to restore v2
-- is recorded in the rollback block at the bottom, so the object itself can
-- be recreated - but restoring it also restores the arbitrary-row defect, and
-- the only reason to want it back would be to serve login requests, which is
-- exactly what must not happen once a second workspace exists. Treat this as
-- forward-only in practice: if a rollback is ever genuinely required, roll
-- back the application deployment first and confirm exactly one workspace
-- still exists before recreating this function.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol pipelining, not an implicit
-- transaction.
begin;

-- ============================================================================
-- PRE-GATES - abort rather than half-apply, and never drop the wrong object.
-- ============================================================================
do $$
declare
  v_v2_count integer;
  v_v3_count integer;
  v_v3_acl text;
  v_referencing text[];
begin
  -- GATE 1: v2 must exist, exactly once, under the EXACT expected signature.
  -- Matching on the identity arguments (not just the name) is what stops this
  -- migration from dropping some future same-named overload by accident.
  select count(*) into v_v2_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'election_day_login_v2'
    and pg_get_function_identity_arguments(p.oid)
        = 'p_name text, p_password text, p_session_hash bytea';

  if v_v2_count <> 1 then
    raise exception
      'CONTRACT_GATE1_FAILED: expected exactly 1 election_day_login_v2(p_name text, p_password text, p_session_hash bytea), found %', v_v2_count;
  end if;

  -- GATE 2: v3 must already be present under its exact signature - dropping
  -- the old login path while the replacement is missing would lock every
  -- PermissionUser out of the system.
  select count(*) into v_v3_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'election_day_login_v3'
    and pg_get_function_identity_arguments(p.oid)
        = 'p_workspace_code text, p_name text, p_password text, p_session_hash bytea';

  if v_v3_count <> 1 then
    raise exception
      'CONTRACT_GATE2_FAILED: election_day_login_v3 is not present under its expected signature (found %) - refusing to remove the only other login path', v_v3_count;
  end if;

  -- GATE 3: v3 must still be service_role-only. If its ACL had drifted to
  -- include anon/authenticated, making it the sole login path would widen an
  -- already-broken exposure rather than close one.
  select coalesce(array_to_string(p.proacl, ' '), '') into v_v3_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'election_day_login_v3';

  if v_v3_acl like '%anon=%' or v_v3_acl like '%authenticated=%' then
    raise exception
      'CONTRACT_GATE3_FAILED: election_day_login_v3 ACL unexpectedly grants anon/authenticated';
  end if;

  -- GATE 4: no other function may CALL v2 from its body - a nested SECURITY
  -- DEFINER call would break silently at runtime, not at drop time.
  --
  -- Deliberately matches an INVOCATION (the name followed by an opening
  -- paren) after stripping `--` line comments, not any textual mention.
  -- election_day_login_v3's body carries the descriptive comment
  -- "-- election_day_login_v2's established behaviour exactly", and a naive
  -- substring match flags that as a dependency - which it is not. Stripping
  -- comments first and requiring a call shape keeps this gate meaningful
  -- instead of unfailable-by-accident.
  select coalesce(array_agg(p.proname), '{}') into v_referencing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname <> 'election_day_login_v2'
    and p.prokind = 'f'
    and regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g')
        ~ 'election_day_login_v2[[:space:]]*\(';

  if array_length(v_referencing, 1) is not null then
    raise exception
      'CONTRACT_GATE4_FAILED: election_day_login_v2 is still referenced by: %',
      array_to_string(v_referencing, ', ');
  end if;
end;
$$;

-- ============================================================================
-- The drop itself. Exact signature, no CASCADE - if anything unexpectedly
-- depends on this function, this statement must fail loudly rather than
-- quietly removing that dependent object too.
-- ============================================================================
drop function public.election_day_login_v2(p_name text, p_password text, p_session_hash bytea);

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration must be reversed; Supabase CLI migrations have no automatic
-- "down"). This is the verbatim definition as it stood immediately before the
-- drop, from 20260826010000_multi_tenant_phase3a_session_rpcs.sql.
--
-- READ THE ROLLBACK NOTE IN THIS FILE'S HEADER FIRST: recreating this
-- function also recreates the arbitrary-row login defect, which is only
-- harmless while exactly one workspace exists.
--
--   begin;
--   create or replace function public.election_day_login_v2(
--     p_name text,
--     p_password text,
--     p_session_hash bytea
--   )
--   returns table (
--     actor_id uuid,
--     actor_name text,
--     role_id uuid,
--     workspace_id uuid,
--     expires_at timestamptz
--   )
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     v_user_id uuid;
--     v_user_name text;
--     v_password_hash text;
--     v_role_id uuid;
--     v_workspace_id uuid;
--     v_expires_at timestamptz;
--   begin
--     if p_name is null or btrim(p_name) = ''
--        or p_password is null or p_password = ''
--        or p_session_hash is null
--     then
--       raise exception 'UNAUTHORIZED';
--     end if;
--
--     select u.id, u.name, u.password_hash, u.role_id, u.workspace_id
--       into v_user_id, v_user_name, v_password_hash, v_role_id, v_workspace_id
--     from public.election_day_permission_users u
--     where u.name = btrim(p_name);
--
--     if v_user_id is null
--        or v_password_hash is null
--        or extensions.crypt(p_password, v_password_hash) <> v_password_hash
--        or v_workspace_id is null
--     then
--       raise exception 'UNAUTHORIZED';
--     end if;
--
--     delete from public.election_day_sessions s
--     where s.permission_user_id = v_user_id and s.expires_at < now();
--
--     v_expires_at := now() + interval '24 hours';
--
--     insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
--     values (v_user_id, v_workspace_id, p_session_hash, v_expires_at);
--
--     return query select v_user_id, v_user_name, v_role_id, v_workspace_id, v_expires_at;
--   end;
--   $$;
--
--   revoke all on function public.election_day_login_v2(text, text, bytea) from public;
--   revoke all on function public.election_day_login_v2(text, text, bytea) from anon;
--   revoke all on function public.election_day_login_v2(text, text, bytea) from authenticated;
--   grant execute on function public.election_day_login_v2(text, text, bytea) to service_role;
--   commit;
-- ============================================================================
