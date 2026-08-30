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
 * - `add`: `displayName` required, `phone` optional.
 * - `edit`: `coordinatorId` + `displayName` required. Never touches `phone`.
 * - `remove`: `coordinatorId` required.
 * - `link` / `relink`: `coordinatorId` + `linkedAssignmentName` required.
 * - `unlink`: `coordinatorId` required.
 * - `update_phone`: `coordinatorId` required, `phone` optional (empty/absent
 *   clears to `null`). Contact metadata only - deliberately carries none of
 *   `edit`'s identity/participation/collision guards, so it stays available
 *   even when rename/remove are blocked.
 * The API layer validates nothing client-side beyond shape - every real
 * business rule (activity locks, name-collision invariant, participation
 * locks, phone format) is enforced server-side and surfaces as a stable
 * error code. */
export interface CoordinatorAction {
  action: "add" | "edit" | "remove" | "link" | "relink" | "unlink" | "update_phone";
  coordinatorId?: string;
  displayName?: string;
  linkedAssignmentName?: string;
  phone?: string;
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
  listElectionDayVoters(): Promise<ElectionDayVoter[]>;
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
  /** Fired on every call-button click - a dial alone. Bumps total
   * `callAttempts`/`lastCallAttemptAt` and stamps a fresh `pendingCallId` on
   * the returned voter; never touches `noAnswerStreak`. */
  incrementCallAttempts(id: string): Promise<ElectionDayVoter>;
  /** Call Outcome Tracking: explicit "❌ לא ענה" outcome for the most recent
   * dial. `callId` must be the voter's current `pendingCallId` (from the
   * increment/previous outcome response) - a stale/mismatched/already-null
   * id is a safe no-op server-side, both because "no real dial behind this"
   * must never advance the streak, and as the idempotency guard against a
   * retried/duplicated request. */
  recordNoAnswer(
    id: string,
    callId: string,
    actorName: string,
  ): Promise<ElectionDayVoter>;
  /** Call Outcome Tracking: explicit "✅ ענה" outcome - unconditionally
   * resets `noAnswerStreak`/`noAnswerStreakThreshold` to 0/3, regardless of
   * the answer's reason (callback/voting/ride/anything else); never touches
   * `reminderAt` - use `setReminder`/`setReminderAt` afterward for a
   * callback. Same `callId` contract as `recordNoAnswer`. */
  recordCallAnswered(
    id: string,
    callId: string,
    actorName: string,
  ): Promise<ElectionDayVoter>;
  /** Call Outcome Tracking: the "המשך ניסיונות (+3)" checkpoint-dialog choice
   * - advances `noAnswerStreakThreshold` 3 -> 6 exactly once (server-guarded,
   * a second call after it's already 6 is a no-op). Replaces the old
   * `extendCallAttemptsThreshold`. */
  extendNoAnswerStreakThreshold(id: string, actorName: string): Promise<ElectionDayVoter>;
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
  /** Verifies name+password and returns the matching user (never a
   * password/hash) on success, or null on no match. */
  verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null>;
  /** Security Hardening (Reauth): bcrypt-verifies `actorPassword` against
   * `actorId`'s own stored hash and returns a raw, opaque, short-lived proof
   * token on success (`election_day_reauth`) - the credential every one of
   * the 8 hardened admin/import RPCs below now requires as their first
   * argument. Raises on a wrong password (mapped to a Hebrew message, same
   * as every other error in this interface's implementations). */
  reauth(actorId: string, actorPassword: string): Promise<string>;
  /** Best-effort logout revocation of a cached proof - MUST NEVER throw
   * (idempotent server-side for an already-invalid proof, and any network/
   * RPC failure is swallowed by the implementation) so a caller can always
   * fire-and-forget this from `electionDaySession.ts`'s `logout()` without
   * risking blocking or failing the logout itself. */
  revokeReauthProof(proof: string): Promise<void>;

  /** Dynamic Roles & Permissions, Phase 1: lists the full `election_day_roles`
   * catalog the permission engine resolves a session's `roleId` against.
   * Every row is validated/normalized (never a blind cast) before being
   * returned - see `permissions/roleRecordMapper.ts`. */
  listElectionDayRoles(): Promise<RoleRecord[]>;

  /** Dynamic Non-Voting Reasons: the full catalog ("ניהול סיבות אי-הצבעה"),
   * including inactive rows - the voter-level dropdown filters to
   * `isActive` itself. Real CRUD (`createNonVotingReason`/
   * `updateNonVotingReason`/`deleteNonVotingReason`), including
   * `deleteNonVotingReason` rejecting a reason still referenced by any
   * voter. */
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
