-- Dynamic Roles & Permissions - Phase 1: the read-only RPC the frontend
-- permission engine will load the role catalog through, replacing the
-- hardcoded PERMISSIONS_BY_ROLE map. This migration only adds the RPC -
-- it does not change any existing table, data, or the login/session RPCs.
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project (see election_day_voting_role /
-- election_day_dynamic_roles_phase0): the Supabase CLI's migration runner
-- pipelines a file's statements via wire-protocol batching, not an implicit
-- transaction - without this wrapper, a failure between the CREATE FUNCTION
-- and the REVOKE/GRANT below could leave the function callable with the
-- wrong privileges until a retry completes.
begin;

-- election_day_list_roles ----------------------------------------------------
-- Lists the full election_day_roles catalog (Phase 0's table) so the
-- frontend can resolve a session's legacy role text into the RoleRecord
-- that actually governs its permissions/scope. SECURITY DEFINER (bypasses
-- the table's RLS-enabled/zero-policy lockdown, same pattern as every other
-- election_day_* roster RPC), `set search_path = ''` with fully
-- schema-qualified references - standard hardening against
-- search_path-hijacking of SECURITY DEFINER functions. STABLE: read-only,
-- no side effects, safe for the planner to fold within one statement.
create or replace function public.election_day_list_roles()
returns table (
  id uuid,
  name text,
  description text,
  permissions text[],
  scope_type text,
  scope_value jsonb,
  legacy_role_key text
)
language sql
security definer
set search_path = ''
stable
as $$
  select r.id, r.name, r.description, r.permissions, r.scope_type, r.scope_value, r.legacy_role_key
  from public.election_day_roles r
  order by r.created_at asc;
$$;

comment on function public.election_day_list_roles() is
  'Dynamic Roles & Permissions, Phase 1: lists the election_day_roles catalog (id/name/description/permissions/scope_type/scope_value/legacy_role_key) for the frontend permission engine. Read-only, STABLE. Like election_day_list_permission_users(), this RPC has NO caller-identity check - reachable by anyone holding the anon key, not only a signed-in Election Day session. This is the same already-documented, already-accepted limitation of the existing Election Day security model (see CLAUDE.md "Known Security Limitations" - PermissionUser has no real Supabase Auth identity behind it), not a new gap introduced by this migration and not a change to the login/session model. The frontend never sends passwords/secrets through this RPC and it never returns anything from election_day_permission_users.';

revoke all on function public.election_day_list_roles() from public;
grant execute on function public.election_day_list_roles() to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--   begin;
--   drop function if exists public.election_day_list_roles();
--   commit;
-- ============================================================================
