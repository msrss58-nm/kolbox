import type { PermissionRole } from "../types";

/** The role as stored today in `election_day_permission_users.role` /
 * `PermissionUser.role` - unchanged by this engine. See
 * `resolveEffectiveRole` for the legacy `"user"` → `"operations"` mapping
 * into `EffectiveRole`. */
export type DatabaseRole = PermissionRole;

/** The three final Election Day roles the rest of the app reasons about. */
export type EffectiveRole = "manager" | "operations" | "voting";

/** Every permission this engine knows about, namespaced by the area of the
 * app it governs. Field-level `voter.view*` permissions are intentionally
 * atomic (one per field actually rendered in `ElectionDayRow`/
 * `ElectionDayList`/`ElectionDayContactModal`) rather than one broad
 * "operational fields" flag, so a future role can see some operational
 * fields but not others without a new permission having to be invented. */
export type Permission =
  // voter mutations
  | "voter.markVoted"
  | "voter.manageReminder"
  | "voter.manageRide"
  | "voter.editPhone"
  | "voter.editNotes"
  // election-day-wide mutations
  | "electionDay.import"
  | "electionDay.clearData"
  | "electionDay.export"
  | "electionDay.manageSettings"
  | "electionDay.manageUsers"
  | "electionDay.manageRideCoordinators"
  // Dynamic Roles & Permissions (planning-only as of this addition - see
  // task-plan.md's Progress Log, Phase 0). Not yet checked by any
  // PermissionGuard/usePermissions().can() call site anywhere in the app -
  // inert until a future Phase 2 "תפקידים" tab exists to gate. Only present
  // in the catalog (and therefore automatically included in manager's
  // full-access set, since manager = new Set(ALL_PERMISSIONS)) so the DB-side
  // seed data (election_day_roles) and the TS-side catalog agree from day one.
  | "electionDay.manageRolesAndPermissions"
  // navigation scope (outside Election Day entirely)
  | "app.accessFullNavigation"
  // field-level view permissions
  | "voter.viewName"
  | "voter.viewAddress"
  | "voter.viewPhone"
  | "voter.viewMasad"
  | "voter.viewCoordinator"
  | "voter.viewNotes"
  | "voter.viewReminderStatus"
  | "voter.viewRideStatus"
  | "voter.viewVotedStatus";
