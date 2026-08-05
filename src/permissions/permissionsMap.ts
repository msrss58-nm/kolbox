import type { EffectiveRole, Permission } from "./types";

/** Every permission that exists, in one place - the source of truth
 * `scripts/smoke-permissions.ts` checks every role's set against, so a
 * typo'd or stale permission string anywhere in `PERMISSIONS_BY_ROLE`
 * fails the smoke test instead of silently doing nothing. */
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

/**
 * The single, central map from each `EffectiveRole` to the permissions it
 * holds - the only place role → permission decisions are made. Every
 * consumer (`hasPermission`, `usePermissions`, `PermissionGuard`, future
 * `useElectionDay` mutation guards) reads through this map instead of
 * encoding its own role logic.
 *
 * Reflects the approved product model exactly:
 * - manager: every permission.
 * - operations: full operational access to a voter's record (reminders,
 *   rides, phone, notes) and full visibility of operational fields, but no
 *   voting mark, no import/clear, no user/ride-coordinator management, no
 *   settings, no export/reports, and no navigation outside Election Day.
 * - voting: only marking/unmarking a voter as voted, and only the three
 *   identifying fields (name, address, phone) - no other field, no other
 *   action, no navigation outside Election Day.
 */
export const PERMISSIONS_BY_ROLE: Record<EffectiveRole, ReadonlySet<Permission>> = {
  manager: new Set(ALL_PERMISSIONS),

  operations: new Set<Permission>([
    "voter.manageReminder",
    "voter.manageRide",
    "voter.editPhone",
    "voter.editNotes",
    "voter.viewName",
    "voter.viewAddress",
    "voter.viewPhone",
    "voter.viewMasad",
    "voter.viewCoordinator",
    "voter.viewNotes",
    "voter.viewReminderStatus",
    "voter.viewRideStatus",
    "voter.viewVotedStatus",
  ]),

  voting: new Set<Permission>([
    "voter.markVoted",
    "voter.viewName",
    "voter.viewAddress",
    "voter.viewPhone",
    "voter.viewVotedStatus",
  ]),
};
