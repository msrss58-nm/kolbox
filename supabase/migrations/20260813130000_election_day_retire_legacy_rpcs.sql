-- Security Phase 3 - retires the 12 legacy (non-_v2) Election Day RPCs that
-- Security Phase 1 (20260813110100) and Phase 2 (20260813120000) each
-- replaced with a proof-based _v2 equivalent. Both prior migrations'
-- header comments already committed to this exact mechanism: "Retirement
-- (REVOKE EXECUTE on the old names) is a deliberately separate, later,
-- explicitly-approved Security Phase 3."
--
-- REVOKE EXECUTE, not DROP FUNCTION: the function bodies stay intact so a
-- single re-GRANT (see ROLLBACK below) is enough to restore compatibility
-- if something unexpected depends on a legacy name - no re-authoring, no
-- schema risk, no data touched (none of these 12 own any table). anon/
-- authenticated lose the ability to call them; the functions remain owned
-- by the same role and still exist for inspection/audit.
--
-- Verified before writing this migration (see this session's Phase 3
-- report): every live `.rpc(...)` call site in src/services/api/
-- supabaseElectionDayApi.ts already targets the _v2 name for all 12 of
-- these; the only remaining non-_v2 references anywhere in src/ are
-- comments/type-doc strings. election_day_create_permission_user_v2 has
-- no bootstrap/empty-roster exception (by design, unconditional
-- electionDay.manageUsers requirement - see its own comment in
-- 20260813110100), and the frontend's bootstrap window
-- (ElectionDayPermissionsPage.tsx, electionDay.isBootstrap) already
-- renders a static, non-mutating setup-required state instead of calling
-- either the v1 or v2 create-permission-user RPC - so retiring v1 here
-- does not remove any reachable bootstrap path, because the app was
-- already not using it.
begin;

-- Security Phase 1 legacy RPCs (replaced by their _v2 counterpart in
-- 20260813110100_election_day_admin_v2_rpcs.sql):
revoke execute on function public.election_day_create_permission_user(text, text, uuid) from anon, authenticated;
revoke execute on function public.election_day_delete_permission_user(uuid) from anon, authenticated;
revoke execute on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) from anon, authenticated;
revoke execute on function public.election_day_create_role(text, text, text[], text) from anon, authenticated;
revoke execute on function public.election_day_update_role(uuid, text, text, text[], text) from anon, authenticated;
revoke execute on function public.election_day_delete_role(uuid) from anon, authenticated;
revoke execute on function public.election_day_clone_role(uuid, text) from anon, authenticated;
revoke execute on function public.election_day_import_voters(jsonb) from anon, authenticated;

-- Security Phase 2 legacy RPCs (replaced by their _v2 counterpart in
-- 20260813120000_election_day_allocation_v2_rpcs.sql):
revoke execute on function public.election_day_manage_coordinators(uuid, text, jsonb) from anon, authenticated;
revoke execute on function public.election_day_apply_initial_allocation(uuid, text, jsonb) from anon, authenticated;
revoke execute on function public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb) from anon, authenticated;
revoke execute on function public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid) from anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual, restores legacy compatibility - functions were never
-- dropped, so this is the only step needed):
--
--   begin;
--   grant execute on function public.election_day_create_permission_user(text, text, uuid) to anon, authenticated;
--   grant execute on function public.election_day_delete_permission_user(uuid) to anon, authenticated;
--   grant execute on function public.election_day_reset_permission_user_password(uuid, text, uuid, text) to anon, authenticated;
--   grant execute on function public.election_day_create_role(text, text, text[], text) to anon, authenticated;
--   grant execute on function public.election_day_update_role(uuid, text, text, text[], text) to anon, authenticated;
--   grant execute on function public.election_day_delete_role(uuid) to anon, authenticated;
--   grant execute on function public.election_day_clone_role(uuid, text) to anon, authenticated;
--   grant execute on function public.election_day_import_voters(jsonb) to anon, authenticated;
--   grant execute on function public.election_day_manage_coordinators(uuid, text, jsonb) to anon, authenticated;
--   grant execute on function public.election_day_apply_initial_allocation(uuid, text, jsonb) to anon, authenticated;
--   grant execute on function public.election_day_rebalance_assignments(uuid, text, jsonb, jsonb) to anon, authenticated;
--   grant execute on function public.election_day_end_coordinator_activity(uuid, text, uuid, text, uuid) to anon, authenticated;
--   commit;
-- ============================================================================
