import type { Permission, RoleRecord, RoleScopeType } from "../../permissions/types";
import type {
  Activist,
  CampaignStats,
  CityBreakdown,
  Classification,
  ClassificationEvent,
  Coordinator,
  ElectionDayVoter,
  NonVotingReason,
  PermissionUser,
  PollingStation,
  ReminderEvent,
  RideCoordinator,
  RideStatusEvent,
  TrendPoint,
  Voter,
} from "../../types";

export interface Paged<T> {
  items: T[];
  total: number;
}

export type VoterSortKey = "lastName" | "city" | "classifiedAt" | "birthYear";

export interface VoterQuery {
  search?: string; // matches name / national ID / phone
  cities?: string[]; // matches any of - empty/undefined means all cities
  classifications?: Classification[]; // matches any of - empty/undefined means all
  pollingStationId?: string;
  sortBy?: VoterSortKey;
  sortDir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface NewVoter {
  nationalId: string;
  firstName: string;
  lastName: string;
  city: string;
  street: string;
  houseNumber: number;
  phone: string | null;
  birthYear: number;
  pollingStationId: string;
}

export interface NewActivist {
  firstName: string;
  lastName: string;
  phone: string;
  area: string;
}

export interface ImportRow {
  nationalId: string;
  firstName: string;
  lastName: string;
  city?: string;
  street?: string;
  houseNumber?: number;
  phone?: string;
  birthYear?: number;
}

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: { row: number; reason: string }[];
}

export interface NewElectionDayVoter {
  masad: string;
  firstName: string;
  lastName: string;
  street: string;
  houseNumber: number;
  city: string;
  phone: string | null;
  coordinator: string | null;
}

export interface NewRideCoordinator {
  name: string;
  phone: string;
}

/** Dynamic Roles & Permissions Phase 3: creates a `PermissionUser` against
 * an arbitrary role_id - the only creation shape now that the legacy
 * 3-checkbox path has been removed. */
export interface NewPermissionUser {
  name: string;
  password: string;
  roleId: string;
}

/** Dynamic Roles & Permissions Phase 2: role create/update input. `scopeType`
 * is required (no implicit default) - the caller always states the work
 * domain explicitly. */
export interface NewRole {
  name: string;
  description: string;
  permissions: Permission[];
  scopeType: RoleScopeType;
}

export interface RoleUpdate extends NewRole {
  id: string;
}

/** Dynamic Non-Voting Reasons: catalog create/update input. */
export interface NewNonVotingReason {
  name: string;
  description: string;
  requiresFollowUp: boolean;
}

export interface NonVotingReasonUpdate extends NewNonVotingReason {
  id: string;
}

/** Coordinator Allocation Management: one batch action for
 * `election_day_manage_coordinators`. Which fields are meaningful depends on
 * `action` (mirrors the RPC's own per-action shape - see the migration):
 * - `add`: `displayName` required.
 * - `edit`: `coordinatorId` + `displayName` required.
 * - `remove`: `coordinatorId` required.
 * - `link` / `relink`: `coordinatorId` + `linkedAssignmentName` required.
 * - `unlink`: `coordinatorId` required.
 * The API layer validates nothing client-side beyond shape - every real
 * business rule (activity locks, name-collision invariant, participation
 * locks) is enforced server-side and surfaces as a stable error code. */
export interface CoordinatorAction {
  action: "add" | "edit" | "remove" | "link" | "relink" | "unlink";
  coordinatorId?: string;
  displayName?: string;
  linkedAssignmentName?: string;
}

/** Coordinator Allocation Management: one `{coordinator, quantity}` pair -
 * shared shape for initial-allocation assignments and rebalance sources/
 * destinations. `quantity` semantics (>= 0 vs > 0) are enforced server-side,
 * not by this type. */
export interface AllocationAssignment {
  coordinatorId: string;
  quantity: number;
}

/** Return contract of `election_day_apply_initial_allocation`.
 * `remainingUnassignedCount` is always 0 on success - every currently-
 * unassigned voter is allocated by construction (see the RPC's own
 * comment) - kept as an explicit field rather than assumed, since a future
 * RPC revision could change that. */
export interface ApplyInitialAllocationResult {
  operationId: string;
  allocatedCount: number;
  remainingUnassignedCount: number;
}

/** Return contract of `election_day_rebalance_assignments`. */
export interface RebalanceAssignmentsResult {
  operationId: string;
  transferredCount: number;
}

export type EndCoordinatorActivityMode = "transfer" | "equal_split";

/** Return contract of `election_day_end_coordinator_activity`. */
export interface EndCoordinatorActivityResult {
  operationId: string;
  transferredCount: number;
  endedCoordinatorId: string;
  endedCoordinatorDisplayName: string;
}

/**
 * The single data-access seam of the app.
 * MVP: implemented by MockApi (in-memory + localStorage).
 * Post-MVP: implemented by SupabaseApi with zero UI changes.
 */
export interface ApiClient {
  // dashboard
  getStats(): Promise<CampaignStats>;
  getTrend(days: number): Promise<TrendPoint[]>;
  getCityBreakdown(): Promise<CityBreakdown[]>;

  // voters
  listVoters(query: VoterQuery): Promise<Paged<Voter>>;
  getVoter(id: string): Promise<Voter | null>;
  addVoter(voter: NewVoter): Promise<Voter>;
  updateVoter(id: string, patch: Partial<Voter>): Promise<Voter>;
  classifyVoter(
    voterId: string,
    classification: Classification,
    activistId: string,
    opts?: { includeFamily?: boolean },
  ): Promise<Voter[]>; // returns all voters changed (family included)
  bulkClassify(
    voterIds: string[],
    classification: Classification,
    activistId: string,
  ): Promise<Voter[]>;
  getVoterHistory(voterId: string): Promise<ClassificationEvent[]>;

  // activists
  listActivists(): Promise<Activist[]>;
  getActivist(id: string): Promise<Activist | null>;
  addActivist(activist: NewActivist): Promise<Activist>;
  updateActivist(id: string, patch: Partial<Activist>): Promise<Activist>;
  getActivistEvents(activistId: string): Promise<ClassificationEvent[]>;
  /**
   * Idempotent: creates an activist record with a caller-supplied id if one
   * doesn't already exist. Used to keep a real (Supabase-authenticated)
   * activist's tag-count/leaderboard entry in sync with their auth identity,
   * since voters/activists themselves still live in this local mock store.
   */
  ensureActivistProfile(id: string, info: NewActivist): Promise<Activist>;

  // stations & meta
  listStations(): Promise<PollingStation[]>;
  listCities(): Promise<string[]>;

  // data management
  importVoters(rows: ImportRow[]): Promise<ImportSummary>;
  resetToDemo(): Promise<void>;
  clearAll(): Promise<void>;

  // election day - independent ride-coordination dataset (see types.ts ElectionDayVoter)
  importElectionDayVoters(rows: NewElectionDayVoter[]): Promise<{ count: number }>;
  listElectionDayVoters(): Promise<ElectionDayVoter[]>;
  /** Clears the ride-list and its activity log (not the deadline). */
  clearElectionDayVoters(): Promise<void>;
  /** The voter needs a ride - a lighter-weight signal than `setRideArranged`,
   * set before any driver has actually been contacted. */
  setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter>;
  setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter>;
  /** Marks whether the ride actually happened - the driver reports this by
   * phone and a war-room activist marks it in the ride-coordination table. */
  setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter>;
  listRideStatusEvents(): Promise<RideStatusEvent[]>;
  getElectionDayDeadline(): Promise<string | null>;
  setElectionDayDeadline(deadline: string | null): Promise<string | null>;
  /** Creates or reschedules a reminder `minutesFromNow` minutes from now.
   * Reminder Lifecycle v1: cancellation is a dedicated method now
   * (`cancelReminder`) - this no longer accepts `null` to mean "cancel".
   * `actorName` is the signed-in session's display name, written to the
   * audit trail - see `setNonVotingReason`'s comment below for why it's
   * passed in explicitly rather than read from session state here. */
  setReminder(
    id: string,
    minutesFromNow: number,
    actorName: string,
  ): Promise<ElectionDayVoter>;
  /** Sets a reminder for an arbitrary absolute time (the "קביעת שעה" custom
   * picker) - `at` is a full ISO timestamp, written to `reminderAt` as-is,
   * never derived via a minutes-offset from `Date.now()`. */
  setReminderAt(id: string, at: string, actorName: string): Promise<ElectionDayVoter>;
  /** Reminder Lifecycle v1: explicit "mark handled" - closes the currently
   * open reminder with `reminderClosedReason: "handled"`. Idempotent no-op
   * if no reminder is currently open. */
  closeReminder(id: string, actorName: string): Promise<ElectionDayVoter>;
  /** Reminder Lifecycle v1: explicit cancel - closes the currently open
   * reminder with `reminderClosedReason: "cancelled"`. Idempotent no-op if
   * no reminder is currently open. */
  cancelReminder(id: string, actorName: string): Promise<ElectionDayVoter>;
  /** Reminder Lifecycle v1: setting `voted = true` also atomically closes any
   * currently open reminder with `reminderClosedReason: "voted"` -
   * un-voting (`voted = false`) never touches reminder state. */
  setVoted(id: string, voted: boolean, actorName: string): Promise<ElectionDayVoter>;
  /** `reasonId: null` clears the reason. `setByName` is the signed-in
   * session's display name (or `null` with no session), written to the
   * denormalized `notVotingReasonSetBy` for future reporting - passed in
   * explicitly by the caller (rather than this layer reaching into
   * election-day session state itself) to avoid a circular import between
   * the API singleton and `electionDaySession.ts`, which itself imports the
   * `api` singleton. Setting/changing the reason does not itself touch
   * `voted` - and setting `voted = true` does NOT clear this field either
   * (product decision - kept for history/future reports, the UI just stops
   * offering it for editing while voted = true). Reminder Lifecycle v1: if
   * the newly-set reason's `requiresFollowUp` is `false`, also atomically
   * closes any currently open reminder with `reminderClosedReason:
   * "case_closed"` - a reason with `requiresFollowUp: true`, or clearing the
   * reason entirely, leaves the reminder untouched. */
  setNonVotingReason(
    id: string,
    reasonId: string | null,
    setByName: string | null,
  ): Promise<ElectionDayVoter>;
  /** Reminder Lifecycle v1: full create/close/cancel/reschedule history for
   * one contact's reminder, newest first - powers an audit/history view.
   * Distinct from the latest-only `reminderClosedAt`/`reminderClosedReason`/
   * `reminderClosedBy` fields on `ElectionDayVoter` itself. */
  listReminderEvents(contactId: string): Promise<ReminderEvent[]>;
  incrementCallAttempts(id: string): Promise<ElectionDayVoter>;
  extendCallAttemptsThreshold(id: string): Promise<ElectionDayVoter>;
  setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter>;
  /** Updates only the `phone` field, by internal id - never sends or
   * overwrites the rest of the voter record. */
  setPhone(id: string, phone: string): Promise<ElectionDayVoter>;

  // election day - fixed, pre-registered ride-coordinator roster
  listRideCoordinators(): Promise<RideCoordinator[]>;
  addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator>;
  deleteRideCoordinator(id: string): Promise<void>;

  // election day - local user/manager permissions roster (no real auth)
  listPermissionUsers(): Promise<PermissionUser[]>;
  deletePermissionUser(id: string): Promise<void>;
  /** Resets an existing PermissionUser's (`targetId`) password in place
   * (id/name/role untouched) - but only after REAL server-side
   * re-authentication of the acting manager: the caller must supply the
   * acting manager's own current password (`actorPassword`), verified via
   * bcrypt inside the RPC against the actor's (`actorId`) own stored hash,
   * plus a real server-side check that the actor's role holds
   * `electionDay.manageUsers`. This is a genuine security boundary enforced
   * in the database itself - not just a UI-level `guardedAction` check like
   * every other mutation in this file. Self-reset: pass
   * `targetId === actorId`. Never returns or otherwise exposes the password
   * or its hash. */
  resetPermissionUserPassword(
    actorId: string,
    actorPassword: string,
    targetId: string,
    newPassword: string,
  ): Promise<PermissionUser>;
  /** Verifies name+password and returns the matching user (never a
   * password/hash) on success, or null on no match. */
  verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null>;

  /** Dynamic Roles & Permissions, Phase 1: lists the full `election_day_roles`
   * catalog the permission engine resolves a session's `roleId` against.
   * Every row is validated/normalized (never a blind cast) before being
   * returned - see `permissions/roleRecordMapper.ts`. */
  listElectionDayRoles(): Promise<RoleRecord[]>;

  /** Dynamic Roles & Permissions, Phase 2: real role management. `createRole`
   * carries no capability-guard restriction (adding a role can never reduce
   * anyone's access); `updateRole`/`deleteRole` reject an operation that
   * would remove `electionDay.manageRolesAndPermissions` from every
   * actually-assigned user (enforced DB-side, in the same transaction as the
   * write - see the `election_day_dynamic_roles_phase2` migration).
   * `deleteRole` also rejects a role with any assigned user. */
  createRole(input: NewRole): Promise<RoleRecord>;
  updateRole(input: RoleUpdate): Promise<RoleRecord>;
  deleteRole(id: string): Promise<void>;
  cloneRole(id: string, newName: string): Promise<RoleRecord>;
  /** Creates a `PermissionUser` against an arbitrary role_id - the only
   * creation path since the legacy 3-checkbox RPC was removed (Phase 3). */
  createPermissionUser(input: NewPermissionUser): Promise<PermissionUser>;

  /** Dynamic Non-Voting Reasons: the full catalog ("ניהול סיבות אי-הצבעה"),
   * including inactive rows - the voter-level dropdown filters to
   * `isActive` itself. Real CRUD (`createNonVotingReason`/
   * `updateNonVotingReason`/`deleteNonVotingReason`) mirrors `createRole`/
   * `updateRole`/`deleteRole` exactly, including `deleteNonVotingReason`
   * rejecting a reason still referenced by any voter. */
  listNonVotingReasons(): Promise<NonVotingReason[]>;
  createNonVotingReason(input: NewNonVotingReason): Promise<NonVotingReason>;
  updateNonVotingReason(input: NonVotingReasonUpdate): Promise<NonVotingReason>;
  setNonVotingReasonActive(id: string, isActive: boolean): Promise<NonVotingReason>;
  deleteNonVotingReason(id: string): Promise<void>;
  /** Bulk reorder - `orderedIds` must contain every existing reason's id
   * exactly once. */
  reorderNonVotingReasons(orderedIds: string[]): Promise<NonVotingReason[]>;

  // election day - coordinator allocation management (Phase 3 RPC core).
  // "Today's coordinators" - distinct from the permanent `RideCoordinator`
  // roster above. A direct SELECT is allowed (see database.types.ts) since
  // a coordinator row carries no secret; every write goes through one of
  // the 4 actor-password-authenticated RPCs below.
  listCoordinators(): Promise<Coordinator[]>;
  /** Atomic batch add/edit/remove/link/relink/unlink. Re-authenticates
   * `actorId`/`actorPassword` server-side (never persisted by any caller of
   * this method) and requires `electionDay.manageCoordinatorAllocation`.
   * Returns the full current coordinator roster on success. */
  manageCoordinators(
    actorId: string,
    actorPassword: string,
    actions: CoordinatorAction[],
  ): Promise<Coordinator[]>;
  /** One-time distribution of every currently-unassigned voter across the
   * given active coordinators, by quantity only - the server (never this
   * layer, never the caller) chooses which voters. */
  applyInitialAllocation(
    actorId: string,
    actorPassword: string,
    assignments: AllocationAssignment[],
  ): Promise<ApplyInitialAllocationResult>;
  /** Mid-day transfer of "remaining" voters from source coordinators to
   * destination coordinators, by quantity only. */
  rebalanceAssignments(
    actorId: string,
    actorPassword: string,
    sources: AllocationAssignment[],
    destinations: AllocationAssignment[],
  ): Promise<RebalanceAssignmentsResult>;
  /** Ends one active coordinator's activity, moving its remaining voters per
   * `mode`. `targetCoordinatorId` is required for `"transfer"`, ignored for
   * `"equal_split"`. */
  endCoordinatorActivity(
    actorId: string,
    actorPassword: string,
    coordinatorId: string,
    mode: EndCoordinatorActivityMode,
    targetCoordinatorId: string | null,
  ): Promise<EndCoordinatorActivityResult>;

  /**
   * Optional live cross-device sync for Election Day's ride-coordination
   * data - calls `onChange` whenever a contact or ride-status event changes
   * on another device/tab. Implementations that don't support Realtime
   * (e.g. MockApi) simply don't implement this; callers must feature-detect
   * (`api.subscribeToElectionDayChanges?.(...)`) rather than assume it
   * exists. Returns an unsubscribe function. Owned exclusively by
   * `useElectionDay.ts` - see `subscribeToCoordinatorChanges` below for why
   * the coordinator roster deliberately does NOT also flow through this
   * same method/channel.
   */
  subscribeToElectionDayChanges?(onChange: () => void): () => void;
  /**
   * Optional live cross-device sync for the coordinator roster - calls
   * `onChange` whenever `election_day_coordinators` changes on another
   * device/tab. A deliberately SEPARATE method/channel from
   * `subscribeToElectionDayChanges` above, not a 3rd table folded into it -
   * two independent hooks (`useElectionDay`/`useCoordinatorAllocation`)
   * each own their own subscription lifecycle, and `supabase-js` reuses a
   * channel object by topic name across calls, so sharing one method/name
   * between two independently-mounted/unmounted hooks would let either
   * hook's cleanup tear down the other's subscription (see
   * `SupabaseElectionDayApi.subscribeToCoordinatorChanges`'s own comment for
   * the full mechanism). Feature-detect the same way
   * (`api.subscribeToCoordinatorChanges?.(...)`). Returns an unsubscribe
   * function.
   */
  subscribeToCoordinatorChanges?(onChange: () => void): () => void;
}
