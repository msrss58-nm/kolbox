-- Coordinator Allocation Management - Phase 1 (DB foundation), step 5/5.
-- Adds 'electionDay.manageCoordinatorAllocation' to the DB-side write-path
-- permission allowlist (election_day_is_valid_permission), so a future
-- Phase 4 role-management grant of this permission is accepted by
-- election_day_create_role/update_role rather than rejected with
-- INVALID_PERMISSION - the exact gap this allowlist has already missed
-- twice before (electionDay.manageNonVotingReasons, voter.viewReminderHistory
-- - see 20260806170000 / 20260810140000), fixed proactively this time instead
-- of after the fact.
--
-- Deliberately NOT done in this migration (out of Phase 1 scope, per the
-- approved plan - these are Phase 4): no change to
-- src/permissions/types.ts's Permission union, src/permissions/
-- permissionsMap.ts's ALL_PERMISSIONS, or builtInRoleSeed.ts. The DB
-- allowlist intentionally recognizes this permission string before the
-- frontend does - the reverse of the historical bug pattern above, and safe
-- here specifically because this migration only ever widens what
-- election_day_create_role/update_role will ACCEPT; it grants no one this
-- permission and changes no existing role's actual permissions array.
--
-- Wrapped in explicit begin;/commit; for the same reason as every other
-- migration in this project - the Supabase CLI's migration runner pipelines
-- a file's statements, it does not implicitly wrap them in a transaction.
begin;

-- Same body as the previous definition
-- (20260810140000_election_day_valid_permission_reminder_history.sql), with
-- 'electionDay.manageCoordinatorAllocation' added - to be kept in sync with
-- src/permissions/permissionsMap.ts's ALL_PERMISSIONS once Phase 4 adds this
-- permission there too.
create or replace function public.election_day_is_valid_permission(p_permission text)
returns boolean
language sql
immutable
as $$
  select p_permission = any(array[
    'voter.markVoted', 'voter.manageReminder', 'voter.manageRide', 'voter.editPhone', 'voter.editNotes',
    'electionDay.import', 'electionDay.clearData', 'electionDay.export', 'electionDay.manageSettings',
    'electionDay.manageUsers', 'electionDay.manageRideCoordinators', 'electionDay.manageRolesAndPermissions',
    'electionDay.manageNonVotingReasons', 'electionDay.manageCoordinatorAllocation',
    'app.accessFullNavigation',
    'voter.viewName', 'voter.viewAddress', 'voter.viewPhone', 'voter.viewMasad', 'voter.viewCoordinator',
    'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
    'voter.viewReminderHistory'
  ]);
$$;

comment on function public.election_day_is_valid_permission(text) is
  'Dynamic Roles & Permissions Phase 2 (updated for Coordinator Allocation Management Phase 1): DB-side mirror of ALL_PERMISSIONS (src/permissions/permissionsMap.ts) - the write-path trust boundary for role create/update, which accept arbitrary caller-supplied permission arrays unlike Phase 0''s migration-only seed insert. electionDay.manageCoordinatorAllocation is recognized here ahead of the frontend catalog (Phase 4) - deliberately the reverse of the historical bug pattern (permission shipped before the allowlist recognized it) - this only widens what create_role/update_role will accept, granting nobody anything by itself.';

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
--       'voter.viewNotes', 'voter.viewReminderStatus', 'voter.viewRideStatus', 'voter.viewVotedStatus',
--       'voter.viewReminderHistory'
--     ]);
--   $$;
--   revoke all on function public.election_day_is_valid_permission(text) from public, anon, authenticated;
--   commit;
-- ============================================================================
