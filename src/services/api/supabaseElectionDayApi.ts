import {
  mapCoordinatorAllocationRpcErrorMessage,
  toAllocationAssignmentPayload,
  toCoordinatorActionPayload,
} from "./coordinatorAllocationMapping";
import {
  normalizeNonVotingReasonRecord,
  type RawNonVotingReasonRow,
} from "./nonVotingReasonMapper";
import { normalizeRoleRecord, type RawRoleRow } from "../../permissions/roleRecordMapper";
import type { RoleRecord } from "../../permissions/types";
import { supabase } from "../supabase/client";
import type {
  Coordinator,
  ElectionDayVoter,
  NonVotingReason,
  PermissionUser,
  ReminderClosedReason,
  ReminderEvent,
  RideCoordinator,
  RideStatusEvent,
} from "../../types";
import type {
  AllocationAssignment,
  ApplyInitialAllocationResult,
  CoordinatorAction,
  EndCoordinatorActivityMode,
  EndCoordinatorActivityResult,
  NewElectionDayVoter,
  NewNonVotingReason,
  NewPermissionUser,
  NewRideCoordinator,
  NewRole,
  NonVotingReasonUpdate,
  RebalanceAssignmentsResult,
  RoleUpdate,
} from "./types";

/** A UUID that `gen_random_uuid()` will never produce - the standard
 * Supabase-community idiom for an unconditional "delete every row" via the
 * client (the JS client requires at least one filter on delete/update). */
const NEVER_MATCHES_ID = "00000000-0000-0000-0000-000000000000";

/** Throws on a Supabase error - use for delete/insert/void-RPC calls where
 * the response body isn't needed. Supabase returns `data: null` by default
 * for these when there's no `.select()` chained on - that's the normal
 * success shape, NOT a "not found" condition, so this deliberately never
 * looks at `data` at all. */
function checkError(result: { error: { message: string } | null }): void {
  if (result.error) throw new Error(result.error.message);
}

/** Unwraps a Supabase array-returning response (a plain `.select()` or an
 * RPC that returns a table) - throws on error, otherwise casts `data`
 * as-is. An empty result is a valid `[]`, not `null`, so no null-check is
 * needed here. `T` must be given explicitly at each call site. */
function unwrapArray<T>(result: { data: unknown; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

/** Unwraps a single-row Supabase response (a `.single()` fetch), throwing
 * if the row genuinely doesn't exist. Only use where a null row really
 * means "not found" - never for delete/insert calls without `.select()`.
 * `T` must be given explicitly at each call site. */
function unwrapRow<T>(result: { data: unknown; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("רשומה לא נמצאה");
  return result.data as T;
}

type VoterRow = {
  id: string;
  masad: string;
  first_name: string;
  last_name: string;
  street: string;
  house_number: number;
  city: string;
  phone: string | null;
  coordinator: string | null;
  notes: string;
  ride_requested: boolean;
  ride_requested_at: string | null;
  ride_arranged: boolean;
  ride_arranged_at: string | null;
  ride_completed: boolean;
  ride_completed_at: string | null;
  reminder_at: string | null;
  reminder_closed_at: string | null;
  reminder_closed_reason: string | null;
  reminder_closed_by: string | null;
  voted: boolean;
  voted_at: string | null;
  not_voting_reason_id: string | null;
  not_voting_reason_set_at: string | null;
  not_voting_reason_set_by: string | null;
  call_attempts: number;
  call_attempts_threshold: number;
  last_call_attempt_at: string | null;
};

function toVoter(row: VoterRow): ElectionDayVoter {
  return {
    id: row.id,
    masad: row.masad,
    firstName: row.first_name,
    lastName: row.last_name,
    street: row.street,
    houseNumber: row.house_number,
    city: row.city,
    phone: row.phone,
    // election_day_voters.coordinator is nullable since Coordinator
    // Allocation Management Phase 1 (a voter may be imported with no
    // coordinator) - coerced to "" here, the app's pre-existing sentinel for
    // "no coordinator" already relied on by nonVotingReasonReport.ts and
    // others, so every existing ElectionDayVoter.coordinator consumer stays
    // unchanged.
    coordinator: row.coordinator ?? "",
    notes: row.notes,
    rideRequested: row.ride_requested,
    rideRequestedAt: row.ride_requested_at,
    rideArranged: row.ride_arranged,
    rideArrangedAt: row.ride_arranged_at,
    rideCompleted: row.ride_completed,
    rideCompletedAt: row.ride_completed_at,
    reminderAt: row.reminder_at,
    reminderClosedAt: row.reminder_closed_at,
    reminderClosedReason: row.reminder_closed_reason as ReminderClosedReason | null,
    reminderClosedBy: row.reminder_closed_by,
    voted: row.voted,
    votedAt: row.voted_at,
    notVotingReasonId: row.not_voting_reason_id,
    notVotingReasonSetAt: row.not_voting_reason_set_at,
    notVotingReasonSetBy: row.not_voting_reason_set_by,
    callAttempts: row.call_attempts,
    callAttemptsThreshold: row.call_attempts_threshold,
    lastCallAttemptAt: row.last_call_attempt_at,
  };
}

type RideStatusEventRow = {
  id: string;
  contact_id: string | null;
  contact_name: string;
  coordinator: string;
  from_arranged: boolean;
  to_arranged: boolean;
  created_at: string;
};

function toRideStatusEvent(row: RideStatusEventRow): RideStatusEvent {
  return {
    id: row.id,
    contactId: row.contact_id ?? "",
    contactName: row.contact_name,
    coordinator: row.coordinator,
    from: row.from_arranged,
    to: row.to_arranged,
    at: row.created_at,
  };
}

type ReminderEventRow = {
  id: string;
  contact_id: string | null;
  contact_name: string;
  coordinator: string;
  event_type: string;
  reminder_at: string | null;
  reason: string | null;
  actor_name: string | null;
  created_at: string;
};

function toReminderEvent(row: ReminderEventRow): ReminderEvent {
  return {
    id: row.id,
    contactId: row.contact_id ?? "",
    contactName: row.contact_name,
    coordinator: row.coordinator,
    eventType: row.event_type as ReminderEvent["eventType"],
    reminderAt: row.reminder_at,
    reason: row.reason as ReminderEvent["reason"],
    actorName: row.actor_name,
    createdAt: row.created_at,
  };
}

type PermissionUserRpcRow = {
  id: string;
  name: string;
  role_id: string;
};

function toPermissionUser(row: PermissionUserRpcRow): PermissionUser {
  return {
    id: row.id,
    name: row.name,
    roleId: row.role_id,
  };
}

type CoordinatorRow = {
  id: string;
  display_name: string;
  status: string;
  linked_assignment_name: string | null;
  created_at: string;
  ended_at: string | null;
};

/** `status` is a plain `text` column in the DB (`check (status in ('active',
 * 'ended'))` - enforced there, not by a Postgres enum type) - coerced here
 * rather than trusted as-is, same caution as `reminder_closed_reason`/
 * `event_type` elsewhere in this file. An unrecognized value (should not
 * happen given the DB constraint) falls back to `"active"` - the safer
 * direction for a coordinator, since `"ended"` disables further allocation
 * against it. */
function toCoordinator(row: CoordinatorRow): Coordinator {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status === "ended" ? "ended" : "active",
    linkedAssignmentName: row.linked_assignment_name,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

/** Dynamic Roles & Permissions Phase 2: the 4 role-management RPCs
 * (create/update/delete/clone) raise a small set of stable, English error
 * codes (`ROLE_HAS_ASSIGNED_USERS`, `CANNOT_REMOVE_LAST_PERMISSION_HOLDER`,
 * `ROLE_NAME_REQUIRED`, the `election_day_roles_name_key` unique-violation
 * message) rather than a Hebrew string themselves - translated here, once,
 * before the error ever reaches `useAsyncAction`'s generic toast, so a real
 * business rejection reads clearly instead of leaking raw Postgres text.
 *
 * Also covers `election_day_reset_permission_user_password`'s 4 error
 * codes, in the priority order the RPC itself raises them:
 * `UNAUTHORIZED`/`FORBIDDEN` come from that RPC's real server-side
 * re-authentication and permission check on the ACTOR (steps 1-2 - wrong
 * actor id/password, or a role that lacks `electionDay.manageUsers`),
 * distinct from `USER_NOT_FOUND`/`INVALID_PASSWORD` (steps 3-4, about the
 * target/new-password, already present here from the previous pass). No
 * other Election Day RPC has an actor-identity failure mode like
 * `UNAUTHORIZED`/`FORBIDDEN` - this is the first one that actually checks
 * who's calling. */
function mapRoleRpcErrorMessage(message: string): string {
  if (message.includes("UNAUTHORIZED")) {
    return "הסיסמה שהזנת אינה נכונה";
  }
  if (message.includes("FORBIDDEN")) {
    return "אין לך הרשאה לבצע פעולה זו";
  }
  if (message.includes("ROLE_HAS_ASSIGNED_USERS")) {
    return "לא ניתן למחוק תפקיד שיש לו משתמשים משויכים";
  }
  if (message.includes("CANNOT_REMOVE_LAST_PERMISSION_HOLDER")) {
    return "חייב להישאר לפחות משתמש אחד עם הרשאת ניהול תפקידים והרשאות";
  }
  if (message.includes("ROLE_NAME_REQUIRED")) {
    return "יש להזין שם לתפקיד";
  }
  if (message.includes("ROLE_NOT_FOUND")) {
    return "התפקיד לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("USER_NOT_FOUND")) {
    return "המשתמש לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("INVALID_PASSWORD")) {
    return "יש להזין סיסמה חדשה";
  }
  if (
    message.includes("election_day_roles_name_key") ||
    message.includes("duplicate key")
  ) {
    return "כבר קיים תפקיד בשם זה";
  }
  return message;
}

async function callRoleRpc<T>(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const result = await promise;
  if (result.error) throw new Error(mapRoleRpcErrorMessage(result.error.message));
  return result.data as T;
}

/** Dynamic Non-Voting Reasons: the catalog-management RPCs raise the same
 * kind of small, stable English error codes as the role RPCs
 * (`REASON_IN_USE`, `REASON_NOT_FOUND`, `REASON_NAME_REQUIRED`,
 * `REORDER_ID_MISMATCH`, the `election_day_not_voting_reasons_name_key`
 * unique-violation message) - translated here, once, mirroring
 * `mapRoleRpcErrorMessage` exactly. */
function mapNonVotingReasonRpcErrorMessage(message: string): string {
  if (message.includes("REASON_IN_USE")) {
    return "לא ניתן למחוק סיבה המשויכת לבוחרים";
  }
  if (message.includes("REASON_NOT_FOUND")) {
    return "הסיבה לא נמצאה - ייתכן שנמחקה על ידי משתמש אחר";
  }
  if (message.includes("REASON_NAME_REQUIRED")) {
    return "יש להזין שם לסיבה";
  }
  if (message.includes("REORDER_ID_MISMATCH")) {
    return "רשימת הסידור אינה תואמת את רשימת הסיבות הקיימת - רעננו ונסו שוב";
  }
  if (
    message.includes("election_day_not_voting_reasons_name_key") ||
    message.includes("duplicate key")
  ) {
    return "כבר קיימת סיבה בשם זה";
  }
  return message;
}

async function callNonVotingReasonRpc<T>(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const result = await promise;
  if (result.error)
    throw new Error(mapNonVotingReasonRpcErrorMessage(result.error.message));
  return result.data as T;
}

/** Coordinator Allocation Management Phase 2: election_day_import_voters now
 * raises the same kind of small, stable English error code as the role/
 * reason RPCs (ALLOCATION_ACTIVITY_STARTED) once a re-import is blocked -
 * translated here, once, mirroring `mapRoleRpcErrorMessage`/
 * `mapNonVotingReasonRpcErrorMessage` exactly. */
function mapImportRpcErrorMessage(message: string): string {
  if (message.includes("ALLOCATION_ACTIVITY_STARTED")) {
    return "לא ניתן להעלות מחדש את מאגר הבוחרים לאחר שהחלה פעילות הקצאות. החלפת מאגר היא פעולה נפרדת.";
  }
  return message;
}

// Coordinator Allocation Management Phase 3/4: error mapping + payload
// shaping for the 4 allocation RPCs live in `coordinatorAllocationMapping.ts`
// (imported at the top of this file), not inline here - that module has no
// dependency on the Supabase client, so it's directly Node-importable by
// `scripts/smoke-coordinator-allocation.ts` (the real implementation, never
// a pinned copy that could silently drift from it).
async function callCoordinatorAllocationRpc<T>(
  promise: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T> {
  const result = await promise;
  if (result.error)
    throw new Error(mapCoordinatorAllocationRpcErrorMessage(result.error.message));
  return result.data as T;
}

/**
 * Election Day's Supabase-backed data access - implements exactly the
 * election-day slice of `ApiClient` (see `src/services/api/index.ts`, which
 * composes this together with `MockApi` for the rest of the app). Schema:
 * `supabase/migrations/*_election_day_*.sql`.
 */
export class SupabaseElectionDayApi {
  /** Runs the whole replace-the-ride-list operation as one atomic call via
   * the `election_day_import_voters` RPC (see the "election_day_atomic_import"
   * migration) - a Postgres function body is one implicit transaction, so a
   * failure partway through (e.g. a malformed row) rolls back the deletes
   * too, instead of leaving the live table permanently empty. Previously
   * this ran as 3 separate REST calls (delete events, delete voters, insert
   * voters) with no such guarantee. */
  async importElectionDayVoters(rows: NewElectionDayVoter[]): Promise<{ count: number }> {
    const { data, error } = await supabase.rpc("election_day_import_voters", {
      p_voters: rows.map((r) => ({
        masad: r.masad,
        first_name: r.firstName,
        last_name: r.lastName,
        street: r.street,
        house_number: r.houseNumber,
        city: r.city,
        phone: r.phone,
        coordinator: r.coordinator,
      })),
    });
    if (error) throw new Error(mapImportRpcErrorMessage(error.message));
    return { count: data as number };
  }

  async listElectionDayVoters(): Promise<ElectionDayVoter[]> {
    // PostgREST caps an unranged `.select()` at its default max-rows (1000) -
    // a real ride-list can exceed that, so this pages through with `.range()`
    // until a page comes back short, rather than trusting a single request.
    const pageSize = 1000;
    const rows: VoterRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = unwrapArray<VoterRow[]>(
        await supabase
          .from("election_day_voters")
          .select("*")
          .range(offset, offset + pageSize - 1),
      );
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows.map(toVoter);
  }

  async clearElectionDayVoters(): Promise<void> {
    checkError(
      await supabase.from("election_day_voters").delete().neq("id", NEVER_MATCHES_ID),
    );
    checkError(
      await supabase
        .from("election_day_ride_status_events")
        .delete()
        .neq("id", NEVER_MATCHES_ID),
    );
  }

  private async updateVoter(
    id: string,
    patch: Partial<VoterRow>,
  ): Promise<ElectionDayVoter> {
    const data = unwrapRow<VoterRow>(
      await supabase
        .from("election_day_voters")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single(),
    );
    return toVoter(data);
  }

  async setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter> {
    return this.updateVoter(id, {
      ride_requested: requested,
      ride_requested_at: requested ? new Date().toISOString() : null,
    });
  }

  async setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter> {
    const before = unwrapRow<{ ride_arranged: boolean }>(
      await supabase
        .from("election_day_voters")
        .select("ride_arranged")
        .eq("id", id)
        .single(),
    );

    const updated = await this.updateVoter(id, {
      ride_arranged: arranged,
      ride_arranged_at: arranged ? new Date().toISOString() : null,
    });

    checkError(
      await supabase.from("election_day_ride_status_events").insert({
        contact_id: updated.id,
        contact_name: `${updated.firstName} ${updated.lastName}`,
        coordinator: updated.coordinator,
        from_arranged: before.ride_arranged,
        to_arranged: arranged,
      }),
    );

    return updated;
  }

  async setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter> {
    return this.updateVoter(id, {
      ride_completed: completed,
      ride_completed_at: completed ? new Date().toISOString() : null,
    });
  }

  async listRideStatusEvents(): Promise<RideStatusEvent[]> {
    // Same PostgREST default max-rows (1000) concern as listElectionDayVoters
    // - an election day can generate more ride-status events than that.
    const pageSize = 1000;
    const rows: RideStatusEventRow[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = unwrapArray<RideStatusEventRow[]>(
        await supabase
          .from("election_day_ride_status_events")
          .select("*")
          .order("created_at", { ascending: false })
          .range(offset, offset + pageSize - 1),
      );
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows.map(toRideStatusEvent);
  }

  async getElectionDayDeadline(): Promise<string | null> {
    const data = unwrapRow<{ deadline: string | null }>(
      await supabase
        .from("election_day_settings")
        .select("deadline")
        .eq("id", true)
        .single(),
    );
    return data.deadline;
  }

  async setElectionDayDeadline(deadline: string | null): Promise<string | null> {
    unwrapRow<{ deadline: string | null }>(
      await supabase
        .from("election_day_settings")
        .update({ deadline })
        .eq("id", true)
        .select("deadline")
        .single(),
    );
    return deadline;
  }

  /** Reminder Lifecycle v1: goes through the `election_day_set_reminder` RPC
   * (not the plain `updateVoter` REST-patch path) so creating/rescheduling a
   * reminder is atomic with logging a 'rescheduled' event for any
   * previously-open reminder - a race-prone client-side read-modify-write
   * couldn't express that. The absolute ISO timestamp is still computed
   * client-side exactly like before. */
  async setReminder(
    id: string,
    minutesFromNow: number,
    actorName: string,
  ): Promise<ElectionDayVoter> {
    const reminderAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_set_reminder", {
        p_id: id,
        p_reminder_at: reminderAt,
        p_actor_name: actorName,
      }),
    );
    return toVoter(data[0]);
  }

  async setReminderAt(
    id: string,
    at: string,
    actorName: string,
  ): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_set_reminder", {
        p_id: id,
        p_reminder_at: at,
        p_actor_name: actorName,
      }),
    );
    return toVoter(data[0]);
  }

  /** Reminder Lifecycle v1: explicit "mark handled" - closes the currently
   * open reminder (`reminderClosedReason: "handled"`) via the
   * `election_day_close_reminder` RPC. Idempotent no-op if none is open. */
  async closeReminder(id: string, actorName: string): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_close_reminder", {
        p_id: id,
        p_actor_name: actorName,
      }),
    );
    return toVoter(data[0]);
  }

  /** Reminder Lifecycle v1: explicit cancel - closes the currently open
   * reminder (`reminderClosedReason: "cancelled"`) via the
   * `election_day_cancel_reminder` RPC. Idempotent no-op if none is open. */
  async cancelReminder(id: string, actorName: string): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_cancel_reminder", {
        p_id: id,
        p_actor_name: actorName,
      }),
    );
    return toVoter(data[0]);
  }

  /** Reminder Lifecycle v1: goes through the `election_day_set_voted` RPC
   * (not the plain `updateVoter` REST-patch path this used before) so
   * setting voted/voted_at is atomic with closing any currently open
   * reminder (`reminderClosedReason: "voted"`) - only when `voted = true`;
   * un-voting never touches reminder state. */
  async setVoted(
    id: string,
    voted: boolean,
    actorName: string,
  ): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_set_voted", {
        p_id: id,
        p_voted: voted,
        p_actor_name: actorName,
      }),
    );
    return toVoter(data[0]);
  }

  /** Reminder Lifecycle v1: goes through the `election_day_set_non_voting_reason`
   * RPC (previously a plain REST update via `updateVoter`, back when RLS
   * permissiveness alone was enough) so setting the reason is atomic with
   * closing any currently open reminder (`reminderClosedReason:
   * "case_closed"`) - only when the newly-set reason's `requiresFollowUp` is
   * `false`; a reason with `requiresFollowUp: true`, or clearing the reason
   * entirely, leaves the reminder untouched. Still does NOT touch
   * `voted`/`voted_at` - the reason is purely additive metadata, and by
   * product decision is never cleared automatically (not even when `voted`
   * is later set to `true` elsewhere) - only an explicit call with
   * `reasonId: null` clears it. */
  async setNonVotingReason(
    id: string,
    reasonId: string | null,
    setByName: string | null,
  ): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_set_non_voting_reason", {
        p_id: id,
        p_reason_id: reasonId,
        p_actor_name: setByName,
      }),
    );
    return toVoter(data[0]);
  }

  /** Reminder Lifecycle v1: full create/close/cancel/reschedule history for
   * one contact's reminder, newest first. Plain PostgREST select (not an
   * RPC) - RLS on `election_day_reminder_events` is permissive for reads,
   * same as every other Election Day table, and this is bounded to one
   * contact's own history (never large), so no `.range()` paging is
   * needed. */
  async listReminderEvents(contactId: string): Promise<ReminderEvent[]> {
    const data = unwrapArray<ReminderEventRow[]>(
      await supabase
        .from("election_day_reminder_events")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false }),
    );
    return data.map(toReminderEvent);
  }

  /** These two go through a dedicated RPC (not the `updateVoter` REST-patch
   * path every other single-field setter uses) because they need an atomic
   * `column = column + 1`, which plain PostgREST PATCH can't express without
   * a race-prone client-side read-modify-write. */
  async incrementCallAttempts(id: string): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_increment_call_attempts", { p_id: id }),
    );
    return toVoter(data[0]);
  }

  async extendCallAttemptsThreshold(id: string): Promise<ElectionDayVoter> {
    const data = unwrapArray<VoterRow[]>(
      await supabase.rpc("election_day_extend_call_attempts_threshold", { p_id: id }),
    );
    return toVoter(data[0]);
  }

  async setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter> {
    return this.updateVoter(id, { notes });
  }

  async setPhone(id: string, phone: string): Promise<ElectionDayVoter> {
    return this.updateVoter(id, { phone });
  }

  async listRideCoordinators(): Promise<RideCoordinator[]> {
    return unwrapArray<RideCoordinator[]>(
      await supabase
        .from("election_day_ride_coordinators")
        .select("id, name, phone")
        .order("created_at", { ascending: true }),
    );
  }

  async addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator> {
    return unwrapRow<RideCoordinator>(
      await supabase
        .from("election_day_ride_coordinators")
        .insert({ name: input.name, phone: input.phone })
        .select("id, name, phone")
        .single(),
    );
  }

  async deleteRideCoordinator(id: string): Promise<void> {
    checkError(
      await supabase.from("election_day_ride_coordinators").delete().eq("id", id),
    );
  }

  async listPermissionUsers(): Promise<PermissionUser[]> {
    const data = unwrapArray<PermissionUserRpcRow[]>(
      await supabase.rpc("election_day_list_permission_users"),
    );
    return data.map(toPermissionUser);
  }

  async deletePermissionUser(id: string): Promise<void> {
    checkError(await supabase.rpc("election_day_delete_permission_user", { p_id: id }));
  }

  /** Resets an existing PermissionUser's (`targetId`) password_hash in
   * place - but only after the RPC genuinely re-authenticates the acting
   * manager server-side (bcrypt-verifies `actorPassword` against the
   * actor's own `password_hash`, then checks the actor's role holds
   * `electionDay.manageUsers`). See `mapRoleRpcErrorMessage` for how
   * `UNAUTHORIZED`/`FORBIDDEN`/`USER_NOT_FOUND`/`INVALID_PASSWORD` become
   * Hebrew toast text. Never returns/exposes the password or hash. */
  async resetPermissionUserPassword(
    actorId: string,
    actorPassword: string,
    targetId: string,
    newPassword: string,
  ): Promise<PermissionUser> {
    const data = await callRoleRpc<PermissionUserRpcRow[]>(
      supabase.rpc("election_day_reset_permission_user_password", {
        p_actor_id: actorId,
        p_actor_password: actorPassword,
        p_target_user_id: targetId,
        p_new_password: newPassword,
      }),
    );
    return toPermissionUser(data[0]);
  }

  async verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null> {
    const { data, error } = await supabase.rpc("election_day_login", {
      p_name: name.trim(),
      p_password: password,
    });
    if (error) throw new Error(error.message);
    const rows = data as PermissionUserRpcRow[];
    return rows.length > 0 ? toPermissionUser(rows[0]) : null;
  }

  /** Dynamic Roles & Permissions, Phase 1. Unlike every other RPC result in
   * this file, this one is NOT blindly cast - `permissions`/`scope_type`
   * directly drive security decisions downstream, so each row goes through
   * `normalizeRoleRecord`, which validates every untrusted field
   * independently and fails closed on anything unrecognized (see that
   * function's own doc comment). */
  async listElectionDayRoles(): Promise<RoleRecord[]> {
    const data = unwrapArray<RawRoleRow[]>(await supabase.rpc("election_day_list_roles"));
    return data.map(normalizeRoleRecord);
  }

  /** Dynamic Roles & Permissions Phase 2: real role management. See
   * `mapRoleRpcErrorMessage` for how the DB's business-error codes become
   * Hebrew toast text. */
  async createRole(input: NewRole): Promise<RoleRecord> {
    const data = await callRoleRpc<RawRoleRow[]>(
      supabase.rpc("election_day_create_role", {
        p_name: input.name,
        p_description: input.description,
        p_permissions: input.permissions,
        p_scope_type: input.scopeType,
      }),
    );
    return normalizeRoleRecord(data[0]);
  }

  async updateRole(input: RoleUpdate): Promise<RoleRecord> {
    const data = await callRoleRpc<RawRoleRow[]>(
      supabase.rpc("election_day_update_role", {
        p_role_id: input.id,
        p_name: input.name,
        p_description: input.description,
        p_permissions: input.permissions,
        p_scope_type: input.scopeType,
      }),
    );
    return normalizeRoleRecord(data[0]);
  }

  async deleteRole(id: string): Promise<void> {
    await callRoleRpc<null>(supabase.rpc("election_day_delete_role", { p_role_id: id }));
  }

  async cloneRole(id: string, newName: string): Promise<RoleRecord> {
    const data = await callRoleRpc<RawRoleRow[]>(
      supabase.rpc("election_day_clone_role", { p_role_id: id, p_new_name: newName }),
    );
    return normalizeRoleRecord(data[0]);
  }

  async createPermissionUser(input: NewPermissionUser): Promise<PermissionUser> {
    const data = await callRoleRpc<PermissionUserRpcRow[]>(
      supabase.rpc("election_day_create_permission_user", {
        p_name: input.name,
        p_password: input.password,
        p_role_id: input.roleId,
      }),
    );
    return toPermissionUser(data[0]);
  }

  /** Dynamic Non-Voting Reasons: the full catalog, including inactive rows -
   * not security-critical the way `listElectionDayRoles` is (a reason can't
   * grant a capability), but still normalized defensively via
   * `normalizeNonVotingReasonRecord` rather than a blind cast. */
  async listNonVotingReasons(): Promise<NonVotingReason[]> {
    const data = unwrapArray<RawNonVotingReasonRow[]>(
      await supabase.rpc("election_day_list_non_voting_reasons"),
    );
    return data.map(normalizeNonVotingReasonRecord);
  }

  async createNonVotingReason(input: NewNonVotingReason): Promise<NonVotingReason> {
    const data = await callNonVotingReasonRpc<RawNonVotingReasonRow[]>(
      supabase.rpc("election_day_create_non_voting_reason", {
        p_name: input.name,
        p_description: input.description,
        p_requires_follow_up: input.requiresFollowUp,
      }),
    );
    return normalizeNonVotingReasonRecord(data[0]);
  }

  async updateNonVotingReason(input: NonVotingReasonUpdate): Promise<NonVotingReason> {
    const data = await callNonVotingReasonRpc<RawNonVotingReasonRow[]>(
      supabase.rpc("election_day_update_non_voting_reason", {
        p_id: input.id,
        p_name: input.name,
        p_description: input.description,
        p_requires_follow_up: input.requiresFollowUp,
      }),
    );
    return normalizeNonVotingReasonRecord(data[0]);
  }

  async setNonVotingReasonActive(
    id: string,
    isActive: boolean,
  ): Promise<NonVotingReason> {
    const data = await callNonVotingReasonRpc<RawNonVotingReasonRow[]>(
      supabase.rpc("election_day_set_non_voting_reason_active", {
        p_id: id,
        p_is_active: isActive,
      }),
    );
    return normalizeNonVotingReasonRecord(data[0]);
  }

  async deleteNonVotingReason(id: string): Promise<void> {
    await callNonVotingReasonRpc<null>(
      supabase.rpc("election_day_delete_non_voting_reason", { p_id: id }),
    );
  }

  async reorderNonVotingReasons(orderedIds: string[]): Promise<NonVotingReason[]> {
    const data = await callNonVotingReasonRpc<RawNonVotingReasonRow[]>(
      supabase.rpc("election_day_reorder_non_voting_reasons", {
        p_ordered_ids: orderedIds,
      }),
    );
    return data.map(normalizeNonVotingReasonRecord);
  }

  /** Coordinator Allocation Management Phase 1: a plain SELECT, not an RPC -
   * `election_day_coordinators` has a public SELECT policy (see
   * database.types.ts's comment), unlike the RPC-only permission-users/roles
   * tables. Ordered `created_at asc, id asc` (same deterministic ordering
   * the business RPCs themselves use for equal-split destination ranges) so
   * a consumer relying on stable coordinator order (e.g. a future equal-
   * split preview) sees the same order the server would compute against. */
  async listCoordinators(): Promise<Coordinator[]> {
    const data = unwrapArray<CoordinatorRow[]>(
      await supabase
        .from("election_day_coordinators")
        .select("*")
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }),
    );
    return data.map(toCoordinator);
  }

  /** Atomic batch add/edit/remove/link/relink/unlink - see
   * `election_day_manage_coordinators`'s own comment for the full per-action
   * shape/rules. `actorPassword` is forwarded to the RPC call and never
   * otherwise touched (not logged, not cached) by this method. */
  async manageCoordinators(
    actorId: string,
    actorPassword: string,
    actions: CoordinatorAction[],
  ): Promise<Coordinator[]> {
    const data = await callCoordinatorAllocationRpc<CoordinatorRow[]>(
      supabase.rpc("election_day_manage_coordinators", {
        p_actor_id: actorId,
        p_actor_password: actorPassword,
        p_actions: actions.map(toCoordinatorActionPayload),
      }),
    );
    return data.map(toCoordinator);
  }

  /** One-time distribution of every currently-unassigned voter - the server
   * is the sole source of truth for which voters actually get allocated,
   * this method sends only coordinator/quantity pairs, never a voter id. */
  async applyInitialAllocation(
    actorId: string,
    actorPassword: string,
    assignments: AllocationAssignment[],
  ): Promise<ApplyInitialAllocationResult> {
    const data = await callCoordinatorAllocationRpc<
      {
        operation_id: string;
        allocated_count: number;
        remaining_unassigned_count: number;
      }[]
    >(
      supabase.rpc("election_day_apply_initial_allocation", {
        p_actor_id: actorId,
        p_actor_password: actorPassword,
        p_assignments: assignments.map(toAllocationAssignmentPayload),
      }),
    );
    const row = data[0];
    return {
      operationId: row.operation_id,
      allocatedCount: row.allocated_count,
      remainingUnassignedCount: row.remaining_unassigned_count,
    };
  }

  /** Mid-day transfer of "remaining" voters from source coordinators to
   * destination coordinators, by quantity only. */
  async rebalanceAssignments(
    actorId: string,
    actorPassword: string,
    sources: AllocationAssignment[],
    destinations: AllocationAssignment[],
  ): Promise<RebalanceAssignmentsResult> {
    const data = await callCoordinatorAllocationRpc<
      { operation_id: string; transferred_count: number }[]
    >(
      supabase.rpc("election_day_rebalance_assignments", {
        p_actor_id: actorId,
        p_actor_password: actorPassword,
        p_sources: sources.map(toAllocationAssignmentPayload),
        p_destinations: destinations.map(toAllocationAssignmentPayload),
      }),
    );
    const row = data[0];
    return { operationId: row.operation_id, transferredCount: row.transferred_count };
  }

  /** Ends one active coordinator's activity - `targetCoordinatorId` is
   * required for `"transfer"`, ignored (sent as `null`) for
   * `"equal_split"`. */
  async endCoordinatorActivity(
    actorId: string,
    actorPassword: string,
    coordinatorId: string,
    mode: EndCoordinatorActivityMode,
    targetCoordinatorId: string | null,
  ): Promise<EndCoordinatorActivityResult> {
    const data = await callCoordinatorAllocationRpc<
      {
        operation_id: string;
        transferred_count: number;
        ended_coordinator_id: string;
        ended_coordinator_display_name: string;
      }[]
    >(
      supabase.rpc("election_day_end_coordinator_activity", {
        p_actor_id: actorId,
        p_actor_password: actorPassword,
        p_coordinator_id: coordinatorId,
        p_mode: mode,
        p_target_coordinator_id: mode === "transfer" ? targetCoordinatorId : null,
      }),
    );
    const row = data[0];
    return {
      operationId: row.operation_id,
      transferredCount: row.transferred_count,
      endedCoordinatorId: row.ended_coordinator_id,
      endedCoordinatorDisplayName: row.ended_coordinator_display_name,
    };
  }

  /** Live cross-device sync for `useElectionDay.ts`'s own contacts/events
   * state (see the "election_day_realtime" migration). Deliberately just
   * triggers a refetch (`onChange`) rather than merging partial payloads
   * into local state - simpler and safer than hand-rolled diffing for this
   * internal tool's scale.
   *
   * Scoped to exactly the 2 tables `useElectionDay.ts` itself reads
   * (contacts/events) - `election_day_coordinators` is deliberately NOT
   * listened to here, see `subscribeToCoordinatorChanges` below for why it
   * has its own dedicated method/channel rather than being folded into this
   * one. History tables (election_day_coordinator_operations/
   * _operation_items) are deliberately NOT subscribed anywhere - they have
   * zero client SELECT policies and no `ApiClient` read method exists for
   * them (locked design - see task-plan.md/CLAUDE.md's Known Security
   * Limitations). */
  subscribeToElectionDayChanges(onChange: () => void): () => void {
    const channel = supabase
      .channel("election-day-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "election_day_voters" },
        onChange,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "election_day_ride_status_events" },
        onChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }

  /** Coordinator Allocation Management Phase 4: live cross-device sync for
   * `useCoordinatorAllocation.ts`'s own coordinator roster - deliberately a
   * SEPARATE method/channel from `subscribeToElectionDayChanges` above,
   * not a 3rd `.on(...)` added to that one's channel.
   *
   * Why: `supabase-js`'s `RealtimeClient.channel(topic)` REUSES an existing
   * channel object when called again with the same topic string (see its
   * own doc comment - "if a channel with the same topic already exists it
   * will be returned instead of creating a duplicate connection"), and
   * `RealtimeChannel.on(...)` throws once `.subscribe()` has already been
   * called on that channel ("cannot add `postgres_changes` callbacks for
   * ... after `subscribe()`"). `useElectionDay` and `useCoordinatorAllocation`
   * are two independent hooks, each running its own mount effect - if both
   * called a single shared method using one hardcoded channel name, the
   * hook whose effect runs second would receive the SAME already-subscribed
   * channel object back from `supabase.channel(...)` and its own `.on(...)`
   * registration would throw synchronously inside its effect. Worse, since
   * both hooks would then hold a reference to the literal same channel
   * object, either hook unmounting first would call `removeChannel` on that
   * shared object and tear down the other's subscription too - confirmed
   * against the installed `@supabase/realtime-js` source
   * (`RealtimeClient.removeChannel`/`RealtimeChannel.teardown` operate on
   * the channel instance, not per-caller). A distinct channel name per
   * subscriber sidesteps this identity-sharing entirely - each hook gets
   * its own channel object, its own independent join, and its own
   * independent, safe `removeChannel` cleanup that can never affect the
   * other's. */
  subscribeToCoordinatorChanges(onChange: () => void): () => void {
    const channel = supabase
      .channel("election-day-coordinator-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "election_day_coordinators" },
        onChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }
}
