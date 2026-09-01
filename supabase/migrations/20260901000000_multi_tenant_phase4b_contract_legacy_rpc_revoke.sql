-- Multi-Tenant Phase 4B Contract: revoke anon/authenticated EXECUTE on the 10
-- legacy (pre-multi-tenant) Election Day RPCs left frontend-unreachable by the
-- Frontend Cutover (commit fdf3034). REVOKE EXECUTE only - no DROP - matching
-- this project's established retirement pattern (election_day_login /
-- election_day_list_permission_users / election_day_list_roles). Their
-- replacements (_core/_v3/_owner_v3, workspace-scoped) are untouched by this
-- migration and remain the sole live path for these operations.
--
-- Approved by the system owner as READY TO REVOKE after a read-only Contract
-- Readiness Audit (repo-wide zero callers, zero DB dependents) - see
-- CURRENT_STATUS.md's Multi-Tenant Phase 4B Contract Readiness Audit /
-- Contract Safety Gate sections for the full evidentiary record.

revoke execute on function public.election_day_set_reminder(uuid, timestamptz, text) from anon, authenticated;
revoke execute on function public.election_day_close_reminder(uuid, text) from anon, authenticated;
revoke execute on function public.election_day_cancel_reminder(uuid, text) from anon, authenticated;
revoke execute on function public.election_day_set_voted(uuid, boolean, text) from anon, authenticated;
revoke execute on function public.election_day_set_non_voting_reason(uuid, uuid, text) from anon, authenticated;
revoke execute on function public.election_day_record_no_answer(uuid, uuid, text) from anon, authenticated;
revoke execute on function public.election_day_record_call_answered(uuid, uuid, text) from anon, authenticated;
revoke execute on function public.election_day_extend_no_answer_streak_threshold(uuid, text) from anon, authenticated;
revoke execute on function public.election_day_create_non_voting_reason(text, text, boolean) from anon, authenticated;
revoke execute on function public.election_day_update_non_voting_reason(uuid, text, text, boolean) from anon, authenticated;
