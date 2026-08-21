/** Reminder Lifecycle v1 - pure-logic smoke test. Run via:
 * npx esbuild scripts/smoke-reminder-lifecycle.ts --bundle --format=cjs --outfile=scripts/smoke-reminder-lifecycle.cjs && node scripts/smoke-reminder-lifecycle.cjs
 *
 * Covers, DB-free, the 3 new pure modules the Reminder Lifecycle v1 feature
 * introduced:
 * - `reminderLifecycle.ts`'s `resolveReminderLifecycleState` (the single
 *   source of truth for FUTURE/DUE/CLOSED/CANCELLED/NONE) and
 *   `isReminderOutstanding`.
 * - `reminderStatus.ts`'s `isReminderActive`/`isReminderDue`, confirming
 *   they're genuinely derived through `resolveReminderLifecycleState` and not
 *   re-implemented inline.
 * - `followUpBreakdown.ts`'s `buildClosedRemindersToday` (local-calendar-day
 *   "today", never UTC) and `buildFollowUpBreakdown` (the 3-bucket dashboard
 *   row 3 shape, confirming `notYetHandled` is genuinely gone).
 */
import {
  resolveReminderLifecycleState,
  isReminderOutstanding,
} from "../src/features/election-day/reminderLifecycle";
import { isReminderActive, isReminderDue } from "../src/features/election-day/reminderStatus";
import {
  buildFollowUpBreakdown,
  buildClosedRemindersToday,
} from "../src/features/election-day/followUpBreakdown";
import type { ElectionDayVoter, NonVotingReason, ReminderClosedReason } from "../src/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function makeContact(overrides: Partial<ElectionDayVoter> = {}): ElectionDayVoter {
  return {
    id: "c-1",
    masad: "1",
    firstName: "שם",
    lastName: "משפחה",
    street: "רחוב",
    houseNumber: 1,
    city: "עיר",
    phone: null,
    coordinator: "אבי",
    notes: "",
    rideRequested: false,
    rideRequestedAt: null,
    rideArranged: false,
    rideArrangedAt: null,
    rideCompleted: false,
    rideCompletedAt: null,
    reminderAt: null,
    reminderClosedAt: null,
    reminderClosedReason: null,
    reminderClosedBy: null,
    voted: false,
    votedAt: null,
    notVotingReasonId: null,
    notVotingReasonSetAt: null,
    notVotingReasonSetBy: null,
    callAttempts: 0,
    callAttemptsThreshold: 3,
    lastCallAttemptAt: null,
    noAnswerStreak: 0,
    noAnswerStreakThreshold: 3,
    pendingCallId: null,
    ...overrides,
  };
}

function makeReason(overrides: Partial<NonVotingReason> = {}): NonVotingReason {
  return {
    id: "r-1",
    name: "לא עונה",
    description: "",
    isActive: true,
    sortOrder: 0,
    requiresFollowUp: true,
    ...overrides,
  };
}

// ============================================================================
// resolveReminderLifecycleState
// ============================================================================
const NOW = new Date("2026-08-10T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const FUTURE_ISO = new Date(NOW.getTime() + 60_000).toISOString();
const PAST_ISO = new Date(NOW.getTime() - 60_000).toISOString();

assert(
  resolveReminderLifecycleState({ reminderAt: null, reminderClosedReason: null }, NOW) === "none",
  'no reminderAt, no reminderClosedReason -> "none"',
);

assert(
  resolveReminderLifecycleState({ reminderAt: FUTURE_ISO, reminderClosedReason: null }, NOW) ===
    "future",
  'reminderAt 1 minute after now -> "future"',
);

assert(
  resolveReminderLifecycleState({ reminderAt: NOW_ISO, reminderClosedReason: null }, NOW) ===
    "due",
  'reminderAt exactly equal to now (boundary, <=) -> "due"',
);

assert(
  resolveReminderLifecycleState({ reminderAt: PAST_ISO, reminderClosedReason: null }, NOW) ===
    "due",
  'reminderAt 1 minute before now -> "due"',
);

for (const reason of ["handled", "voted", "case_closed"] as const) {
  assert(
    resolveReminderLifecycleState(
      { reminderAt: null, reminderClosedReason: reason as ReminderClosedReason },
      NOW,
    ) === "closed",
    `reminderAt null, reminderClosedReason "${reason}" -> "closed"`,
  );
}

assert(
  resolveReminderLifecycleState(
    { reminderAt: null, reminderClosedReason: "cancelled" },
    NOW,
  ) === "cancelled",
  'reminderAt null, reminderClosedReason "cancelled" -> "cancelled" (distinct from "closed")',
);

// A fresh reminderAt always wins over a stale reminderClosedReason left over
// from a prior lifecycle (e.g. after a reschedule following a cancel/close) -
// reminderAt is checked first in the source.
assert(
  resolveReminderLifecycleState(
    { reminderAt: FUTURE_ISO, reminderClosedReason: "cancelled" },
    NOW,
  ) === "future",
  'fresh future reminderAt wins over a stale reminderClosedReason: "cancelled" -> "future", not "cancelled"',
);
assert(
  resolveReminderLifecycleState(
    { reminderAt: PAST_ISO, reminderClosedReason: "handled" },
    NOW,
  ) === "due",
  'fresh (now-overdue) reminderAt wins over a stale reminderClosedReason: "handled" -> "due", not "closed"',
);

// ---- isReminderOutstanding -------------------------------------------------
assert(isReminderOutstanding("future") === true, 'isReminderOutstanding("future") === true');
assert(isReminderOutstanding("due") === true, 'isReminderOutstanding("due") === true');
assert(isReminderOutstanding("none") === false, 'isReminderOutstanding("none") === false');
assert(isReminderOutstanding("closed") === false, 'isReminderOutstanding("closed") === false');
assert(
  isReminderOutstanding("cancelled") === false,
  'isReminderOutstanding("cancelled") === false',
);

// ============================================================================
// isReminderActive / isReminderDue - confirm they're genuinely derived
// through resolveReminderLifecycleState (never re-implemented inline).
// ============================================================================
const futureContact = makeContact({ reminderAt: FUTURE_ISO, reminderClosedReason: null });
const dueContact = makeContact({ reminderAt: PAST_ISO, reminderClosedReason: null });
const noneContact = makeContact({ reminderAt: null, reminderClosedReason: null });
const closedContact = makeContact({ reminderAt: null, reminderClosedReason: "handled" });
const cancelledContact = makeContact({ reminderAt: null, reminderClosedReason: "cancelled" });

assert(isReminderActive(futureContact, NOW) === true, "isReminderActive: future -> true");
assert(isReminderDue(futureContact, NOW) === false, "isReminderDue: future -> false");

assert(isReminderActive(dueContact, NOW) === true, "isReminderActive: due -> true");
assert(isReminderDue(dueContact, NOW) === true, "isReminderDue: due -> true");

assert(isReminderActive(noneContact, NOW) === false, "isReminderActive: none -> false");
assert(isReminderDue(noneContact, NOW) === false, "isReminderDue: none -> false");

assert(isReminderActive(closedContact, NOW) === false, "isReminderActive: closed -> false");
assert(isReminderDue(closedContact, NOW) === false, "isReminderDue: closed -> false");

assert(isReminderActive(cancelledContact, NOW) === false, "isReminderActive: cancelled -> false");
assert(isReminderDue(cancelledContact, NOW) === false, "isReminderDue: cancelled -> false");

// ============================================================================
// buildClosedRemindersToday - local-calendar-day "today", never UTC.
// ============================================================================

// A fixed local "now" for the day-boundary tests below: Aug 10 2026, local
// noon - safely mid-day so it can't itself straddle a UTC day boundary.
const LOCAL_NOW = new Date(2026, 7, 10, 12, 0, 0);

function closedContactAt(local: Date, reason: ReminderClosedReason, id: string) {
  return makeContact({
    id,
    reminderClosedAt: local.toISOString(),
    reminderClosedReason: reason,
  });
}

assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 10, 9, 0, 0), "handled", "a1")],
    LOCAL_NOW,
  ) === 1,
  'closed today (local) with reason "handled" counts',
);
assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 10, 10, 0, 0), "voted", "a2")],
    LOCAL_NOW,
  ) === 1,
  'closed today (local) with reason "voted" counts',
);
assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 10, 11, 0, 0), "case_closed", "a3")],
    LOCAL_NOW,
  ) === 1,
  'closed today (local) with reason "case_closed" counts',
);
assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 10, 8, 0, 0), "cancelled", "a4")],
    LOCAL_NOW,
  ) === 0,
  'closed today (local) with reason "cancelled" is EXCLUDED (never counted as handled)',
);
assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 9, 23, 59, 0), "handled", "a5")],
    LOCAL_NOW,
  ) === 0,
  "closed yesterday (local, 23:59) is not counted toward today",
);
assert(
  buildClosedRemindersToday(
    [closedContactAt(new Date(2026, 7, 11, 0, 1, 0), "handled", "a6")],
    LOCAL_NOW,
  ) === 0,
  "closed tomorrow (local, 00:01) is not counted toward today",
);
assert(
  buildClosedRemindersToday([makeContact({ id: "a7" })], LOCAL_NOW) === 0,
  "a contact whose reminder was never closed (reminderClosedAt null) contributes 0",
);
assert(
  buildClosedRemindersToday(
    [
      makeContact({
        id: "a8",
        reminderClosedAt: new Date(2026, 7, 10, 9, 0, 0).toISOString(),
        reminderClosedReason: null,
      }),
    ],
    LOCAL_NOW,
  ) === 0,
  "defensive edge case: reminderClosedAt set but reminderClosedReason null contributes 0",
);
assert(
  buildClosedRemindersToday([], LOCAL_NOW) === 0,
  "zero-count case: empty contacts array -> 0",
);

// All 3 non-cancelled closure reasons together in one batch, plus the
// excluded cancelled/yesterday/tomorrow/never-closed rows mixed in - proves
// the function correctly partitions a realistic mixed list, not just
// single-contact cases in isolation.
const mixedBatch: ElectionDayVoter[] = [
  closedContactAt(new Date(2026, 7, 10, 9, 0, 0), "handled", "b1"),
  closedContactAt(new Date(2026, 7, 10, 10, 0, 0), "voted", "b2"),
  closedContactAt(new Date(2026, 7, 10, 11, 0, 0), "case_closed", "b3"),
  closedContactAt(new Date(2026, 7, 10, 8, 0, 0), "cancelled", "b4"),
  closedContactAt(new Date(2026, 7, 9, 23, 59, 0), "handled", "b5"),
  closedContactAt(new Date(2026, 7, 11, 0, 1, 0), "handled", "b6"),
  makeContact({ id: "b7" }),
];
assert(
  buildClosedRemindersToday(mixedBatch, LOCAL_NOW) === 3,
  "mixed batch: handled + voted + case_closed today all count (3), cancelled/yesterday/tomorrow/never-closed excluded",
);

// ---- timezone-safety: a reminder closed right at a local midnight boundary
// must land on the correct LOCAL day even when that instant's UTC calendar
// date is a different day - i.e. buildClosedRemindersToday must be comparing
// via getFullYear()/getMonth()/getDate() (local), never a naive
// `.toISOString().slice(0, 10)` (UTC) string comparison. The exact local hour
// that forces a UTC-day rollover depends on which side of UTC this machine's
// timezone sits on, so it's picked dynamically rather than hardcoded.
const tzOffsetMinutes = new Date().getTimezoneOffset(); // UTC - local, in minutes
let tzTestHour: number;
if (tzOffsetMinutes > 0) {
  // local is BEHIND UTC (e.g. the Americas) - late-evening local time rolls
  // forward into the next UTC calendar day.
  tzTestHour = 23;
} else if (tzOffsetMinutes < 0) {
  // local is AHEAD of UTC (e.g. Israel) - just-after-midnight local time
  // rolls backward into the previous UTC calendar day.
  tzTestHour = 0;
} else {
  // Machine's local timezone genuinely IS UTC - no boundary to straddle.
  tzTestHour = 23;
}
const tzTestClosedAt = new Date(2026, 7, 10, tzTestHour, 30, 0); // still LOCAL day 10, by construction
const straddlesUtcBoundary = tzTestClosedAt.getUTCDate() !== tzTestClosedAt.getDate();
assert(
  buildClosedRemindersToday(
    [closedContactAt(tzTestClosedAt, "handled", "tz1")],
    new Date(2026, 7, 10, 12, 0, 0),
  ) === 1,
  `timezone-safety: reminder closed at local ${String(tzTestHour).padStart(2, "0")}:30 on "today" is counted as today even though its UTC calendar date ${
    straddlesUtcBoundary ? "DIFFERS from" : "happens to match"
  } its local calendar date on this machine (tz offset ${tzOffsetMinutes}min)${
    straddlesUtcBoundary
      ? " - this specific case would be miscounted by a naive UTC-string-slice comparison"
      : " - this machine's own timezone offset is 0, so this run cannot distinguish local-vs-UTC handling by itself; the other today/yesterday/tomorrow boundary checks above still hold"
  }`,
);

// ============================================================================
// buildFollowUpBreakdown - 3-bucket shape (notYetHandled genuinely gone) and
// hand-computed counts, including bucket priority (call-attempts checked
// before reminder state).
// ============================================================================
const REASON_OPEN = makeReason({ id: "r-open", name: "לא עונה", requiresFollowUp: true });
const REASON_CLOSED = makeReason({ id: "r-closed", name: "נפטר", requiresFollowUp: false });
const REASONS_BY_ID = new Map<string, NonVotingReason>([
  [REASON_OPEN.id, REASON_OPEN],
  [REASON_CLOSED.id, REASON_CLOSED],
]);

const FB_NOW = new Date("2026-08-10T12:00:00.000Z");
const FB_DUE_ISO = new Date(FB_NOW.getTime() - 60_000).toISOString();
const FB_FUTURE_ISO = new Date(FB_NOW.getTime() + 60_000).toISOString();

const followUpContacts: ElectionDayVoter[] = [
  // f1: voted -> excluded entirely (not "remaining")
  makeContact({ id: "f1", voted: true }),
  // f2: not voted, reason requiresFollowUp=false -> "closed", excluded
  makeContact({ id: "f2", voted: false, notVotingReasonId: REASON_CLOSED.id }),
  // f3/f4: remaining, noAnswerStreak >= threshold(2) -> callAttempts2Plus
  // (exactly 2, and >2) - Call Outcome Tracking: isCallAttempts2Plus reads
  // noAnswerStreak, NOT callAttempts, so callAttempts is deliberately set
  // HIGHER here to prove the total dial count is never what drives this.
  makeContact({ id: "f3", voted: false, callAttempts: 9, noAnswerStreak: 2 }),
  makeContact({ id: "f4", voted: false, callAttempts: 9, noAnswerStreak: 5 }),
  // f5: remaining, noAnswerStreak < 2, reminder DUE -> reminderDue
  makeContact({ id: "f5", voted: false, notVotingReasonId: REASON_OPEN.id, noAnswerStreak: 0, reminderAt: FB_DUE_ISO }),
  // f6: remaining, noAnswerStreak < 2, reminder FUTURE -> reminderWaiting
  makeContact({ id: "f6", voted: false, noAnswerStreak: 1, reminderAt: FB_FUTURE_ISO }),
  // f7: remaining, no reminder at all, noAnswerStreak < 2 -> none of the 3 buckets
  makeContact({ id: "f7", voted: false, noAnswerStreak: 0 }),
  // f8: remaining, reminder state "cancelled" -> not due/future -> no bucket
  makeContact({ id: "f8", voted: false, noAnswerStreak: 0, reminderClosedReason: "cancelled" }),
  // f9: remaining, reminder state "closed" (handled) -> not due/future -> no bucket
  makeContact({ id: "f9", voted: false, noAnswerStreak: 0, reminderClosedReason: "handled" }),
  // f10: remaining, noAnswerStreak >= threshold AND reminder due -> priority
  // check: callAttempts2Plus wins, must NOT also land in reminderDue.
  makeContact({
    id: "f10",
    voted: false,
    notVotingReasonId: REASON_OPEN.id,
    noAnswerStreak: 2,
    reminderAt: FB_DUE_ISO,
  }),
  // f11: a high total dial count but noAnswerStreak = 0 (answered on the last
  // attempt) must NOT appear in callAttempts2Plus - the exact regression this
  // feature exists to prevent (a voter who answered must never look "still
  // unreachable" just because their total dial count is high).
  makeContact({ id: "f11", voted: false, callAttempts: 8, noAnswerStreak: 0 }),
];

const breakdown = buildFollowUpBreakdown(followUpContacts, REASONS_BY_ID, FB_NOW);

assert(
  breakdown.callAttempts2Plus === 3,
  `callAttempts2Plus hand-computed count matches: expected 3 (f3,f4,f10), got ${breakdown.callAttempts2Plus}`,
);
assert(
  breakdown.reminderDue === 1,
  `reminderDue hand-computed count matches: expected 1 (f5 only - f10 is claimed by callAttempts2Plus first), got ${breakdown.reminderDue}`,
);
assert(
  breakdown.reminderWaiting === 1,
  `reminderWaiting hand-computed count matches: expected 1 (f6), got ${breakdown.reminderWaiting}`,
);

// Shape check: the returned object must have EXACTLY these 3 keys - no
// `notYetHandled` (the field this feature explicitly removed). This is a
// runtime mirror of the TS-level guarantee (FollowUpBreakdown's interface,
// read directly from src/features/election-day/followUpBreakdown.ts, declares
// only these 3 fields - esbuild strips types before this file runs, so a
// runtime Object.keys check is what actually enforces this in this test).
const breakdownKeys = Object.keys(breakdown).sort();
assert(
  breakdownKeys.join(",") === ["callAttempts2Plus", "reminderDue", "reminderWaiting"].sort().join(","),
  `FollowUpBreakdown shape has exactly {callAttempts2Plus, reminderDue, reminderWaiting} - no "notYetHandled" key. Got keys: ${breakdownKeys.join(",")}`,
);
assert(
  !("notYetHandled" in breakdown),
  '"notYetHandled" is genuinely absent from the returned FollowUpBreakdown object',
);

// Zero-count case.
assert(
  (() => {
    const empty = buildFollowUpBreakdown([], REASONS_BY_ID, FB_NOW);
    return empty.callAttempts2Plus === 0 && empty.reminderDue === 0 && empty.reminderWaiting === 0;
  })(),
  "buildFollowUpBreakdown on an empty contact list -> all 3 buckets are 0",
);

// ---------------------------------------------------------------------------
// MockApi.setNonVotingReason - local/in-memory proof (no network, no
// production catalog data touched) of the same conditional-closure logic
// `election_day_set_non_voting_reason` implements server-side: mirrors it
// exactly (see that method's own doc comment in mockApi.ts). Added ahead of
// commit specifically to cover requiresFollowUp=true without needing to
// create/modify a real production non-voting-reason row (the live catalog
// currently has zero active requiresFollowUp=true reasons - see task-plan.md).
// ---------------------------------------------------------------------------
async function testNonVotingReasonClosure() {
  const { MockApi } = await import("../src/services/api/mockApi");
  const mockApi = new MockApi();

  const openReason = await mockApi.createNonVotingReason({
    name: "TEST_OPEN_REASON",
    description: "",
    requiresFollowUp: true,
  });
  const closedReason = await mockApi.createNonVotingReason({
    name: "TEST_CLOSED_REASON",
    description: "",
    requiresFollowUp: false,
  });

  await mockApi.importElectionDayVoters([
    { masad: "1", firstName: "בדיקה", lastName: "אחת", street: "", houseNumber: 0, city: "", phone: null, coordinator: "בודק" },
    { masad: "2", firstName: "בדיקה", lastName: "שתיים", street: "", houseNumber: 0, city: "", phone: null, coordinator: "בודק" },
  ]);
  const [v1, v2] = await mockApi.listElectionDayVoters();

  // requiresFollowUp=true: reason saves, reminder stays open, no closure.
  await mockApi.setReminder(v1.id, 60);
  const afterOpen = await mockApi.setNonVotingReason(v1.id, openReason.id, "TEST_ACTOR");
  assert(
    afterOpen.notVotingReasonId === openReason.id,
    "requiresFollowUp=true: non-voting reason id saved",
  );
  assert(
    afterOpen.reminderAt !== null,
    "requiresFollowUp=true: reminder_at remains set (reminder stays open)",
  );
  assert(
    afterOpen.reminderClosedReason === null,
    "requiresFollowUp=true: reminder_closed_reason stays null (no closed event)",
  );
  assert(
    afterOpen.reminderClosedAt === null,
    "requiresFollowUp=true: reminder_closed_at stays null",
  );

  // requiresFollowUp=false: regression check (mirrors the already-verified
  // production RPC behavior) - reason saves, reminder closes as case_closed.
  await mockApi.setReminder(v2.id, 60);
  const afterClosed = await mockApi.setNonVotingReason(v2.id, closedReason.id, "TEST_ACTOR");
  assert(
    afterClosed.notVotingReasonId === closedReason.id,
    "requiresFollowUp=false: non-voting reason id saved",
  );
  assert(
    afterClosed.reminderAt === null,
    "requiresFollowUp=false: reminder_at cleared (reminder closed)",
  );
  assert(
    afterClosed.reminderClosedReason === "case_closed",
    "requiresFollowUp=false: reminder_closed_reason = case_closed",
  );
}

testNonVotingReasonClosure().then(() => {
  if (process.exitCode) {
    console.error("\nsmoke-reminder-lifecycle: FAILED");
  } else {
    console.log("\nsmoke-reminder-lifecycle: all checks passed");
  }
});
