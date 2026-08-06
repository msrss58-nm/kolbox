-- Fixes a functional gap found during Dynamic Non-Voting Reasons' production
-- verification: election_day_is_valid_permission (the DB-side write-path
-- allowlist for election_day_create_role/update_role, from Phase 2) was
-- never updated to recognize electionDay.manageNonVotingReasons - confirmed
-- live, election_day_create_role rejected it with INVALID_PERMISSION. This
-- meant no role could ever be granted the permission, so "ניהול סיבות
-- אי-הצבעה" - fully built, migrated, and deployed - was unreachable by any
-- real account. The catalog RPCs themselves were unaffected (no
-- caller-identity check, by design); only this allowlist was stale.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project - the Supabase CLI's migration runner pipelines
-- a file's statements, it does not implicitly wrap them in a transaction.
begin;

-- Same body as the Phase 2 definition
-- (20260806100000_election_day_dynamic_roles_phase2.sql), with
-- 'electionDay.manageNonVotingReasons' added - kept in sync with
-- src/permissions/permissionsMap.ts's ALL_PERMISSIONS.
create or replace function public.election_day_is_valid_permission(p_permission text)
returns boolean
language sql
immutable
as $$
  select p_permission = any(array[
    'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
    'electionDay.manageUsers', 'electionDay.manageRideCoordinators', 'electionDay.manageRolesAndPermissions',
    'electionDay.manageNonVotingReasons',
    'app.accessFullNavigation',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
  ]);
$$;

comment on function public.election_day_is_valid_permission(text) is
  'Dynamic Roles & Permissions Phase 2 (updated for Dynamic Non-Voting Reasons): DB-side mirror of ALL_PERMISSIONS (src/permissions/permissionsMap.ts) - the write-path trust boundary for role create/update, which accept arbitrary caller-supplied permission arrays unlike Phase 0''s migration-only seed insert.';

-- create or replace preserves existing grants, but re-asserting this
-- explicitly costs nothing and keeps this migration self-contained - see
-- Phase 2's own comment for why `from public` alone is not sufficient on
-- this Supabase project (default privileges grant EXECUTE on new
-- public-schema functions directly to anon/authenticated too).
revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;

commit;

-- ============================================================================
-- ROLLBACK (manual):
--
--   begin;
--   create or replace function public.election_day_is_valid_permission(p_permission text)
--   returns boolean
--   language sql
--   immutable
--   as $$
--     select p_permission = any(array[
--       'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
--       'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
--       'electionDay.manageUsers', 'electionDay.manageRideCoordinators', 'electionDay.manageRolesAndPermissions',
--       'app.accessFullNavigation',
--       'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
--       'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
--     ]);
--   $$;
--   revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;
--   commit;
-- ============================================================================
