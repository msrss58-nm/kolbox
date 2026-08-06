/** Coordinator Worklist (requiresFollowUp) - `resolveFollowUpStatus` pure-logic
 * smoke test. Run via: npx esbuild scripts/smoke-follow-up-status.ts --bundle --format=cjs --outfile=scripts/smoke-follow-up-status.cjs && node scripts/smoke-follow-up-status.cjs
 *
 * `resolveFollowUpStatus` (`src/features/election-day/followUpStatus.ts`) is
 * the single derivation point for a contact's worklist bucket - "voted" /
 * "closed" / "remaining" - driving the new "הוקצו = הצביעו + נסגרו + נותרו
 * לטיפול" counters and the report card's drill-down. `voted` always wins
 * over any stored reason (the reason is historical only, never re-derives a
 * voted contact's bucket); a stale/deleted `notVotingReasonId` must fail
 * safe to "remaining", never throw.
 */
import { resolveFollowUpStatus } from "../src/features/election-day/followUpStatus";
import type { ElectionDayVoter, NonVotingReason } from "../src/types";

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
    voted: false,
    votedAt: null,
    notVotingReasonId: null,
    notVotingReasonSetAt: null,
    notVotingReasonSetBy: null,
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

const REASON_OPEN = makeReason({
  id: "r-open",
  name: "לא עונה",
  requiresFollowUp: true,
});
const REASON_CLOSED = makeReason({
  id: "r-closed",
  name: "נפטר",
  requiresFollowUp: false,
});
const REASONS_BY_ID = new Map<string, NonVotingReason>([
  [REASON_OPEN.id, REASON_OPEN],
  [REASON_CLOSED.id, REASON_CLOSED],
]);

// ---- voted, no reason -> "voted" -----------------------------------------
assert(
  resolveFollowUpStatus(makeContact({ voted: true, notVotingReasonId: null }), REASONS_BY_ID) ===
    "voted",
  'voted contact with no reason -> "voted"',
);

// ---- voted WITH a reason attached (either kind) -> still "voted" --------
// (voted always wins - the reason is historical only, never re-derives status)
assert(
  resolveFollowUpStatus(
    makeContact({ voted: true, notVotingReasonId: REASON_OPEN.id }),
    REASONS_BY_ID,
  ) === "voted",
  'voted contact with a requiresFollowUp=true reason attached -> still "voted" (reason is historical only)',
);
assert(
  resolveFollowUpStatus(
    makeContact({ voted: true, notVotingReasonId: REASON_CLOSED.id }),
    REASONS_BY_ID,
  ) === "voted",
  'voted contact with a requiresFollowUp=false reason attached -> still "voted" (reason is historical only)',
);

// ---- not voted, no reason at all -> "remaining" --------------------------
assert(
  resolveFollowUpStatus(
    makeContact({ voted: false, notVotingReasonId: null }),
    REASONS_BY_ID,
  ) === "remaining",
  'not-voted contact with no reason at all -> "remaining"',
);

// ---- not voted, reason with requiresFollowUp: true -> "remaining" -------
assert(
  resolveFollowUpStatus(
    makeContact({ voted: false, notVotingReasonId: REASON_OPEN.id }),
    REASONS_BY_ID,
  ) === "remaining",
  'not-voted contact with a requiresFollowUp=true reason ("לא עונה") -> "remaining"',
);

// ---- not voted, reason with requiresFollowUp: false -> "closed" ---------
assert(
  resolveFollowUpStatus(
    makeContact({ voted: false, notVotingReasonId: REASON_CLOSED.id }),
    REASONS_BY_ID,
  ) === "closed",
  'not-voted contact with a requiresFollowUp=false reason ("נפטר") -> "closed"',
);

// ---- not voted, notVotingReasonId points at a stale/deleted reason ------
// (not present in reasonsById) -> "remaining" (fail-safe, never throws)
assert(
  resolveFollowUpStatus(
    makeContact({ voted: false, notVotingReasonId: "reason-that-no-longer-exists" }),
    REASONS_BY_ID,
  ) === "remaining",
  'not-voted contact whose notVotingReasonId is stale/deleted (not in reasonsById) -> "remaining" (fail-safe, never throws)',
);

// ---- un-voting reverts a previously-voted/previously-closed contact -----
// back to "closed" - proves status is purely derived every call, never
// cached/stale from an earlier "voted" evaluation.
const votedClosedContact = makeContact({
  voted: true,
  notVotingReasonId: REASON_CLOSED.id,
});
assert(
  resolveFollowUpStatus(votedClosedContact, REASONS_BY_ID) === "voted",
  "sanity check: the voted+closed-reason contact starts out as \"voted\"",
);
const unvotedContact = { ...votedClosedContact, voted: false };
assert(
  resolveFollowUpStatus(unvotedContact, REASONS_BY_ID) === "closed",
  'un-voting a previously-voted, previously-closed contact (same reason still attached, voted flips to false) -> reverts to "closed" (purely derived, never cached/stale)',
);

// ---- end-to-end counters formula on a small synthetic list --------------
// "הוקצו = הצביעו + נסגרו + נותרו לטיפול"
const worklist: ElectionDayVoter[] = [
  makeContact({ id: "w1", voted: true, notVotingReasonId: null }), // voted
  makeContact({ id: "w2", voted: true, notVotingReasonId: REASON_OPEN.id }), // voted (reason historical)
  makeContact({ id: "w3", voted: false, notVotingReasonId: REASON_CLOSED.id }), // closed
  makeContact({ id: "w4", voted: false, notVotingReasonId: REASON_CLOSED.id }), // closed
  makeContact({ id: "w5", voted: false, notVotingReasonId: REASON_OPEN.id }), // remaining
  makeContact({ id: "w6", voted: false, notVotingReasonId: null }), // remaining
  makeContact({ id: "w7", voted: false, notVotingReasonId: "stale-deleted-id" }), // remaining (fail-safe)
];
const statuses = worklist.map((c) => resolveFollowUpStatus(c, REASONS_BY_ID));
const votedCount = statuses.filter((s) => s === "voted").length;
const closedCount = statuses.filter((s) => s === "closed").length;
const remainingCount = statuses.filter((s) => s === "remaining").length;

assert(votedCount === 2, `hand-computed voted count matches: expected 2, got ${votedCount}`);
assert(closedCount === 2, `hand-computed closed count matches: expected 2, got ${closedCount}`);
assert(
  remainingCount === 3,
  `hand-computed remaining count matches: expected 3, got ${remainingCount}`,
);
assert(
  votedCount + closedCount + remainingCount === worklist.length,
  '"הוקצו = הצביעו + נסגרו + נותרו לטיפול" formula holds: voted + closed + remaining === total assigned',
);

if (process.exitCode) {
  console.error("\nsmoke-follow-up-status: FAILED");
} else {
  console.log("\nsmoke-follow-up-status: all checks passed");
}
