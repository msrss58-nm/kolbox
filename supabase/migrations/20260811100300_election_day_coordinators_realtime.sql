-- Coordinator Allocation Management - Phase 1 (DB foundation), step 4/5.
-- Adds election_day_coordinators to Realtime, mirroring the existing
-- election_day_realtime migration's rationale: this table changes during an
-- active election-day session (coordinators added/ended, links set) and
-- benefits from live cross-device sync the same way election_day_voters /
-- election_day_ride_status_events already do.
--
-- election_day_coordinator_operations / election_day_coordinator_operation_items
-- are deliberately NOT added here (product decision, locked) - there is no
-- History UI in V1, so no realtime need exists yet; can be added later with
-- a follow-up migration if a real need appears, same escape hatch already
-- used for election_day_ride_coordinators/election_day_settings/
-- election_day_permission_users.
--
-- Realtime respects RLS: election_day_coordinators carries only a SELECT
-- policy (see the table's own migration) - subscribers using the anon key
-- receive change events exactly as freely as they can already SELECT the
-- underlying rows, no additional exposure. Assumes the standard
-- Supabase-provisioned "supabase_realtime" publication already exists on
-- this project, same assumption as the original election_day_realtime
-- migration.

alter publication supabase_realtime add table public.election_day_coordinators;

-- ============================================================================
-- ROLLBACK (manual):
--
--   alter publication supabase_realtime drop table public.election_day_coordinators;
-- ============================================================================
