-- Phase 3C Roles - trusted, workspace-scoped role-catalog READ. Net-new,
-- additive, service_role-only - mirrors election_day_list_permission_users_v3's
-- already-shipped architecture exactly (20260828000000).
--
-- ROOT ISSUE (unchanged from the prior Roles audit, restated here for this
-- migration's own record): election_day_list_roles() - still current,
-- anon/authenticated-reachable, unchanged since 20260805190000 - returns
-- every role row with NO workspace_id filter and no caller-identity check of
-- any kind. Not exploitable in Production today (exactly one workspace
-- exists), but the same defect class already fixed for the PermissionUser
-- roster read.
--
-- This migration is READ-ONLY EXPAND: it adds election_day_list_roles_v3
-- alongside the untouched legacy election_day_list_roles(). It does NOT
-- retire, REVOKE, or modify the legacy function or its grants in any way -
-- retirement is a separate, later, explicitly-approved step, exactly like
-- every other legacy-RPC retirement in this project. It does NOT touch role
-- MUTATION authority (create/update/delete/clone_role_v2) at all - those
-- remain exactly as hardened by 20260828030000, still PermissionUser-
-- reauth-proof-gated.
--
-- Design, matching election_day_list_permission_users_v3 exactly:
--   - Session-derived only (election_day_resolve_session) - no reauth proof
--     required, matching this project's established "reads don't require
--     step-up" convention (election_day_list_permission_users_v3 and the
--     legacy election_day_list_roles() itself have never required one).
--   - Returns exactly the same row shape as the legacy function
--     (id, name, description, permissions, scope_type, scope_value) so the
--     frontend's existing RawRoleRow/normalizeRoleRecord validation
--     (src/permissions/roleRecordMapper.ts) needs zero change - only the
--     transport (direct anon-key RPC call vs. a trusted Vercel endpoint)
--     changes, never the row contract.
--   - WHERE r.workspace_id = <session-resolved workspace> - the one
--     substantive difference from the legacy function's unfiltered read.
--   - ORDER BY r.created_at ASC - same ordering as the legacy function, so
--     switching the read path changes no visible row order.
--   - service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever - only
--     a trusted Vercel Server Function holding the service_role key may
--     call this, exactly like every other _v3/session RPC.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines
-- a file's statements via wire-protocol batching, not an implicit
-- transaction.
begin;

create or replace function public.election_day_list_roles_v3(
  p_session_hash bytea
)
returns table (
  id uuid,
  name text,
  description text,
  permissions text[],
  scope_type text,
  scope_value jsonb
)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_workspace_id uuid;
begin
  select r.workspace_id into v_workspace_id
  from public.election_day_resolve_session(p_session_hash) r;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.workspace_id = v_workspace_id
    order by r.created_at asc;
end;
$$;

comment on function public.election_day_list_roles_v3(bytea) is
  'Phase 3C Roles: session-derived, WORKSPACE-SCOPED replacement for election_day_list_roles() (which returns every workspace''s role catalog with no filter at all). Requires only a currently-valid session (via election_day_resolve_session - UNAUTHORIZED propagates from there for an invalid/expired session); no reauth proof, matching this project''s existing "reads don''t require step-up" convention. Returns the same row shape as the legacy function (id, name, description, permissions, scope_type, scope_value), filtered to the session''s own resolved workspace_id and ordered identically (created_at asc). service_role-only: no PUBLIC/anon/authenticated EXECUTE. Does not touch role MUTATION authority (create/update/delete/clone_role_v2, hardened separately in 20260828030000) or the legacy election_day_list_roles(), which is NOT retired or touched by this migration and remains reachable until a separate, later, explicit cutover/retirement decision.';

-- Per CLAUDE.md's Permanent Engineering Guardrail (added after a real
-- Production privilege-escalation incident): a bare absence of GRANT
-- statements is NOT sufficient on this project's hosted Production instance,
-- which is confirmed to carry a project-level pg_default_acl entry that
-- auto-grants EXECUTE to anon/authenticated (and, per the Phase 3C Users
-- migration's own empirical local-disposable reproduction, also to
-- service_role) on every newly-created function in schema public. Every
-- role must be REVOKEd BY NAME, explicitly - matching election_day_list_
-- permission_users_v3's own precedent exactly.
revoke all on function public.election_day_list_roles_v3(bytea) from public;
revoke all on function public.election_day_list_roles_v3(bytea) from anon;
revoke all on function public.election_day_list_roles_v3(bytea) from authenticated;
grant execute on function public.election_day_list_roles_v3(bytea) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   drop function if exists public.election_day_list_roles_v3(bytea);
-- ============================================================================
