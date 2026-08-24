-- Multi-Tenant Phase 2 - Contract step: remove the one-time historical
-- Backfill RPC now that the single real Production run it existed for
-- (workspace "מודיעין") has completed and passed post-flight verification.
--
-- Safe to remove: pg_depend/trigger/view sweep against Production found zero
-- dependent objects, and no application runtime code (src/) ever calls this
-- function - only the one-time backfill orchestration tooling under
-- scripts/lib does, and its one legitimate invocation is already consumed
-- (the function's own fixed-key advisory lock + existence check would
-- refuse a second workspace even if it still existed). Default RESTRICT
-- behavior is sufficient - no CASCADE, no data mutation, no unrelated
-- ACL/schema change.

drop function if exists public.election_day_backfill_historical_workspace(
  uuid, text, timestamptz, text, text, text
);
