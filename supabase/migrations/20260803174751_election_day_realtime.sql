-- Enables live cross-device sync (product decision, approved: Realtime
-- from the first release, not deferred) for the two tables that actually
-- change during an active election-day session. election_day_ride_
-- coordinators / election_day_settings / election_day_permission_users are
-- low-frequency admin config, not added here - can be added later with a
-- follow-up migration if a real need for live sync on them appears.
--
-- Realtime respects RLS: since election_day_voters and
-- election_day_ride_status_events both carry the permissive Strategy A
-- policies from the "election_day_core_rls" migration, subscribers using
-- the anon key receive change events exactly as freely as they can already
-- SELECT the underlying rows - no additional exposure beyond what direct
-- reads already allow.
--
-- Assumes the standard Supabase-provisioned "supabase_realtime" publication
-- already exists on this project (created automatically by the platform,
-- not by app migrations) - to be confirmed at push time (see report).

alter publication supabase_realtime add table public.election_day_voters;
alter publication supabase_realtime add table public.election_day_ride_status_events;

-- ============================================================================
-- ROLLBACK (manual):
--
--   alter publication supabase_realtime drop table public.election_day_ride_status_events;
--   alter publication supabase_realtime drop table public.election_day_voters;
-- ============================================================================
