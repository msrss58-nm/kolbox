-- Multi-Tenant Phase 2 - SECURITY HOTFIX: close a live Production
-- privilege-escalation gap on election_day_backfill_historical_workspace.
--
-- Incident: the prior migration (20260824010000) created this function and
-- ran `revoke all on function ... from public;` before granting execute
-- only to service_role - correct in isolation, but insufficient on this
-- Production project specifically. Direct inspection of Production's own
-- pg_default_acl (read-only, not simulated) found an existing per-role
-- default-privilege entry for role postgres, schema public, objtype 'f'
-- (functions): `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,
-- service_role=X/postgres}` - a legacy "auto-expose new functions" default
-- privilege configuration on this specific hosted project that this
-- repo's disposable local replicas do not have (local Supabase CLI's own
-- config.toml documents this exact "new cloud default vs legacy" split).
-- REVOKE ... FROM PUBLIC never touches these individually-named-role
-- default grants - only an explicit REVOKE naming each role does. This
-- migration is that explicit, targeted fix: nothing else about the
-- function (body, business logic, SECURITY DEFINER, search_path, the
-- service_role grant itself) changes.
--
-- Scope, deliberately narrow: only the EXECUTE ACL on this one function.
-- Does NOT touch ALTER DEFAULT PRIVILEGES (the underlying legacy
-- configuration that caused this - fixing that globally is a separate,
-- larger, not-yet-approved change and is out of scope for this hotfix).
-- Does NOT modify the function body/definition in any way.

revoke execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) from public;
revoke execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) from anon;
revoke execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) from authenticated;
grant execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) to service_role;

-- ============================================================================
-- ROLLBACK (manual - copy/paste and run against the remote if this hotfix
-- needs to be reversed; not expected to ever be needed, since it only
-- narrows access - reversing it would re-open the gap this migration
-- exists to close):
--
--   grant execute on function public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) to anon, authenticated;
-- ============================================================================
