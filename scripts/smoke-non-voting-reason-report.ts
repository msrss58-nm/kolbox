/** Coordinator Worklist (requiresFollowUp) - `buildNonVotingReasonReport`
 * pure-logic smoke test. Run via: npx esbuild scripts/smoke-non-voting-reason-report.ts --bundle --format=cjs --outfile=scripts/smoke-non-voting-reason-report.cjs && node scripts/smoke-non-voting-reason-report.cjs
 *
 * `buildNonVotingReasonReport` (`src/features/election-day/
 * nonVotingReasonReport.ts`) feeds the new "סיבות אי-הצבעה" report card and
 * its reason -> coordinator -> voter drill-down modal. It counts EVERY
 * contact with a matching `notVotingReasonId` regardless of `voted` - the
 * same inclusive precedent already established by `NonVotingReasonsModal.
 * tsx`'s `usageCount` (`contacts.filter((c) => c.notVotingReasonId ===
 * reasonId).length`, no `voted` filter) - a voted contact showing up in a
 * report row is correct/intended, not a bug.
 */
import { buildNonVotingReasonReport } from "../src/features/election-day/nonVotingReasonReport";
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

const REASON_A = makeReason({ id: "r-a", name: "לא עונה" });
const REASON_B = makeReason({ id: "r-b", name: "נפטר", requiresFollowUp: false });
const REASON_UNUSED = makeReason({ id: "r-unused", name: "עבר דירה" });

// ---- a reason with 0 matching contacts is excluded entirely -------------
{
  const contacts = [
    makeContact({ id: "1", notVotingReasonId: REASON_A.id }),
    makeContact({ id: "2", notVotingReasonId: null }),
  ];
  const report = buildNonVotingReasonReport(contacts, [REASON_A, REASON_UNUSED]);
  assert(
    report.length === 1 && report[0].reasonId === REASON_A.id,
    "a reason with 0 matching contacts (REASON_UNUSED) is excluded entirely from the result",
  );
}

// ---- a reason with only voted contacts still appears with the correct ----
// total - counts regardless of voted (same as NonVotingReasonsModal's
// usageCount precedent: no voted filter at all).
{
  const contacts = [
    makeContact({ id: "1", voted: true, notVotingReasonId: REASON_A.id }),
    makeContact({ id: "2", voted: true, notVotingReasonId: REASON_A.id }),
  ];
  const report = buildNonVotingReasonReport(contacts, [REASON_A]);
  assert(
    report.length === 1 && report[0].total === 2,
    "a reason whose only matching contacts are all voted:true still appears, total=2 (counts regardless of voted, mirrors usageCount's precedent - not a bug)",
  );
}

// ---- coordinator grouping: same coordinator collapses into one row, -----
// empty-string coordinator is distinct and preserved, not merged/dropped --
{
  const contacts = [
    makeContact({ id: "1", coordinator: "אבי", notVotingReasonId: REASON_A.id }),
    makeContact({ id: "2", coordinator: "אבי", notVotingReasonId: REASON_A.id }),
    makeContact({ id: "3", coordinator: "אבי", notVotingReasonId: REASON_A.id }),
    makeContact({ id: "4", coordinator: "בני", notVotingReasonId: REASON_A.id }),
    makeContact({ id: "5", coordinator: "", notVotingReasonId: REASON_A.id }),
  ];
  const report = buildNonVotingReasonReport(contacts, [REASON_A]);
  const row = report[0];
  assert(row.total === 5, `coordinator grouping: total across all coordinators is 5, got ${row.total}`);
  assert(
    row.byCoordinator.length === 3,
    `coordinator grouping: 3 distinct coordinator groups ("אבי"/"בני"/""), got ${row.byCoordinator.length}`,
  );
  const aviRow = row.byCoordinator.find((r) => r.coordinator === "אבי");
  const bniRow = row.byCoordinator.find((r) => r.coordinator === "בני");
  const emptyRow = row.byCoordinator.find((r) => r.coordinator === "");
  assert(aviRow?.count === 3, `"אבי" collapses into one row with count=3, got ${aviRow?.count}`);
  assert(bniRow?.count === 1, `"בני" collapses into one row with count=1, got ${bniRow?.count}`);
  assert(
    emptyRow !== undefined && emptyRow.count === 1,
    'coordinator:"" produces its own distinct row (count=1), not merged with anything and not dropped',
  );

  // ---- byCoordinator sorted descending by count --------------------------
  assert(
    row.byCoordinator.every((r, i) => i === 0 || row.byCoordinator[i - 1].count >= r.count),
    "byCoordinator is sorted descending by count",
  );
  assert(
    row.byCoordinator[0].coordinator === "אבי",
    'byCoordinator: the highest-count group ("אבי", count=3) sorts first',
  );
}

// ---- top-level result sorted descending by total -------------------------
{
  const contacts = [
    // REASON_A: 1 matching contact
    makeContact({ id: "1", notVotingReasonId: REASON_A.id }),
    // REASON_B: 3 matching contacts
    makeContact({ id: "2", notVotingReasonId: REASON_B.id }),
    makeContact({ id: "3", notVotingReasonId: REASON_B.id }),
    makeContact({ id: "4", notVotingReasonId: REASON_B.id }),
  ];
  const report = buildNonVotingReasonReport(contacts, [REASON_A, REASON_B]);
  assert(report.length === 2, `both reasons with >0 matches appear, got ${report.length}`);
  assert(
    report[0].reasonId === REASON_B.id && report[0].total === 3,
    "top-level result sorted descending by total: REASON_B (total=3) sorts first",
  );
  assert(
    report[1].reasonId === REASON_A.id && report[1].total === 1,
    "top-level result sorted descending by total: REASON_A (total=1) sorts second",
  );
}

// ---- every contact matching a reason appears in that row's voters array -
// (length matches total, exact contact ids present)
{
  const contactMatchA1 = makeContact({ id: "match-1", notVotingReasonId: REASON_A.id });
  const contactMatchA2 = makeContact({ id: "match-2", notVotingReasonId: REASON_A.id });
  const contactNoMatch = makeContact({ id: "no-match", notVotingReasonId: REASON_B.id });
  const contacts = [contactMatchA1, contactMatchA2, contactNoMatch];
  const report = buildNonVotingReasonReport(contacts, [REASON_A, REASON_B]);
  const rowA = report.find((r) => r.reasonId === REASON_A.id);
  assert(rowA !== undefined, "REASON_A's row is present in the result");
  assert(
    rowA?.voters.length === rowA?.total,
    `rowA.voters.length (${rowA?.voters.length}) matches rowA.total (${rowA?.total})`,
  );
  const voterIds = rowA?.voters.map((v) => v.id) ?? [];
  assert(
    voterIds.includes("match-1") && voterIds.includes("match-2"),
    "every contact matching REASON_A (match-1, match-2) appears by id in rowA.voters",
  );
  assert(
    !voterIds.includes("no-match"),
    "a contact matching a different reason (REASON_B) does NOT leak into REASON_A's voters array",
  );
}

if (process.exitCode) {
  console.error("\nsmoke-non-voting-reason-report: FAILED");
} else {
  console.log("\nsmoke-non-voting-reason-report: all checks passed");
}
