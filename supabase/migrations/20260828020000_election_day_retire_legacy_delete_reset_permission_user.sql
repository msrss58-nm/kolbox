-- Retires the legacy, general-purpose-reauth-proof-gated
-- `election_day_delete_permission_user_v2` / `election_day_reset_permission_
-- user_password_v2` RPCs from anon/authenticated access, now that the
-- frontend delete/reset trusted-v3 cutover (useDeletePermissionUserTrusted.ts
-- / useResetPermissionUserPasswordTrusted.ts, wired into useElectionDay.ts in
-- commit e2da4df) is live and verified in Production.
--
-- Verified before writing this migration (see CURRENT_STATUS.md's
-- "READ-ONLY RETIREMENT PRE-FLIGHT FOR LEGACY DELETE/RESET RPCs" entry for
-- the full evidence):
--   - Zero live runtime callers remain. `useElectionDay.ts`'s
--     `deletePermissionUser`/`resetPermissionUserPassword` call the trusted
--     v3 hooks exclusively; `api.deletePermissionUser`/
--     `api.resetPermissionUserPassword` (the `ApiClient` methods that still
--     call these two `_v2` RPCs) have zero callers anywhere in `src/`/`api/`/
--     `scripts/` (repo-wide grep, not `src/`-only).
--   - A direct `pg_depend` query against Production (not just a source-text
--     scan) confirms zero database objects depend on either function.
--   - Neither function's own body is depended upon by any OTHER function -
--     a repository-wide migration-source scan (valid given Production's
--     confirmed 60/60 zero-drift state) found no other function invoking
--     either RPC as an inner call.
--   - The shared `election_day_reauth` / `election_day_verify_reauth_proof`
--     infrastructure (still used by the remaining 9 legacy reauth-gated
--     actions: import, 4 role-management, 4 coordinator-allocation) is a
--     completely separate pair of function objects with their own
--     independent grants - untouched by this migration, and structurally
--     incapable of being affected by a REVOKE scoped to two other function
--     signatures.
--   - Exact deployed signatures were verified live against Production
--     (not assumed): `election_day_delete_permission_user_v2(text, uuid)`
--     and `election_day_reset_permission_user_password_v2(text, uuid, text)`
--     - both take the raw legacy reauth-proof text and target id, never a
--     session hash (unlike their `_v3` replacements' `bytea` session/proof
--     hash parameters).
--
-- REVOKE EXECUTE only, not DROP FUNCTION - matching this project's own
-- established Security Phase 3 retirement precedent
-- (20260813130000_election_day_retire_legacy_rpcs.sql) and the immediately
-- preceding roster-RPC retirement
-- (20260828010000_election_day_retire_legacy_list_permission_users.sql):
-- both function bodies stay completely intact, so a single re-GRANT (see
-- ROLLBACK below) is enough to restore compatibility if an unexpected
-- dependency ever surfaces - no re-authoring, no schema risk, no data
-- touched (neither function owns a table). `postgres` (owner) and
-- `service_role` keep EXECUTE, unchanged - neither was ever the point of
-- this revoke, and nothing in this project calls either RPC as
-- `service_role` (the trusted v3 replacements are their own, separate,
-- already service_role-only functions).
--
-- No business-data mutation of any kind - this migration touches only two
-- functions' grants.
begin;

revoke execute on function public.election_day_delete_permission_user_v2(text, uuid)
  from anon, authenticated;

revoke execute on function public.election_day_reset_permission_user_password_v2(text, uuid, text)
  from anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual, restores legacy compatibility - neither function was
-- ever dropped, so this is the only step needed):
--
--   grant execute on function public.election_day_delete_permission_user_v2(text, uuid)
--     to anon, authenticated;
--
--   grant execute on function public.election_day_reset_permission_user_password_v2(text, uuid, text)
--     to anon, authenticated;
-- ============================================================================
