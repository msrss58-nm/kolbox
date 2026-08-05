import type { PermissionRole } from "../types";

/** The role as stored today in `election_day_permission_users.role` /
 * `PermissionUser.role` - unchanged by this engine. See
 * `resolveEffectiveRole` for the legacy `"user"` → `"operations"` mapping
 * into `EffectiveRole`. */
export type DatabaseRole = PermissionRole;

/** The three final Election Day roles the rest of the app reasons about.
 * `"voting"` cannot be produced from today's data yet - no `DatabaseRole`
 * maps onto it until the Stage 4 migration adds a real `role = 'voting'`
 * value; `resolveEffectiveRole` is the only place that will need to change. */
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
