/* eslint @typescript-eslint/no-unused-vars: ["error", { argsIgnorePattern: "^_" }] -- several
 * methods below keep an `_actorName`/`_reasonId`/`_setByName` parameter purely so their
 * signature stays call-compatible with the `ApiClient` interface (see this file's own
 * header comment) - the trusted backend resolves actor identity server-side and never
 * reads it. */
import {
  normalizeNonVotingReasonRecord,
  type RawNonVotingReasonRow,
} from "./nonVotingReasonMapper";
import type {
  ElectionDayVoter,
  NonVotingReason,
  ReminderClosedReason,
  ReminderEvent,
  RideCoordinator,
  RideStatusEvent,
} from "../../types";
import type {
  NewNonVotingReason,
  NewRideCoordinator,
  NonVotingReasonUpdate,
} from "./types";

/**
 * Multi-Tenant Phase 4B Frontend Cutover: pure fetch wrappers around the
 * trusted, session-derived `/api/election-day/actions` endpoint - the
 * trusted frontend client abstraction for the Phase 4B voter/settings/
 * ride-coordinator/non-voting-reason actions.
 *
 * `createNonVotingReason`/`updateNonVotingReason` and the 10 voter-mutation
 * methods (`setRideArranged`/`setReminder`/`setReminderAt`/`closeReminder`/
 * `cancelReminder`/`setVoted`/`setNonVotingReason`/`recordNoAnswer`/
 * `recordCallAnswered`/`extendNoAnswerStreakThreshold`) were held back from
 * the first Frontend Cutover pass and are now wired into `api`
 * (`src/services/api/index.ts`), following the Backend Compatibility Fix
 * (migration
 * `20260831010000_multi_tenant_phase4b_backend_compatibility_fix.sql`):
 * `createNonVotingReason`/`updateNonVotingReason` needed a 4-arg
 * `p_requires_follow_up` overload added to
 * `election_day_create_non_voting_reason_core/_v3/_owner_v3` and
 * `update_non_voting_reason_core/_v3/_owner_v3` (the pre-existing 3-arg
 * overloads are untouched, still present) - `actions.ts`/`owner-actions.ts`'s
 * op descriptors require `requiresFollowUp` in the request body and forward
 * it as `p_requires_follow_up`, which is what resolves the new 4-arg
 * overload. The 10 voter mutations needed the same `coalesce(coordinator,
 * '')` null-safety fix the legacy RPCs already carried (migration
 * `20260812090200_election_day_reminder_lifecycle_null_coordinator_
 * hardening.sql`) applied to their `_core` functions, which previously read
 * `coordinator` raw before inserting into `election_day_reminder_events`/
 * `election_day_ride_status_events` (`coordinator NOT NULL`) and raised a
 * live `23502 not-null-violation` against any coordinator-less voter -
 * confirmed fixed via a real coordinator-less-voter round trip against
 * every one of these ops before cutting over.
 *
 * None of these RPCs require a step-up reauth proof (`requiresProof: false`
 * on every op in `actions.ts`'s `OPS` table) - unlike
 * `electionDayTrustedCoordinatorAllocationClient.ts`'s 4 mutations, so no
 * `ElectionDayReauthError`/proof-minting machinery is needed here. Every
 * method below deliberately keeps the exact same signature
 * `SupabaseElectionDayApi`'s corresponding method has (including any
 * `actorName`/`setByName` parameter) so `src/services/api/index.ts` can
 * swap the delegation target per-key with zero changes to
 * `useElectionDay.ts`/`useNonVotingReasons.ts` call sites - the actor
 * identity is resolved server-side from the session cookie now (see
 * CLAUDE.md's "no client-supplied actor identity" guardrail), so the
 * parameter is accepted for interface compatibility and silently ignored,
 * never sent over the wire (`actions.ts`'s body-key whitelist would reject
 * an unrecognized field like `actorName` with `INVALID_REQUEST` if it were
 * sent).
 *
 * Row mapping deliberately duplicates `supabaseElectionDayApi.ts`'s private
 * (non-exported) `toVoter`/`toReminderEvent`/`toRideStatusEvent` shape
 * rather than importing it - `normalizeNonVotingReasonRecord` IS imported
 * from `nonVotingReasonMapper.ts` since that one already lives in its own
 * dependency-free module and is exported.
 */

const ACTIONS_ENDPOINT = "/api/election-day/actions";

/**
 * `election_day_list_voters_v3`'s row shape - unlike `SupabaseElectionDayApi`'s
 * own `VoterRow` (a raw, always-fully-populated `select("*")` on the real
 * table), this one comes from `election_day_list_voters_core`'s per-field
 * `CASE WHEN <permission> THEN col ELSE ... END` redaction. Most redacted
 * columns fall back to a safe non-null default matching their domain
 * type's own nullability (`ride_requested`→`false`, `call_attempts`→`0`,
 * etc.) - but `masad`/`first_name`/`last_name`/`street`/`house_number`/
 * `city`/`notes` fall back to a genuine SQL `null` despite their
 * `ElectionDayVoter` counterparts (`masad`/`firstName`/.../`houseNumber`)
 * being non-nullable `string`/`number` - confirmed by reading the actual
 * `CASE WHEN ... ELSE null END` for each in
 * `20260831000000_multi_tenant_phase4b_trusted_voter_settings_expand.sql`,
 * not assumed. `toVoter` below coerces each to match its non-nullable
 * domain type, the same defensive pattern already used for `coordinator`. */
type VoterRow = {
  id: string;
  masad: string | null;
  first_name: string | null;
  last_name: string | null;
  street: string | null;
  house_number: number | null;
  city: string | null;
  phone: string | null;
  coordinator: string | null;
  notes: string | null;
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
  no_answer_streak: number;
  no_answer_streak_threshold: number;
  pending_call_id: string | null;
};

function toVoter(row: VoterRow): ElectionDayVoter {
  return {
    id: row.id,
    masad: row.masad ?? "",
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    street: row.street ?? "",
    houseNumber: row.house_number ?? 0,
    city: row.city ?? "",
    phone: row.phone,
    coordinator: row.coordinator ?? "",
    notes: row.notes ?? "",
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
    noAnswerStreak: row.no_answer_streak,
    noAnswerStreakThreshold: row.no_answer_streak_threshold,
    pendingCallId: row.pending_call_id,
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

/** The 8 stable, English error codes the 27 cutover-scope `_core` functions
 * can actually raise (verified by grepping every `raise exception` in
 * `20260831000000_multi_tenant_phase4b_trusted_voter_settings_expand.sql`) -
 * translated here once, mirroring `mapNonVotingReasonRpcErrorMessage`'s/
 * `mapCoordinatorAllocationRpcErrorMessage`'s exact style. `UNAUTHORIZED`
 * here means "no valid session" (the trusted backend's own actor
 * resolution failed), NOT a wrong password - a materially different
 * meaning from `mapCoordinatorAllocationRpcErrorMessage`'s `UNAUTHORIZED`
 * (that one comes from a real actor-password re-auth check on a
 * `requiresProof: true` op), so it is NOT reused here. An unrecognized code
 * falls through to the raw code string, same fail-safe as every other
 * mapper in this codebase. */
function mapTrustedActionErrorMessage(code: string): string {
  switch (code) {
    case "UNAUTHORIZED":
      return "החיבור שלך פג תוקף - יש להתחבר מחדש";
    case "FORBIDDEN":
      return "אין לך הרשאה לבצע פעולה זו";
    case "VOTER_NOT_FOUND":
      return "הבוחר לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
    case "REASON_NOT_FOUND":
      return "הסיבה לא נמצאה - ייתכן שנמחקה על ידי משתמש אחר";
    case "REASON_NAME_REQUIRED":
      return "יש להזין שם לסיבה";
    case "REASON_IN_USE":
      return "לא ניתן למחוק סיבה המשויכת לבוחרים";
    case "REORDER_ID_MISMATCH":
      return "רשימת הסידור אינה תואמת את רשימת הסיבות הקיימת - רעננו ונסו שוב";
    case "NO_ANSWER_REASON_NOT_CONFIGURED":
      return "סיבת 'לא עונה' אינה מוגדרת במערכת - יש להגדיר אותה תחילה במסך ניהול סיבות אי-הצבעה";
    default:
      return code;
  }
}

const GENERIC_ERROR = "אירעה שגיאה, נסו שוב";

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorCodeFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" ? code : undefined;
}

/** Shared POST helper for every mutation below - none of the 27 cutover-
 * scope ops require a reauth proof (`requiresProof: false` in `actions.ts`'s
 * `OPS` table), so unlike `postCoordinatorAllocation` this never produces a
 * typed `ElectionDayReauthError` - every failure becomes a plain `Error`
 * with an already-Hebrew `.message`, matching `useAsyncAction`'s generic
 * toast contract. */
async function postAction(op: string, extra: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ACTIONS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...extra }),
    });
  } catch {
    throw new Error(GENERIC_ERROR);
  }
  if (res.status === 200) return await readJson(res);
  const body = await readJson(res);
  const code = errorCodeFromBody(body);
  throw new Error(code ? mapTrustedActionErrorMessage(code) : GENERIC_ERROR);
}

/** Shared GET helper for the 6 cutover-scope reads - no reauth proof, same
 * convention as every other trusted v3 read in this codebase. */
async function getAction(
  op: string,
  query: Record<string, string> = {},
): Promise<unknown> {
  const qs = new URLSearchParams({ op, ...query });
  let res: Response;
  try {
    res = await fetch(`${ACTIONS_ENDPOINT}?${qs.toString()}`, { method: "GET" });
  } catch {
    throw new Error(GENERIC_ERROR);
  }
  if (res.status === 200) return await readJson(res);
  const body = await readJson(res);
  const code = errorCodeFromBody(body);
  throw new Error(code ? mapTrustedActionErrorMessage(code) : GENERIC_ERROR);
}

/** Unwraps a voter-mutation POST response - every voter `_v3` RPC is
 * `RETURNS SETOF election_day_voters`, so `actions.ts` always returns a
 * 1-element array on success (a `VOTER_NOT_FOUND` failure never reaches this
 * point - it comes back as a mapped error, not an empty array). Blind cast
 * after the length check - no per-field runtime validation, matching
 * `supabaseElectionDayApi.ts`'s own `toVoter(data[0])` rigor level (unlike
 * the defensive `normalizeNonVotingReasonRecord`/`RoleRecord` mappers
 * elsewhere, a voter row is not security-critical the same way). */
function unwrapVoterMutation(data: unknown): ElectionDayVoter {
  if (!Array.isArray(data) || data.length !== 1) throw new Error(GENERIC_ERROR);
  return toVoter(data[0] as VoterRow);
}

/**
 * Multi-Tenant Phase 4B Frontend Cutover: implements all 28 `ApiClient`
 * Election Day voter/settings/ride-coordinator/non-voting-reason methods,
 * plus `closeCallAsNoAnswer` (not part of `ApiClient` - a genuinely distinct
 * action from `setNonVotingReason`, see this class's own method doc). Every
 * ApiClient-compatible method here is wired into the `api` singleton
 * (`src/services/api/index.ts`) in place of the corresponding
 * `SupabaseElectionDayApi` method.
 */
export class TrustedElectionDayActionsApi {
  async listElectionDayVoters(): Promise<ElectionDayVoter[]> {
    const data = await getAction("list_voters");
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return (data as VoterRow[]).map(toVoter);
  }

  async setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_ride_requested", { id, requested }));
  }

  async setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_ride_arranged", { id, arranged }));
  }

  async setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_ride_completed", { id, completed }));
  }

  async listRideStatusEvents(): Promise<RideStatusEvent[]> {
    const data = await getAction("list_ride_status_events");
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return (data as RideStatusEventRow[]).map(toRideStatusEvent);
  }

  async getElectionDayDeadline(): Promise<string | null> {
    const data = await getAction("get_settings");
    return (data ?? null) as string | null;
  }

  /** Mirrors `SupabaseElectionDayApi.setElectionDayDeadline`'s exact
   * contract: returns the input `deadline` on success, never a value read
   * back from the response body - `election_day_set_settings_v3` returns a
   * bare `timestamptz` scalar, and `actions.ts`'s POST handler collapses a
   * `null` scalar to `{ok:true}` (`data ?? {ok:true}`), so there is no
   * reliable response shape to parse a cleared deadline back out of
   * anyway. */
  async setElectionDayDeadline(deadline: string | null): Promise<string | null> {
    await postAction("set_settings", { deadline });
    return deadline;
  }

  async setReminder(
    id: string,
    minutesFromNow: number,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    const reminderAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    return unwrapVoterMutation(await postAction("set_reminder", { id, reminderAt }));
  }

  async setReminderAt(
    id: string,
    at: string,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_reminder", { id, reminderAt: at }));
  }

  async closeReminder(id: string, _actorName: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("close_reminder", { id }));
  }

  async cancelReminder(id: string, _actorName: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("cancel_reminder", { id }));
  }

  async setVoted(
    id: string,
    voted: boolean,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_voted", { id, voted }));
  }

  async setNonVotingReason(
    id: string,
    reasonId: string | null,
    _setByName: string | null,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(
      await postAction("set_non_voting_reason", { id, reasonId }),
    );
  }

  /** Call Outcome Tracking's "close as לא עונה" action - NOT part of
   * `ApiClient` (called directly by `useElectionDay.ts`, not through the
   * `api` singleton). Genuinely distinct from `setNonVotingReason` above at
   * the trusted-backend level (`voter.viewPhone` permission, no
   * `reasonId` parameter at all - the server resolves the workspace's own
   * "לא עונה" catalog row internally and raises
   * `NO_ANSWER_REASON_NOT_CONFIGURED` if none exists), matching the
   * approved Phase 4B authorization-split design. Takes only `id` - a
   * client-resolved reason id (as the legacy call site still computes, for
   * the still-legacy `setNonVotingReason` path) is never sent. */
  async closeCallAsNoAnswer(id: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("close_call_as_no_answer", { id }));
  }

  async listReminderEvents(contactId: string): Promise<ReminderEvent[]> {
    const data = await getAction("list_reminder_events", { contactId });
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return (data as ReminderEventRow[]).map(toReminderEvent);
  }

  async incrementCallAttempts(id: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("increment_call_attempts", { id }));
  }

  async recordNoAnswer(
    id: string,
    callId: string,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("record_no_answer", { id, callId }));
  }

  async recordCallAnswered(
    id: string,
    callId: string,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("record_call_answered", { id, callId }));
  }

  async extendNoAnswerStreakThreshold(
    id: string,
    _actorName: string,
  ): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(
      await postAction("extend_no_answer_streak_threshold", { id }),
    );
  }

  async setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_notes", { id, notes }));
  }

  async setPhone(id: string, phone: string): Promise<ElectionDayVoter> {
    return unwrapVoterMutation(await postAction("set_phone", { id, phone }));
  }

  async listRideCoordinators(): Promise<RideCoordinator[]> {
    const data = await getAction("list_ride_coordinators");
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return data as RideCoordinator[];
  }

  async addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator> {
    const data = await postAction("add_ride_coordinator", {
      name: input.name,
      phone: input.phone,
    });
    if (!data || typeof data !== "object") throw new Error(GENERIC_ERROR);
    return data as RideCoordinator;
  }

  async deleteRideCoordinator(id: string): Promise<void> {
    await postAction("delete_ride_coordinator", { id });
  }

  async listNonVotingReasons(): Promise<NonVotingReason[]> {
    const data = await getAction("list_non_voting_reasons");
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return (data as RawNonVotingReasonRow[]).map(normalizeNonVotingReasonRecord);
  }

  /** Phase 4B Backend Compatibility Fix: `requiresFollowUp` is sent
   * explicitly as `requiresFollowUp` in the request body - `actions.ts`'s
   * `create_non_voting_reason` op descriptor requires it and forwards it as
   * `p_requires_follow_up`, which is what resolves the 4-arg
   * `election_day_create_non_voting_reason_v3` overload (not the 3-arg one
   * that ignores it). */
  async createNonVotingReason(input: NewNonVotingReason): Promise<NonVotingReason> {
    const data = await postAction("create_non_voting_reason", {
      name: input.name,
      description: input.description,
      requiresFollowUp: input.requiresFollowUp,
    });
    if (!data || typeof data !== "object") throw new Error(GENERIC_ERROR);
    return normalizeNonVotingReasonRecord(data as RawNonVotingReasonRow);
  }

  /** Same `requiresFollowUp`/overload-resolution contract as
   * `createNonVotingReason` above. */
  async updateNonVotingReason(input: NonVotingReasonUpdate): Promise<NonVotingReason> {
    const data = await postAction("update_non_voting_reason", {
      id: input.id,
      name: input.name,
      description: input.description,
      requiresFollowUp: input.requiresFollowUp,
    });
    if (!data || typeof data !== "object") throw new Error(GENERIC_ERROR);
    return normalizeNonVotingReasonRecord(data as RawNonVotingReasonRow);
  }

  async setNonVotingReasonActive(
    id: string,
    isActive: boolean,
  ): Promise<NonVotingReason> {
    const data = await postAction("set_non_voting_reason_active", { id, isActive });
    if (!data || typeof data !== "object") throw new Error(GENERIC_ERROR);
    return normalizeNonVotingReasonRecord(data as RawNonVotingReasonRow);
  }

  async deleteNonVotingReason(id: string): Promise<void> {
    await postAction("delete_non_voting_reason", { id });
  }

  async reorderNonVotingReasons(orderedIds: string[]): Promise<NonVotingReason[]> {
    const data = await postAction("reorder_non_voting_reasons", { orderedIds });
    if (!Array.isArray(data)) throw new Error(GENERIC_ERROR);
    return (data as RawNonVotingReasonRow[]).map(normalizeNonVotingReasonRecord);
  }
}

/** Single shared instance - stateless, so one instance serves both the `api`
 * singleton wiring (`src/services/api/index.ts`) and `useElectionDay.ts`'s
 * direct call to `closeCallAsNoAnswer` (not part of `ApiClient`). */
export const trustedElectionDayActionsApi = new TrustedElectionDayActionsApi();
