-- Phase 3 Contract step: retire the 12 legacy `_v2` RPCs whose frontend
-- consumers were fully cut over to the trusted, session-derived v3/owner-v3
-- path across all 4 Phase 3 domains (Users, Roles, Coordinator/Allocation,
-- Import). Verified before this migration was authored:
--   - each of the 12 has exactly one caller, inside
--     src/services/api/supabaseElectionDayApi.ts, and that wrapper method
--     itself has zero callers anywhere else in src/ (either directly, or -
--     for the 4 Roles mutations - via useRoleManagement.ts, which is itself
--     unreferenced dead code since Role Management moved to the Owner-only
--     v3 surface).
--   - pg_depend/trigger/view sweep found zero dependent objects on any of
--     the 12.
--   - election_day_login_v2/election_day_logout_v2 are a separate, still
--     live, still-called (api/election-day/session.ts) RPC pair and are
--     deliberately NOT included here - they are not part of this Contract.
--
-- Default RESTRICT behavior is sufficient for all 12 - no CASCADE, no data
-- mutation, no unrelated ACL/schema change, no core/v3/owner-v3 function
-- touched.

drop function if exists public.election_day_apply_initial_allocation_v2(
  p_reauth_proof text, p_assignments jsonb
);

drop function if exists public.election_day_clone_role_v2(
  p_reauth_proof text, p_role_id uuid, p_new_name text
);

drop function if exists public.election_day_create_permission_user_v2(
  p_reauth_proof text, p_name text, p_password text, p_role_id uuid
);

drop function if exists public.election_day_create_role_v2(
  p_reauth_proof text, p_name text, p_description text, p_permissions text[], p_scope_type text
);

drop function if exists public.election_day_delete_permission_user_v2(
  p_reauth_proof text, p_target_user_id uuid
);

drop function if exists public.election_day_delete_role_v2(
  p_reauth_proof text, p_role_id uuid
);

drop function if exists public.election_day_end_coordinator_activity_v2(
  p_reauth_proof text, p_coordinator_id uuid, p_mode text, p_target_coordinator_id uuid
);

drop function if exists public.election_day_import_voters_v2(
  p_reauth_proof text, p_voters jsonb
);

drop function if exists public.election_day_manage_coordinators_v2(
  p_reauth_proof text, p_actions jsonb
);

drop function if exists public.election_day_rebalance_assignments_v2(
  p_reauth_proof text, p_sources jsonb, p_destinations jsonb
);

drop function if exists public.election_day_reset_permission_user_password_v2(
  p_reauth_proof text, p_target_user_id uuid, p_new_password text
);

drop function if exists public.election_day_update_role_v2(
  p_reauth_proof text, p_role_id uuid, p_name text, p_description text, p_permissions text[], p_scope_type text
);
