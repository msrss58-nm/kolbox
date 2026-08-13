/** Coordinator Allocation Management - Phase 4 (frontend data layer)
 * pure-logic coverage.
 *
 * Run via: npx esbuild scripts/smoke-coordinator-allocation.ts --bundle --format=cjs --outfile=scripts/smoke-coordinator-allocation.cjs && node scripts/smoke-coordinator-allocation.cjs
 *
 * Covers, in order:
 * 1. Ownership (`isVoterOwnedByCoordinator`) - displayName match,
 *    linkedAssignmentName match, same-name-on-both no double-count.
 * 2. Unassigned (`isUnassignedVoter`/`countUnassignedVoters`) - the locked
 *    `coordinator === ""` sentinel.
 * 3. Per-coordinator stats (`buildCoordinatorAllocationStats`) - reads
 *    "remaining" through the real `resolveFollowUpStatus`, never a local
 *    re-implementation, on a small hand-computed example.
 * 4. Existing-Excel-assignment preview helper
 *    (`countVotersWithRawCoordinatorName`) - exact string match only.
 * 5. Permission default: `electionDay.manageCoordinatorAllocation` behaves
 *    correctly through the real permission engine (`computePermissions`)
 *    against synthetic roles - NOT against `BUILT_IN_ROLE_SEED`, since that
 *    fixture is frozen to the Phase 0 migration's literal text and
 *    deliberately does NOT grant this permission to any built-in role (see
 *    `builtInRoleSeed.ts`'s comment) - asserting `can(MANAGER, ...) ===
 *    true` against it would be a false expectation, not a real check.
 *    Separately pins down that today's real seed does NOT grant it to
 *    manager/operations/voting, documenting the known Phase 4 gap.
 * 6. The REAL `mapCoordinatorAllocationRpcErrorMessage` - imported directly
 *    from `src/services/api/coordinatorAllocationMapping.ts`, not a pinned
 *    copy. That module is deliberately dependency-free (no import of the
 *    Supabase client), specifically so this test can exercise the actual
 *    production function - if it changes, this test either catches the
 *    change or needs updating, it can never silently pass against stale
 *    logic (unlike `smoke-role-management-logic.ts`'s `mapRoleRpcErrorMessage`,
 *    which stays pinned because that codepath still lives inline in
 *    `supabaseElectionDayApi.ts`, a genuinely Supabase-client-adjacent
 *    module - not the pattern followed here).
 * 7. Payload translation - the REAL `toCoordinatorActionPayload`/
 *    `toAllocationAssignmentPayload`, same import, same reasoning as #6.
 * 8. Phase 5: the REAL `computeEqualSplit` (initial-allocation "חלוקה שווה"
 *    preview + end-of-day "equal split" preview) - deterministic
 *    floor+remainder distribution against the Phase 5 spec's own worked
 *    examples (10/3, 3/5, 0/n) plus order-sensitivity and edge cases.
 * 9. Phase 5 UI hardening: the REAL `resolveCoordinatorAllocationPhase` -
 *    the locked setup/live transition rule (`unassignedCount` is the only
 *    signal, never a coordinator's `totalAssigned`) against the exact
 *    6-case matrix from the hardening spec.
 * 10. Phase 5 UI hardening: the REAL validation helpers from
 *     `coordinatorAllocationValidation.ts` - `isValidQuantityRaw`,
 *     `manualAllocationStatus`, `validateRebalance`,
 *     `isEndBlockedByLastActive`, `isValidEndTransferTarget` - the exact
 *     functions the Setup/Rebalance/End components now consume, not pinned
 *     copies.
 */
import { computePermissions } from "../src/permissions/computePermissions";
import type { Permission, RoleRecord } from "../src/permissions/types";
import { ALL_PERMISSIONS } from "../src/permissions/permissionsMap";
import {
  buildCoordinatorAllocationStats,
  countUnassignedVoters,
  countVotersWithRawCoordinatorName,
  isUnassignedVoter,
  isVoterOwnedByCoordinator,
} from "../src/features/election-day/coordinatorAllocationStats";
import { computeEqualSplit } from "../src/features/election-day/coordinatorAllocationEqualSplit";
import { resolveCoordinatorAllocationPhase } from "../src/features/election-day/coordinatorAllocationPhase";
import {
  isEndBlockedByLastActive,
  isValidEndTransferTarget,
  isValidQuantityRaw,
  manualAllocationStatus,
  validateRebalance,
} from "../src/features/election-day/coordinatorAllocationValidation";
import {
  mapCoordinatorAllocationRpcErrorMessage,
  toAllocationAssignmentPayload,
  toCoordinatorActionPayload,
} from "../src/services/api/coordinatorAllocationMapping";
import type { Coordinator, ElectionDayVoter, NonVotingReason } from "../src/types";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

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
    coordinator: "",
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
    ...overrides,
  };
}

function makeCoordinator(overrides: Partial<Coordinator> = {}): Coordinator {
  return {
    id: "coord-1",
    displayName: "אבי",
    status: "active",
    linkedAssignmentName: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    endedAt: null,
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
// 1. ownership
// ============================================================================
const coordAvi = makeCoordinator({ id: "coord-avi", displayName: "אבי" });
assert(
  isVoterOwnedByCoordinator(makeContact({ coordinator: "אבי" }), coordAvi) === true,
  "ownership: displayName match -> owned",
);
assert(
  isVoterOwnedByCoordinator(makeContact({ coordinator: "משה" }), coordAvi) === false,
  "ownership: no match -> not owned",
);

const coordLinked = makeCoordinator({
  id: "coord-linked",
  displayName: "רכז חדש",
  linkedAssignmentName: "שם ישן מאקסל",
});
assert(
  isVoterOwnedByCoordinator(
    makeContact({ coordinator: "שם ישן מאקסל" }),
    coordLinked,
  ) === true,
  "ownership: linkedAssignmentName match -> owned",
);
assert(
  isVoterOwnedByCoordinator(makeContact({ coordinator: "רכז חדש" }), coordLinked) ===
    true,
  "ownership: displayName still matches even when linked to a different string",
);

// Same-row equality (displayName === linkedAssignmentName, allowed by the
// cross-column invariant) must not double-count a single voter.
const coordSameName = makeCoordinator({
  id: "coord-same",
  displayName: "דנה",
  linkedAssignmentName: "דנה",
});
const statsSameName = buildCoordinatorAllocationStats(
  [coordSameName],
  [makeContact({ id: "v-1", coordinator: "דנה" })],
  new Map(),
);
assert(
  statsSameName[0].totalAssigned === 1,
  `ownership: displayName === linkedAssignmentName counts a matching voter once, not twice (got ${statsSameName[0].totalAssigned})`,
);

// ============================================================================
// 2. unassigned
// ============================================================================
assert(
  isUnassignedVoter(makeContact({ coordinator: "" })) === true,
  'unassigned: coordinator === "" -> unassigned',
);
assert(
  isUnassignedVoter(makeContact({ coordinator: "אבי" })) === false,
  "unassigned: a coordinator string present -> not unassigned",
);
const mixedVoters = [
  makeContact({ id: "v-1", coordinator: "" }),
  makeContact({ id: "v-2", coordinator: "" }),
  makeContact({ id: "v-3", coordinator: "אבי" }),
];
assert(
  countUnassignedVoters(mixedVoters) === 2,
  `unassigned: countUnassignedVoters counts exactly the "" rows (expected 2, got ${countUnassignedVoters(mixedVoters)})`,
);

// ============================================================================
// 3. per-coordinator stats - remaining reads through the real
// resolveFollowUpStatus, never a local re-implementation
// ============================================================================
const REASON_CLOSED = makeReason({ id: "r-closed", requiresFollowUp: false });
const REASON_OPEN = makeReason({ id: "r-open", requiresFollowUp: true });
const reasonsById = new Map<string, NonVotingReason>([
  [REASON_CLOSED.id, REASON_CLOSED],
  [REASON_OPEN.id, REASON_OPEN],
]);

const statsCoordinator = makeCoordinator({ id: "coord-stats", displayName: "רכז" });
const statsVoters = [
  makeContact({ id: "s-1", coordinator: "רכז", voted: true }), // voted, not remaining
  makeContact({ id: "s-2", coordinator: "רכז", voted: false, notVotingReasonId: REASON_CLOSED.id }), // closed, not remaining
  makeContact({ id: "s-3", coordinator: "רכז", voted: false, notVotingReasonId: REASON_OPEN.id }), // remaining
  makeContact({ id: "s-4", coordinator: "רכז", voted: false, notVotingReasonId: null }), // remaining
  makeContact({ id: "s-5", coordinator: "אחר", voted: false }), // different coordinator - not owned
];
const [statsRow] = buildCoordinatorAllocationStats(
  [statsCoordinator],
  statsVoters,
  reasonsById,
);
assert(
  statsRow.totalAssigned === 4,
  `stats: totalAssigned counts only this coordinator's own voters (expected 4, got ${statsRow.totalAssigned})`,
);
assert(
  statsRow.remainingCount === 2,
  `stats: remainingCount matches resolveFollowUpStatus's "remaining" bucket exactly (expected 2, got ${statsRow.remainingCount})`,
);
assert(
  statsRow.coordinatorId === "coord-stats" && statsRow.displayName === "רכז",
  "stats: row carries the coordinator's own id/displayName",
);

// ============================================================================
// 4. existing-Excel-assignment preview helper - exact string match only
// ============================================================================
const rawMatchVoters = [
  makeContact({ id: "e-1", coordinator: "משה כהן" }),
  makeContact({ id: "e-2", coordinator: "משה כהן" }),
  makeContact({ id: "e-3", coordinator: "משה  כהן" }), // extra space - NOT a match
  makeContact({ id: "e-4", coordinator: "" }),
];
assert(
  countVotersWithRawCoordinatorName(rawMatchVoters, "משה כהן") === 2,
  "raw-match: exact string match only, counts exactly the identical rows",
);
assert(
  countVotersWithRawCoordinatorName(rawMatchVoters, "לא קיים") === 0,
  "raw-match: a name with zero matches returns 0",
);

// ============================================================================
// 5. permission default - electionDay.manageCoordinatorAllocation
// ============================================================================
assert(
  ALL_PERMISSIONS.includes("electionDay.manageCoordinatorAllocation"),
  "permission catalog: electionDay.manageCoordinatorAllocation is a recognized permission",
);

const ROLE_WITH: RoleRecord = {
  id: "role-with",
  name: "עם הרשאה",
  description: "",
  permissions: ["electionDay.manageCoordinatorAllocation"],
  scopeType: "all",
  scopeValue: null,
};
const ROLE_WITHOUT: RoleRecord = {
  id: "role-without",
  name: "בלי הרשאה",
  description: "",
  permissions: [],
  scopeType: "all",
  scopeValue: null,
};
const SYNTHETIC_ROLES = [ROLE_WITH, ROLE_WITHOUT];
const PERMISSION: Permission = "electionDay.manageCoordinatorAllocation";

const COORDINATOR_ALLOCATION_MUTATIONS = [
  "manageCoordinators",
  "applyInitialAllocation",
  "rebalanceAssignments",
  "endCoordinatorActivity",
] as const;

for (const mutation of COORDINATOR_ALLOCATION_MUTATIONS) {
  assert(
    computePermissions("role-with", "loaded", SYNTHETIC_ROLES).can(PERMISSION) === true,
    `${mutation}: a role holding the permission is allowed (synthetic fixture)`,
  );
  assert(
    computePermissions("role-without", "loaded", SYNTHETIC_ROLES).can(PERMISSION) ===
      false,
    `${mutation}: a role NOT holding the permission is denied`,
  );
  assert(
    computePermissions(null, "loaded", SYNTHETIC_ROLES).can(PERMISSION) === false,
    `${mutation}: no session is denied`,
  );
}

// fail-closed: catalog not loaded denies regardless of role
for (const status of ["idle", "loading", "error"] as const) {
  assert(
    computePermissions("role-with", status, SYNTHETIC_ROLES).can(PERMISSION) === false,
    `catalogStatus="${status}": denied even for a role that would otherwise hold the permission (fail-closed, no fallback)`,
  );
}

// Documents the known Phase 4 gap (see builtInRoleSeed.ts's comment and this
// phase's own report): today's REAL built-in seed does NOT grant this
// permission to manager/operations/voting - a DB backfill migration is
// required before any real Production role actually holds it. This
// assertion is expected to keep passing until that migration ships and the
// seed/fixture are updated together.
for (const roleId of ["seed-manager", "seed-user", "seed-voting"]) {
  assert(
    computePermissions(roleId, "loaded", BUILT_IN_ROLE_SEED).can(PERMISSION) === false,
    `known gap: today's real built-in seed does not grant electionDay.manageCoordinatorAllocation to "${roleId}" (requires a future backfill migration, not created in Phase 4)`,
  );
}

// ============================================================================
// 6. the REAL mapCoordinatorAllocationRpcErrorMessage (imported, not pinned
// - see this file's header comment). Covers every stable code raised by all
// 4 RPCs, copied from the committed migrations.
// ============================================================================
const ERROR_CODE_EXPECTATIONS: [string, string][] = [
  ["UNAUTHORIZED", "הסיסמה שהזנת אינה נכונה"],
  ["FORBIDDEN", "אין לך הרשאה לבצע פעולה זו"],
  ["NO_ACTIONS", "לא נשלחו פעולות לביצוע"],
  ["INVALID_COORDINATOR_NAME", "יש להזין שם תקין לרכז"],
  ["COORDINATOR_NOT_FOUND", "הרכז לא נמצא - ייתכן שנמחק על ידי משתמש אחר"],
  ["DISPLAY_NAME_LOCKED", "לא ניתן לשנות את שם הרכז לאחר שהחלה פעילות הקצאות"],
  ["ASSIGNMENT_ALREADY_LINKED", "המחרוזת המקושרת כבר משויכת לרכז אחר"],
  ["COORDINATOR_LOCKED", "לא ניתן לבצע פעולה זו על רכז שכבר השתתף בפעילות הקצאות"],
  ["COORDINATOR_NAME_COLLISION", "השם מתנגש עם רכז אחר קיים"],
  ["INVALID_LINK", "נתוני הקישור אינם תקינים"],
  ["INVALID_ACTION", "פעולה לא מוכרת"],
  ["INVALID_ASSIGNMENT_SHAPE", "נתוני ההקצאה אינם תקינים"],
  ["NEGATIVE_QUANTITY", "לא ניתן להזין כמות שלילית"],
  ["NON_POSITIVE_QUANTITY", "יש להזין כמות גדולה מאפס"],
  ["DUPLICATE_COORDINATOR_IN_ASSIGNMENTS", "לא ניתן לבחור אותו רכז יותר מפעם אחת"],
  ["DUPLICATE_COORDINATOR_IN_SOURCES", "לא ניתן לבחור אותו רכז יותר מפעם אחת"],
  ["DUPLICATE_COORDINATOR_IN_DESTINATIONS", "לא ניתן לבחור אותו רכז יותר מפעם אחת"],
  ["NO_MEANINGFUL_ASSIGNMENT", "יש להזין הקצאה בפועל לפחות לרכז אחד"],
  ["COORDINATOR_NOT_ACTIVE", "לא ניתן להקצות לרכז שאינו פעיל"],
  ["NO_UNASSIGNED_VOTERS", "אין בוחרים לא-מוקצים כרגע"],
  [
    "ALLOCATION_COUNT_MISMATCH",
    "כמות ההקצאה אינה תואמת את מספר הבוחרים הלא-מוקצים בפועל - רעננו ונסו שוב",
  ],
  ["SOURCE_DESTINATION_OVERLAP", "לא ניתן לבחור אותו רכז גם כמקור וגם כיעד"],
  ["REBALANCE_SUM_MISMATCH", "סכום הכמויות במקור וביעד אינו תואם"],
  [
    "REBALANCE_SOURCE_INSUFFICIENT",
    "אין מספיק בוחרים זמינים אצל הרכז המקור - רעננו ונסו שוב",
  ],
  ["INVALID_MODE", "סוג הפעולה אינו תקין"],
  ["INVALID_TARGET", "יש לבחור רכז יעד תקין, שאינו הרכז המסיים עצמו"],
  ["TARGET_NOT_FOUND", "רכז היעד לא נמצא - ייתכן שנמחק על ידי משתמש אחר"],
  ["TARGET_NOT_ACTIVE", "רכז היעד אינו פעיל"],
  [
    "LAST_ACTIVE_COORDINATOR",
    "לא ניתן לסיים את פעילות הרכז האחרון הפעיל כל עוד יש לו בוחרים שנותרו לטיפול",
  ],
];

for (const [code, expected] of ERROR_CODE_EXPECTATIONS) {
  assert(
    mapCoordinatorAllocationRpcErrorMessage(code) === expected,
    `error mapper (real implementation): ${code} maps to a clear Hebrew message`,
  );
}
assert(
  mapCoordinatorAllocationRpcErrorMessage("some unrelated raw Postgres error") ===
    "some unrelated raw Postgres error",
  "error mapper (real implementation): an unrecognized message passes through unchanged (never swallowed)",
);

// ============================================================================
// 7. payload translation - the REAL toCoordinatorActionPayload/
// toAllocationAssignmentPayload (imported, not pinned)
// ============================================================================
const addPayload = toCoordinatorActionPayload({ action: "add", displayName: "רכז חדש" });
assert(
  addPayload.action === "add" &&
    addPayload.display_name === "רכז חדש" &&
    addPayload.coordinator_id === null &&
    addPayload.linked_assignment_name === null,
  "payload translation (real implementation): 'add' action -> exact snake_case keys, unset fields become null (never undefined/omitted)",
);

const linkPayload = toCoordinatorActionPayload({
  action: "link",
  coordinatorId: "coord-1",
  linkedAssignmentName: "שם מאקסל",
});
assert(
  linkPayload.coordinator_id === "coord-1" &&
    linkPayload.linked_assignment_name === "שם מאקסל" &&
    linkPayload.display_name === null,
  "payload translation (real implementation): 'link' action -> coordinator_id/linked_assignment_name populated, display_name null",
);

const assignmentPayload = toAllocationAssignmentPayload({
  coordinatorId: "coord-9",
  quantity: 12,
});
assert(
  Object.keys(assignmentPayload).length === 2 &&
    assignmentPayload.coordinator_id === "coord-9" &&
    assignmentPayload.quantity === 12,
  "payload translation (real implementation): AllocationAssignment -> exactly {coordinator_id, quantity} snake_case shape",
);

// ============================================================================
// 8. Phase 5: the REAL computeEqualSplit
// ============================================================================
const split10of3 = computeEqualSplit(10, ["a", "b", "c"]);
assert(
  split10of3.get("a") === 4 && split10of3.get("b") === 3 && split10of3.get("c") === 3,
  `equal split: 10/3 -> 4,3,3 in order (got ${split10of3.get("a")},${split10of3.get("b")},${split10of3.get("c")})`,
);

const split3of5 = computeEqualSplit(3, ["a", "b", "c", "d", "e"]);
assert(
  split3of5.get("a") === 1 &&
    split3of5.get("b") === 1 &&
    split3of5.get("c") === 1 &&
    split3of5.get("d") === 0 &&
    split3of5.get("e") === 0,
  "equal split: 3/5 -> 1,1,1,0,0 (remainder goes to the first entries in order)",
);

const splitZero = computeEqualSplit(0, ["a", "b", "c"]);
assert(
  [...splitZero.values()].every((q) => q === 0),
  "equal split: 0 total -> every coordinator gets 0",
);

const splitNoCoordinators = computeEqualSplit(10, []);
assert(
  splitNoCoordinators.size === 0,
  "equal split: 0 coordinators -> empty result, no division by zero",
);

const splitEven = computeEqualSplit(9, ["a", "b", "c"]);
assert(
  splitEven.get("a") === 3 && splitEven.get("b") === 3 && splitEven.get("c") === 3,
  "equal split: evenly divisible total -> no remainder distribution needed",
);

// Order-sensitivity: the same total/coordinator-set in a different order
// must move the remainder with the order, not with a fixed id.
const splitReordered = computeEqualSplit(10, ["c", "b", "a"]);
assert(
  splitReordered.get("c") === 4 &&
    splitReordered.get("b") === 3 &&
    splitReordered.get("a") === 3,
  "equal split: the remainder follows the given order, not a fixed coordinator identity",
);

const totalPreserved = [...split10of3.values()].reduce((sum, q) => sum + q, 0);
assert(
  totalPreserved === 10,
  `equal split: the sum of all quantities always equals the requested total (got ${totalPreserved})`,
);

// ============================================================================
// 9. Phase 5 UI hardening: the REAL resolveCoordinatorAllocationPhase -
// exact 6-case matrix from the hardening spec. totalAssigned/coordinator
// ownership never enters this function's signature at all - the cases
// below prove that by construction, not by inspection.
// ============================================================================
assert(
  resolveCoordinatorAllocationPhase(100, 0) === "setup",
  "phase: case 1 - 0 coordinators + 100 unassigned -> setup",
);
assert(
  resolveCoordinatorAllocationPhase(100, 1) === "setup",
  "phase: case 2 - 1 coordinator + 100 unassigned + 0 assigned -> setup",
);
assert(
  resolveCoordinatorAllocationPhase(1230, 1) === "setup",
  "phase: case 3 - 1 coordinator linked to 4 Excel-assigned + 1230 unassigned -> setup (totalAssigned>0 must NOT flip this)",
);
assert(
  resolveCoordinatorAllocationPhase(1, 3) === "setup",
  "phase: case 4 - several coordinators + some existing Excel assignments + >=1 unassigned -> setup",
);
assert(
  resolveCoordinatorAllocationPhase(0, 3) === "live",
  "phase: case 5 - coordinators exist + unassigned=0 -> live",
);
assert(
  resolveCoordinatorAllocationPhase(0, 0) === "setup",
  "phase: case 6 - 0 coordinators + unassigned=0 -> setup (roster definition, not an empty live view)",
);

// ============================================================================
// 10. Phase 5 UI hardening: the REAL validation helpers
// ============================================================================

// isValidQuantityRaw - the exact keystroke filter every quantity field uses
assert(isValidQuantityRaw("") === true, "quantity raw: empty string is valid (not yet entered)");
assert(isValidQuantityRaw("0") === true, "quantity raw: '0' is valid");
assert(isValidQuantityRaw("42") === true, "quantity raw: a plain positive integer is valid");
assert(isValidQuantityRaw("-5") === false, "quantity raw: negative is blocked");
assert(isValidQuantityRaw("3.5") === false, "quantity raw: decimal is blocked");
assert(isValidQuantityRaw("12a") === false, "quantity raw: any non-digit character is blocked");

// manualAllocationStatus - exact/under/over
assert(
  manualAllocationStatus(1230, 1230) === "exact",
  "manual allocation: exact total -> valid",
);
assert(
  manualAllocationStatus(1000, 1230) === "under",
  "manual allocation: under total -> invalid (under)",
);
assert(
  manualAllocationStatus(1300, 1230) === "over",
  "manual allocation: over total -> invalid (over)",
);

// validateRebalance
const remainingByCoord = { avi: 30, dana: 10 };
assert(
  validateRebalance(
    [
      { coordinatorId: "avi", quantity: 20, remaining: remainingByCoord.avi },
      { coordinatorId: "dana", quantity: 10, remaining: remainingByCoord.dana },
    ],
    [
      { coordinatorId: "yossi", quantity: 12 },
      { coordinatorId: "eli", quantity: 18 },
    ],
  ).valid === true,
  "rebalance: multi-source/multi-destination, equal totals (30=30) -> valid",
);

const mismatchResult = validateRebalance(
  [{ coordinatorId: "avi", quantity: 20, remaining: 30 }],
  [{ coordinatorId: "yossi", quantity: 12 }],
);
assert(
  !mismatchResult.valid && mismatchResult.reason === "MISMATCH",
  "rebalance: source total != destination total -> invalid (MISMATCH)",
);

const exceedsResult = validateRebalance(
  [{ coordinatorId: "avi", quantity: 20, remaining: 10 }],
  [{ coordinatorId: "yossi", quantity: 20 }],
);
assert(
  !exceedsResult.valid && exceedsResult.reason === "SOURCE_EXCEEDS_REMAINING",
  "rebalance: source quantity (20) > its own remaining (10) -> invalid (SOURCE_EXCEEDS_REMAINING)",
);

const sameCoordinatorResult = validateRebalance(
  [{ coordinatorId: "avi", quantity: 10, remaining: 30 }],
  [{ coordinatorId: "avi", quantity: 10 }],
);
assert(
  !sameCoordinatorResult.valid && sameCoordinatorResult.reason === "SAME_COORDINATOR",
  "rebalance: the same coordinator on both sides -> invalid (SAME_COORDINATOR)",
);

const noSourceResult = validateRebalance(
  [{ coordinatorId: "avi", quantity: 0, remaining: 30 }],
  [{ coordinatorId: "yossi", quantity: 10 }],
);
assert(
  !noSourceResult.valid && noSourceResult.reason === "NO_SOURCE",
  "rebalance: no source with quantity>0 -> invalid (NO_SOURCE)",
);

const noDestinationResult = validateRebalance(
  [{ coordinatorId: "avi", quantity: 10, remaining: 30 }],
  [{ coordinatorId: "yossi", quantity: 0 }],
);
assert(
  !noDestinationResult.valid && noDestinationResult.reason === "NO_DESTINATION",
  "rebalance: no destination with quantity>0 -> invalid (NO_DESTINATION)",
);

// isEndBlockedByLastActive / isValidEndTransferTarget
assert(
  isEndBlockedByLastActive(31, 0) === true,
  "end: last active coordinator + remaining>0 -> blocked",
);
assert(
  isEndBlockedByLastActive(0, 0) === false,
  "end: last active coordinator + remaining=0 -> allowed",
);
assert(
  isEndBlockedByLastActive(31, 2) === false,
  "end: remaining>0 but other active coordinators exist -> not blocked",
);
assert(
  isValidEndTransferTarget("coord-yossi", "coord-rooti") === true,
  "end: a real, different target coordinator -> valid",
);
assert(
  isValidEndTransferTarget("coord-rooti", "coord-rooti") === false,
  "end: transfer target cannot equal the coordinator being ended (source)",
);
assert(
  isValidEndTransferTarget(null, "coord-rooti") === false,
  "end: no target chosen -> invalid",
);

if (process.exitCode) {
  console.error("\nsmoke-coordinator-allocation: FAILED");
} else {
  console.log("\nsmoke-coordinator-allocation: all checks passed");
}
