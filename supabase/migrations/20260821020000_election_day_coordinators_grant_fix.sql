-- Coordinator Allocation Management - least-privilege grant fix for
-- public.election_day_coordinators.
--
-- ============================================================================
-- WHAT THIS FIXES
-- ============================================================================
-- 20260811100100_election_day_coordinators_table.sql enabled RLS and created
-- a permissive SELECT policy (election_day_coordinators_select, to anon,
-- authenticated, using (true)) - but never issued the underlying table-level
-- GRANT SELECT that policy depends on. In Postgres, a RLS policy only
-- restricts which rows a role can see; it does not itself grant the role
-- access to the table. Without the grant, anon/authenticated get
-- `42501: permission denied for table election_day_coordinators` on every
-- read - confirmed directly against a fresh local Docker replay of every
-- tracked migration (has_table_privilege('anon', ...) = false), which is
-- also why listCoordinators() (supabaseElectionDayApi.ts) cannot load
-- anything and the "ניהול הקצאות" screen renders blank there.
--
-- Direct read-only verification against the linked Production project
-- (supabase db query --linked, has_table_privilege + information_schema
-- .role_table_grants + pg_policies) found Production is NOT missing the
-- grant - anon/authenticated already have it there - but with a broader
-- scope than ever intended: SELECT, INSERT, UPDATE, DELETE, REFERENCES,
-- TRIGGER, TRUNCATE, all granted by `postgres`, with no timestamp/actor
-- trail. This is the signature of a manual out-of-band GRANT ALL (Studio
-- table editor default, or a direct SQL-editor fix applied at some point to
-- unblock the feature) that was never captured in a tracked migration -
-- confirmed drift between Production and migration history, in the
-- direction of Production being AHEAD of (broader than) the repo, not
-- behind it.
--
-- No INSERT/UPDATE/DELETE policy exists on this table in Production (or
-- locally) - only the one SELECT policy - so RLS's deny-by-default-with-no-
-- matching-policy behavior already blocks every write from anon/authenticated
-- today regardless of the raw grant. The broader grant therefore has zero
-- operational effect right now, but is still unnecessary standing privilege
-- that should not exist, per this table's own original design ("Write
-- access is deliberately NOT open client CRUD ... only a SELECT policy is
-- added here" - 20260811100100's own header comment).
--
-- ============================================================================
-- WHY REVOKING THE EXTRA PRIVILEGES IS SAFE
-- ============================================================================
-- Verified directly (this migration's own prerequisite, not assumed):
--   - The ENTIRE frontend/API layer (src/) references
--     public.election_day_coordinators in exactly one place -
--     SupabaseElectionDayApi.listCoordinators()'s `.from(...).select("*")` -
--     plus one read-only Realtime subscription
--     (subscribeToCoordinatorChanges, `event: "*"`, which only requires the
--     existing SELECT policy to pass for a change to be delivered to a
--     listening client, not a raw INSERT/UPDATE/DELETE table grant). No
--     `.insert(`, `.update(`, or `.delete(` call against this table exists
--     anywhere in src/.
--   - No script under scripts/ (including all 16 protected drive-*/smoke-*
--     files) references this table at all.
--   - All 4 real mutation paths - election_day_manage_coordinators_v2,
--     election_day_apply_initial_allocation_v2,
--     election_day_rebalance_assignments_v2,
--     election_day_end_coordinator_activity_v2 (20260813120000), plus their
--     now-EXECUTE-revoked v1 predecessors (20260813100000/20260813100100,
--     revoked from anon/authenticated by 20260813130000) - are all
--     `security definer`. A SECURITY DEFINER function runs with the
--     privileges of its owner (postgres), never the calling role's own
--     table privileges, so none of them have ever depended on
--     anon/authenticated holding INSERT/UPDATE/DELETE/TRUNCATE on this
--     table - confirmed by rereading 20260813120000's own functions, all
--     `security definer`.
-- Revoking INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER from
-- anon/authenticated therefore removes only unused, unintended standing
-- privilege - no legitimate application path is affected.
--
-- ============================================================================
-- SCOPE
-- ============================================================================
-- Exactly two statements: revoke the unintended/unnecessary privileges,
-- then (re-)grant only SELECT - the one privilege the table's own RLS
-- policy and every real read path actually need. Matches the grant pattern
-- already used for the original Strategy-A tables (election_day_voters and
-- siblings). No RLS change, no new/changed policy, no RPC change, no
-- frontend change - this migration only aligns table-level grants with the
-- access this table's design has always intended.
begin;

revoke insert, update, delete, truncate, references, trigger
on public.election_day_coordinators
from anon, authenticated;

grant select
on public.election_day_coordinators
to anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual - restores the exact broader grant this migration found
-- live in Production, in case that scope turns out to be needed after all):
--
--   begin;
--   grant insert, update, delete, truncate, references, trigger
--   on public.election_day_coordinators
--   to anon, authenticated;
--   commit;
-- ============================================================================
