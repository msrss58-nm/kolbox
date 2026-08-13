/** Every permission this engine knows about, namespaced by the area of the
 * app it governs. Field-level `voter.view*` permissions are intentionally
 * atomic (one per field actually rendered in `ElectionDayRow`/
 * `ElectionDayList`/`ElectionDayContactModal`) rather than one broad
 * "operational fields" flag, so a future role can see some operational
 * fields but not others without a new permission having to be invented.
 *
 * This catalog is code (fixed, deployed with the frontend) - roles
 * (`RoleRecord`, below) are data (dynamic, live in `election_day_roles`).
 * A permission string coming back from the DB that isn't in this list is
 * never trusted - see `roleRecordMapper.ts`. */
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
  // Dynamic Roles & Permissions - added in Phase 0, still inert (no
  // PermissionGuard/usePermissions().can() call site checks it yet; that's
  // a future Phase 2 "תפקידים" tab's job). Present in the catalog so the
  // DB-side seed data and the TS-side catalog agree from day one.
  | "electionDay.manageRolesAndPermissions"
  // Dynamic Non-Voting Reasons: gates only the "ניהול סיבות אי-הצבעה" catalog
  // management screen (create/edit/delete/enable-disable/reorder a reason).
  // By product decision there is no separate "view the reason on a voter"
  // permission - anyone who can see a voter's voted status (voter.
  // viewVotedStatus) also sees its non-voting reason, and setting/changing
  // the reason rides on the existing voter.markVoted (the same action that
  // already gates the voted/not-voted toggle itself).
  | "electionDay.manageNonVotingReasons"
  // Coordinator Allocation Management: gates the "ניהול הקצאות" screen
  // (Phase 5 - not yet built) and, server-side, the 4 actor-password-
  // authenticated allocation RPCs themselves (election_day_manage_coordinators
  // / apply_initial_allocation / rebalance_assignments /
  // end_coordinator_activity - see the Phase 3 migrations). V1 default: only
  // the built-in manager role is meant to hold this - see
  // `builtInRoleSeed.ts`'s comment for why that seed does NOT actually grant
  // it to any persisted Production role.
  | "electionDay.manageCoordinatorAllocation"
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
  // Reminder Lifecycle v1: gates the contact modal's collapsible
  // "היסטוריית תזכורות" audit-trail section (created/closed/cancelled/
  // rescheduled events) - distinct from `voter.viewReminderStatus` (the
  // current-state badge/label), since a role could plausibly see the live
  // status without being trusted with the full history, or vice versa.
  | "voter.viewReminderHistory"
  | "voter.viewRideStatus"
  | "voter.viewVotedStatus";

/** JSON-compatible value - mirrors what a Postgres `jsonb` column can hold
 * over the wire. Used only for `RoleRecord.scopeValue`, which Phase 1 never
 * reads (reserved for a future scope dimension - see the Phase 0 migration's
 * column comment on `election_day_roles.scope_value`). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** "Work domain" (תחום עבודה) - which contacts a role's holder can see/act
 * on. Modeled as a closed union today, deliberately validated strictly (see
 * `roleRecordMapper.ts`) rather than accepted as any string the DB happens
 * to contain - an unrecognized value must fail closed, never be guessed at.
 * A future dimension (e.g. geographic) is an additive new value, not a
 * breaking schema change. */
export type RoleScopeType = "all" | "assigned_to_me";

/** A normalized, trusted row from the live `election_day_roles` catalog
 * (Dynamic Roles & Permissions, Phase 1) - the type every permission/scope
 * decision in the app is based on. There is no hardcoded three-way
 * `EffectiveRole` union; `manager`/`operations`/`voting` are just three
 * ordinary rows in this table, indistinguishable in code from any other
 * role except by their `permissions`/`scopeType` (Phase 3: the
 * `legacyRoleKey` migration-bookkeeping field that used to mark them is
 * gone - resolution has matched exclusively by `id`/`roleId` since Phase 2).
 *
 * NEVER constructed by casting a raw RPC row directly - always produced by
 * `roleRecordMapper.ts`'s `normalizeRoleRecord`, which validates every
 * untrusted field and fails closed (`scopeType`: `null` if unrecognized;
 * `permissions`: filtered against the live `Permission` catalog) rather
 * than ever passing an unvalidated value through. */
export interface RoleRecord {
  id: string;
  name: string;
  description: string;
  permissions: readonly Permission[];
  /** `null` means "unrecognized or missing scope_type" - always fails
   * closed (see `resolveVisibleContacts` in `electionDayScope.ts`), never
   * treated as "all" or any other implicit default. */
  scopeType: RoleScopeType | null;
  scopeValue: Json | null;
}
