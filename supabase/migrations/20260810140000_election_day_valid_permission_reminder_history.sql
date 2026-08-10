-- Fixes a functional gap found during the 2026-08-10 documentation-sync audit:
-- election_day_is_valid_permission (the DB-side write-path allowlist for
-- election_day_create_role/update_role, via election_day_validate_role_input)
-- was never updated to recognize voter.viewReminderHistory when Reminder
-- Lifecycle v1 (migration 20260810120000) introduced it. The permission's
-- initial 2 grants (מנהל/משתמש) worked because they were written via a raw
-- `update ... array_append(...)` directly on election_day_roles, bypassing
-- election_day_create_role/update_role's validation entirely - confirmed live
-- via a read-only role-catalog check: both roles already carry the
-- permission today, so no existing data is affected. Only a future attempt to
-- grant voter.viewReminderHistory to a *different* role through the "תפקידים"
-- Role Management UI (election_day_update_role/create_role) would hit
-- INVALID_PERMISSION - the exact same bug class already fixed once before for
-- electionDay.manageNonVotingReasons (see 20260806170000).
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project - the Supabase CLI's migration runner pipelines
-- a file's statements, it does not implicitly wrap them in a transaction.
begin;

-- Same body as the previous definition
-- (20260806170000_election_day_valid_permission_non_voting_reasons.sql), with
-- 'voter.viewReminderHistory' added - kept in sync with
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
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
    'voter.viewReminderHistory'
  ]);
$$;

comment on function public.election_day_is_valid_permission(text) is
  'Dynamic Roles & Permissions Phase 2 (updated for Reminder Lifecycle v1''s voter.viewReminderHistory): DB-side mirror of ALL_PERMISSIONS (src/permissions/permissionsMap.ts) - the write-path trust boundary for role create/update, which accept arbitrary caller-supplied permission arrays unlike Phase 0''s migration-only seed insert.';

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
--       'electionDay.manageNonVotingReasons',
--       'app.accessFullNavigation',
--       'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
--       'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus'
--     ]);
--   $$;
--   revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;
--   commit;
-- ============================================================================
