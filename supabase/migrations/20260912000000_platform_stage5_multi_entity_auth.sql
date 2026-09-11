-- Platform Stage 5: Multi-Entity Owner authentication (AAL2) and
-- entity-scoped authorization - the DB-authoritative half.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- Stage 4 created the singleton Multi-Entity seat and its workspace
-- assignments but conferred NO runtime access: nothing could resolve "is this
-- verified Supabase user the Multi-Entity Owner?" or "may they see this
-- workspace?". Stage 5 adds exactly those two answers, server-side, and
-- nothing else. No business/campaign data is readable through anything here -
-- the workspace projection is authorization metadata only (id, name,
-- election_end_at, assigned_at) and deliberately NEVER includes login_code.
--
-- Every function takes a SERVER-VERIFIED auth_user_id (api/platform/
-- _multiEntityAuth.ts resolves it via auth.getUser + getClaims(aal2)) and
-- re-derives everything else from committed rows at call time. Nothing is
-- cached and nothing is carried in JWT claims, so an unassignment or a seat
-- replacement takes effect on the very next request.
--
-- ============================================================================
-- SCOPE - additive, plus one privilege REVOKE on two existing tables
-- ============================================================================
--   functions ............... +4 new, 0 replaced
--     multi_entity_resolve_owner_context(uuid)             service_role
--     multi_entity_assert_workspace_assigned(uuid, uuid)   NO role (internal)
--     multi_entity_list_assigned_workspaces(uuid)          service_role
--     multi_entity_get_assigned_workspace(uuid, uuid)      service_role
--   table ACL ............... service_role loses its (default-granted) direct
--                             privileges on multi_entity_owner and
--                             multi_entity_assignments
--   tables / columns / constraints / indexes / triggers / RLS policies .. 0
--
-- ============================================================================
-- EXCLUSIVE PRINCIPAL (D-8 hardening on the Multi-Entity side)
-- ============================================================================
-- D-6 is enforced only at provisioning time, so a seat holder could later be
-- made a Platform or Election Owner by direct SQL (no app or committed
-- operator path does this - both always mint a NEW Auth account). Once the
-- seat confers runtime authority, such an identity would satisfy two
-- verifiers with one JWT. The resolver therefore accepts an identity ONLY when
-- the existing Stage 4B helper multi_entity_auth_user_held_by() resolves it to
-- exactly 'multi_entity'. That helper checks platform_owners, then
-- election_owners, then multi_entity_owner, in that order - so 'multi_entity'
-- means "holds the seat AND no other owner role". Reusing it keeps ONE
-- definition of principal-role resolution. The reverse direction (a dual
-- identity keeping its Platform/Election authority) is the documented D-8
-- residual and is not changed here.
--
-- ============================================================================
-- ENTITY-SCOPED AUTHORIZATION PRIMITIVE
-- ============================================================================
-- multi_entity_assert_workspace_assigned() is the single per-workspace gate.
-- It is granted to NO role at all (the election_day_verify_and_consume_owner_
-- proof / multi_entity_auth_user_held_by precedent): it is callable only from
-- inside another postgres-owned SECURITY DEFINER function. Stage 6 read RPCs
-- MUST call it inside their own body, i.e. in the same transaction and the
-- same snapshot as their read - never "check via one RPC, then read via
-- another", which would be a TOCTOU. An unassigned workspace and a
-- nonexistent workspace raise the SAME error, so the gate cannot be used to
-- enumerate workspace ids.
--
-- All four functions are STABLE: within one call every statement sees the
-- snapshot of the calling query, so the seat check and the read it guards
-- cannot straddle a concurrent replacement/unassignment commit.
--
-- ============================================================================
-- FUNCTION PRIVILEGE HARDENING (project guardrail - not optional)
-- ============================================================================
-- Hosted Production AND (verified 2026-09-11) the current local stack both
-- carry a pg_default_acl entry that auto-grants EXECUTE to anon and
-- authenticated on every new function in schema public, and
-- `revoke ... from public` alone does NOT undo an individually-named-role
-- default privilege. Every function below therefore revokes EXECUTE from
-- PUBLIC, anon and authenticated BY EXACT SIGNATURE, then grants EXECUTE to
-- service_role only where the API needs it. After applying to Production,
-- read pg_proc.proacl there directly.
--
-- ============================================================================
-- TABLE PRIVILEGE HARDENING
-- ============================================================================
-- Stage 4A revoked anon/authenticated on both tables but left service_role's
-- default-granted arwdDxtm in place (recorded residual). From Stage 5 on,
-- multi_entity_owner.auth_user_id is an AUTHORITY source: a direct
-- service_role UPDATE of it would bypass the seat advisory lock, the D-6
-- checks and the audit trail. Every access path - api/ included (it uses RPC
-- only, never .from()) - is a postgres-owned SECURITY DEFINER function, and
-- FK cascades (auth.users -> multi_entity_owner, election_workspaces ->
-- multi_entity_assignments) run with the table owner's privileges, so this
-- revoke removes nothing the application uses. Same reasoning as Stage 4A's
-- own revoke on multi_entity_audit.
--
-- ============================================================================
-- WHAT THIS MIGRATION DOES NOT DO
-- ============================================================================
--   - No change to any existing function, table, column, constraint, index,
--     trigger or RLS policy.
--   - No change to anon/authenticated privileges on any table.
--   - No business-data read path of any kind (Stage 6).
-- ============================================================================

begin;

-- ===========================================================================
-- 1. multi_entity_resolve_owner_context - "is this verified id the CURRENT,
--    EXCLUSIVE Multi-Entity Owner?"
-- ===========================================================================
create or replace function public.multi_entity_resolve_owner_context(
  p_auth_user_id uuid
)
returns table (
  auth_user_id uuid,
  name text
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  if p_auth_user_id is null then
    raise exception 'UNAUTHORIZED';
  end if;

  -- One definition of principal-role resolution: the Stage 4B helper. Only
  -- 'multi_entity' is acceptable - 'platform' / 'election' mean the identity
  -- also holds another owner role (D-8), NULL / 'pending_owner' mean it does
  -- not hold the seat at all.
  if public.multi_entity_auth_user_held_by(p_auth_user_id)
       is distinct from 'multi_entity' then
    raise exception 'UNAUTHORIZED';
  end if;

  return query
    select m.auth_user_id, m.name
    from public.multi_entity_owner m
    where m.auth_user_id = p_auth_user_id;

  if not found then
    raise exception 'UNAUTHORIZED';
  end if;
end;
$fn$;

comment on function public.multi_entity_resolve_owner_context(uuid) is
  'Stage 5: resolves a SERVER-VERIFIED auth_user_id to the current Multi-Entity Owner seat. Returns exactly one row (auth_user_id, name) iff the id holds the singleton seat AND multi_entity_auth_user_held_by() resolves it to exactly ''multi_entity'' (i.e. it holds no Platform/Election Owner role - D-8 hardening). Raises UNAUTHORIZED for NULL, a non-holder, a replaced holder, or a dual principal. The only check that confers Multi-Entity authority; aal2 is enforced by the caller. Read-only. service_role-only.';

revoke all on function public.multi_entity_resolve_owner_context(uuid) from public;
revoke all on function public.multi_entity_resolve_owner_context(uuid) from anon;
revoke all on function public.multi_entity_resolve_owner_context(uuid) from authenticated;
grant execute on function public.multi_entity_resolve_owner_context(uuid) to service_role;

-- ===========================================================================
-- 2. multi_entity_assert_workspace_assigned - the per-workspace gate
--    (INTERNAL: no role may call it directly).
-- ===========================================================================
create or replace function public.multi_entity_assert_workspace_assigned(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  -- Seat + exclusivity first; raises UNAUTHORIZED on any failure.
  perform 1 from public.multi_entity_resolve_owner_context(p_auth_user_id);

  -- Assigned-and-existing is the ONLY accepting state. A NULL id, an
  -- unassigned workspace and a nonexistent workspace are indistinguishable
  -- to the caller by design (no enumeration).
  if p_workspace_id is null or not exists (
    select 1
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    where a.workspace_id = p_workspace_id
  ) then
    raise exception 'WORKSPACE_NOT_ASSIGNED';
  end if;
end;
$fn$;

comment on function public.multi_entity_assert_workspace_assigned(uuid, uuid) is
  'Stage 5 INTERNAL helper - the single entity-scoped authorization gate. Raises UNAUTHORIZED unless p_auth_user_id is the current exclusive Multi-Entity Owner (via multi_entity_resolve_owner_context), and WORKSPACE_NOT_ASSIGNED unless p_workspace_id is currently assigned (unassigned and nonexistent are deliberately identical). Granted to NO role, service_role included: callable only from inside another postgres-owned SECURITY DEFINER function. Stage 6 read RPCs must call it in the same transaction as their read.';

revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from public;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from anon;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from authenticated;
revoke all on function public.multi_entity_assert_workspace_assigned(uuid, uuid) from service_role;

-- ===========================================================================
-- 3. multi_entity_list_assigned_workspaces - the seat's current scope.
-- ===========================================================================
create or replace function public.multi_entity_list_assigned_workspaces(
  p_auth_user_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  -- Self-authorizing: never trusts that the caller already checked the seat.
  perform 1 from public.multi_entity_resolve_owner_context(p_auth_user_id);

  -- Authorization metadata ONLY - never login_code (a workspace credential)
  -- and never any business column. Total order (name, then id) so the list
  -- is stable across reloads even when two workspaces share a name.
  return query
    select w.id, w.name, w.election_end_at, a.assigned_at
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    order by w.name asc, w.id asc;
end;
$fn$;

comment on function public.multi_entity_list_assigned_workspaces(uuid) is
  'Stage 5: the workspaces currently assigned to the Multi-Entity seat, for a SERVER-VERIFIED auth_user_id. Re-resolves the seat itself (raises UNAUTHORIZED otherwise). Projects exactly (workspace_id, name, election_end_at, assigned_at) - never login_code, never business data. Ordered name asc, workspace_id asc. Read-only. service_role-only.';

revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from public;
revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from anon;
revoke all on function public.multi_entity_list_assigned_workspaces(uuid) from authenticated;
grant execute on function public.multi_entity_list_assigned_workspaces(uuid) to service_role;

-- ===========================================================================
-- 4. multi_entity_get_assigned_workspace - one workspace, gated.
-- ===========================================================================
create or replace function public.multi_entity_get_assigned_workspace(
  p_auth_user_id uuid,
  p_workspace_id uuid
)
returns table (
  workspace_id uuid,
  name text,
  election_end_at timestamptz,
  assigned_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $fn$
begin
  -- The gate and the read share this call's snapshot - no TOCTOU.
  perform public.multi_entity_assert_workspace_assigned(p_auth_user_id, p_workspace_id);

  return query
    select w.id, w.name, w.election_end_at, a.assigned_at
    from public.multi_entity_assignments a
    join public.election_workspaces w on w.id = a.workspace_id
    where a.workspace_id = p_workspace_id;
end;
$fn$;

comment on function public.multi_entity_get_assigned_workspace(uuid, uuid) is
  'Stage 5: authorization metadata for ONE workspace, gated by multi_entity_assert_workspace_assigned in the same snapshot. Raises UNAUTHORIZED (not the current exclusive seat holder) or WORKSPACE_NOT_ASSIGNED (unassigned OR nonexistent - identical by design). Projects exactly (workspace_id, name, election_end_at, assigned_at) - never login_code. Read-only. service_role-only.';

revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from public;
revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from anon;
revoke all on function public.multi_entity_get_assigned_workspace(uuid, uuid) from authenticated;
grant execute on function public.multi_entity_get_assigned_workspace(uuid, uuid) to service_role;

-- ===========================================================================
-- 5. TABLE-LEVEL ACL HARDENING - RPC-only access to the seat and assignments.
-- ===========================================================================
revoke all on table public.multi_entity_owner from service_role;
revoke all on table public.multi_entity_assignments from service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - Supabase CLI migrations have no automatic "down").
-- Revert the APPLICATION first: the deployed app calls these RPCs.
--
--   drop function if exists public.multi_entity_get_assigned_workspace(uuid, uuid);
--   drop function if exists public.multi_entity_list_assigned_workspaces(uuid);
--   drop function if exists public.multi_entity_assert_workspace_assigned(uuid, uuid);
--   drop function if exists public.multi_entity_resolve_owner_context(uuid);
--   -- Restore EXACTLY the pre-apply table ACL captured at the Production
--   -- pre-apply gate. The local value before this migration was
--   -- service_role=arwdDxtm/postgres on both tables, i.e.:
--   grant select, insert, update, delete, truncate, references, trigger, maintain
--     on table public.multi_entity_owner to service_role;
--   grant select, insert, update, delete, truncate, references, trigger, maintain
--     on table public.multi_entity_assignments to service_role;
-- ============================================================================
