-- Phase 3C Roles Mutations: Frontend Owner Bridge + Owner-only Cutover -
-- Owner-scoped role-catalog READ. Net-new, additive, service_role-only -
-- mirrors election_day_list_roles_v3's own architecture (20260828040000),
-- swapping only the identity source: a server-verified Owner auth_user_id
-- (via election_day_resolve_owner_context, 20260828060000) instead of a
-- PermissionUser session hash.
--
-- WHY THIS IS NEEDED: the existing trusted role read (election_day_list_
-- roles_v3, consumed by api/election-day/roles.ts) requires a PermissionUser
-- HttpOnly session cookie. An Election Owner authenticates via real Supabase
-- Auth (auth.users), not the PermissionUser name/password system, and must
-- never need a PermissionUser session merely to view/manage their own
-- workspace's Roles - this function closes that gap.
--
-- Design, matching election_day_list_roles_v3 exactly:
--   - Live-resolves {owner_id, workspace_id} from a SERVER-VERIFIED
--     p_auth_user_id via election_day_resolve_owner_context - UNAUTHORIZED
--     propagates from there for a non-Owner or removed-Owner auth_user_id.
--     No workspace_id is ever accepted from the client.
--   - Returns exactly the same row shape as election_day_list_roles_v3 /
--     the legacy election_day_list_roles() (id, name, description,
--     permissions, scope_type, scope_value) - the frontend's existing
--     RawRoleRow/normalizeRoleRecord validation needs zero change.
--   - WHERE r.workspace_id = <owner-resolved workspace>, ORDER BY
--     r.created_at ASC - identical filter/ordering semantics.
--   - Read-only; no reauth proof required, matching this project's
--     established "reads don't require step-up" convention (also true of
--     election_day_owner_reauth's own mutation-only step-up requirement -
--     reads were never gated behind it).
--   - service_role-only: no PUBLIC/anon/authenticated EXECUTE, ever.
--
-- Does NOT touch election_day_list_roles_v3, election_day_list_roles(), or
-- any Role mutation RPC (legacy _v2 or Owner-only _v3) - strictly additive,
-- parallel to everything that already exists. Not wired into any live
-- frontend by this migration itself (the companion frontend cutover in this
-- same task wires it into a new Owner-only UI surface, never into the
-- PermissionUser-facing Role Management screen).
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project: the Supabase CLI's migration runner pipelines a
-- file's statements via wire-protocol batching, not an implicit transaction.
begin;

create or replace function public.election_day_list_roles_owner_v3(
  p_auth_user_id uuid
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
  select o.workspace_id into v_workspace_id
  from public.election_day_resolve_owner_context(p_auth_user_id) o;

  return query
    select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value
    from public.election_day_roles r
    where r.workspace_id = v_workspace_id
    order by r.created_at asc;
end;
$$;

comment on function public.election_day_list_roles_owner_v3(uuid) is
  'Phase 3C Roles Mutations: Owner-scoped, WORKSPACE-FILTERED role-catalog read. Requires only a SERVER-VERIFIED auth_user_id resolving to a live election_owners row (via election_day_resolve_owner_context - UNAUTHORIZED propagates from there for a non-Owner or removed-Owner identity); no reauth proof, matching this project''s existing "reads don''t require step-up" convention. Returns the same row shape as election_day_list_roles_v3/the legacy election_day_list_roles() (id, name, description, permissions, scope_type, scope_value), filtered to the Owner''s own resolved workspace_id, ordered identically (created_at asc). service_role-only: no PUBLIC/anon/authenticated EXECUTE. Does not touch election_day_list_roles_v3, election_day_list_roles(), or any Role mutation RPC.';

revoke all on function public.election_day_list_roles_owner_v3(uuid) from public;
revoke all on function public.election_day_list_roles_owner_v3(uuid) from anon;
revoke all on function public.election_day_list_roles_owner_v3(uuid) from authenticated;
grant execute on function public.election_day_list_roles_owner_v3(uuid) to service_role;

commit;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the target database if this
-- migration needs to be reversed; Supabase CLI migrations have no automatic
-- "down"):
--
--   drop function if exists public.election_day_list_roles_owner_v3(uuid);
-- ============================================================================
