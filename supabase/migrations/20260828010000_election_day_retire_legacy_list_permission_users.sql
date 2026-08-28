-- Retires the legacy, cross-workspace-unscoped `election_day_list_permission_users()`
-- roster RPC from anon/authenticated access. This is the second and final
-- half of the CRITICAL cross-workspace finding documented in
-- 20260828000000_election_day_phase3c_users_containment_and_v3.sql - that
-- migration contained the delete/reset side; this one closes the
-- roster-enumeration side by revoking the unscoped read entirely, now that
-- nothing needs it.
--
-- Verified before writing this migration (see CURRENT_STATUS.md's
-- "LEGACY ROSTER RPC RETIREMENT PRE-FLIGHT" and this same-session follow-up
-- entries for the full evidence):
--   - Zero live frontend callers remain. `useElectionDay.ts`'s roster read
--     was cut over to the trusted, session-scoped
--     `election_day_list_permission_users_v3` (via `GET /api/election-day/
--     permission-users`) in a prior commit (`a2cb85b`). `ElectionDayGuard.tsx`'s
--     own pre-session bootstrap bypass - the other historical caller - was
--     removed entirely in a later commit (`c935f4e`, already pushed and
--     deployed to Production): it had no reachable create-first-user path
--     left behind it, so all it still did was expose Dashboard/Voters to an
--     unauthenticated browser whenever the (global, unscoped) roster
--     happened to be empty.
--   - A repository-wide source-text scan (not `src/`-only) confirms no other
--     database function's body calls this RPC internally, and no view or
--     trigger anywhere in this project's migration history depends on it.
--   - The only two repo hits that resemble "runtime use" are (a)
--     `scripts/drive-bootstrap.mjs`, a protected Playwright-driving script
--     that `page.route()`-intercepts this RPC's REST URL client-side and
--     answers it with a fake body - by its own header comment it "never
--     touches the real roster" and never reaches Supabase at all, so it has
--     no dependency on this function's grants; and (b)
--     `scripts/smoke-multi-tenant-phase2-contract-schema.ts`, which asserts
--     this function's continued EXISTENCE by name via `pg_proc.proname` -
--     unaffected by a grants-only REVOKE, since the function is not dropped.
--
-- REVOKE EXECUTE only, not DROP FUNCTION - matching this project's own
-- established Security Phase 3 retirement precedent
-- (20260813130000_election_day_retire_legacy_rpcs.sql): the function body
-- stays completely intact, so a single re-GRANT (see ROLLBACK below) is
-- enough to restore compatibility if an unexpected dependency ever surfaces
-- - no re-authoring, no schema risk, no data touched (this function owns no
-- table). `postgres` (owner) and `service_role` keep EXECUTE, unchanged -
-- neither was ever the point of this revoke, and nothing in this project
-- calls this RPC as `service_role` (the trusted v3 replacement is its own,
-- separate, already service_role-only function).
--
-- No business-data mutation of any kind - this migration touches only one
-- function's grants.
begin;

revoke execute on function public.election_day_list_permission_users() from anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual, restores legacy compatibility - the function was never
-- dropped, so this is the only step needed):
--
--   grant execute on function public.election_day_list_permission_users() to anon, authenticated;
-- ============================================================================
