import type { Permission } from "./types";

/** Every permission that exists, in one place - the source of truth every
 * validation/test in this engine checks against, so a typo'd or stale
 * permission string anywhere (a `RoleRecord` from the DB, a test fixture)
 * fails loudly instead of silently doing nothing.
 *
 * Permissions are code (this fixed, deployed catalog); roles are data (the
 * live `election_day_roles` table, Dynamic Roles & Permissions Phase 1) -
 * there is no more hardcoded role → permission-set map here. See
 * `roleRecordMapper.ts` for where a `RoleRecord`'s `permissions` array is
 * filtered against this exact list before being trusted. */
export const ALL_PERMISSIONS: readonly Permission[] = [
  "voter.markVoted",
  "voter.manageReminder",
  "voter.manageRide",
  "voter.editPhone",
  "voter.editNotes",
  "electionDay.import",
  "electionDay.clearData",
  "electionDay.export",
  "electionDay.manageSettings",
  "electionDay.manageUsers",
  "electionDay.manageRideCoordinators",
  "electionDay.manageRolesAndPermissions",
  "electionDay.manageNonVotingReasons",
  "app.accessFullNavigation",
  "voter.viewName",
  "voter.viewAddress",
  "voter.viewPhone",
  "voter.viewMasad",
  "voter.viewCoordinator",
  "voter.viewNotes",
  "voter.viewReminderStatus",
  "voter.viewRideStatus",
  "voter.viewVotedStatus",
];
