import type { Coordinator, ElectionDayVoter, NonVotingReason } from "../../types";
import { resolveFollowUpStatus } from "./followUpStatus";

/**
 * Coordinator Allocation Management: pure display/preview selectors over the
 * already-fetched `Coordinator[]`/`ElectionDayVoter[]` lists - server RPCs
 * (`election_day_apply_initial_allocation`/`rebalance_assignments`/
 * `end_coordinator_activity`) always revalidate real DB state before any
 * mutation, so these functions must never be treated as authoritative for a
 * write decision, only for what a screen shows before/after one.
 */

export interface CoordinatorAllocationStats {
  coordinatorId: string;
  displayName: string;
  status: Coordinator["status"];
  /** Count of voters owned by this coordinator entity (see
   * `isVoterOwnedByCoordinator`), regardless of follow-up status. */
  totalAssigned: number;
  /** Of `totalAssigned`, how many are still "remaining" per
   * `resolveFollowUpStatus` - the same definition the coordinator worklist
   * itself uses (`useElectionDay.ts`'s `stats.remaining`), never a stricter
   * local predicate re-implemented here. */
  remainingCount: number;
}

/**
 * True when `voter` is owned by `coordinator`'s entity - matched by
 * `displayName` OR (if linked) `linkedAssignmentName`. When both names are
 * equal (same-row equality, allowed by the cross-column ownership invariant
 * enforced server-side in `election_day_manage_coordinators`), this still
 * counts a voter once, never twice - callers must not sum a displayName
 * match and a linkedAssignmentName match separately.
 */
export function isVoterOwnedByCoordinator(
  voter: ElectionDayVoter,
  coordinator: Coordinator,
): boolean {
  return (
    voter.coordinator === coordinator.displayName ||
    (coordinator.linkedAssignmentName !== null &&
      voter.coordinator === coordinator.linkedAssignmentName)
  );
}

/**
 * `""` is this app's locked sentinel for "not yet assigned to any
 * coordinator" (see `ElectionDayVoter.coordinator`'s own comment - the DB
 * column is nullable, `SupabaseElectionDayApi`'s `toVoter` coerces `null` to
 * `""` at the read boundary). This selector must never be widened to accept
 * `string | null` - that boundary is locked for V1.
 */
export function isUnassignedVoter(voter: ElectionDayVoter): boolean {
  return voter.coordinator === "";
}

export function countUnassignedVoters(voters: readonly ElectionDayVoter[]): number {
  return voters.filter(isUnassignedVoter).length;
}

/**
 * Per-coordinator `totalAssigned`/`remainingCount`, one row per entry in
 * `coordinators`, in the given order. Reads eligibility through
 * `resolveFollowUpStatus` exclusively - never re-implements "remaining"
 * locally - so this can never drift from the coordinator worklist's own
 * definition of the same concept.
 */
export function buildCoordinatorAllocationStats(
  coordinators: readonly Coordinator[],
  voters: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
): CoordinatorAllocationStats[] {
  return coordinators.map((coordinator) => {
    let totalAssigned = 0;
    let remainingCount = 0;
    for (const voter of voters) {
      if (!isVoterOwnedByCoordinator(voter, coordinator)) continue;
      totalAssigned++;
      if (resolveFollowUpStatus(voter, reasonsById) === "remaining") remainingCount++;
    }
    return {
      coordinatorId: coordinator.id,
      displayName: coordinator.displayName,
      status: coordinator.status,
      totalAssigned,
      remainingCount,
    };
  });
}

/**
 * Existing-Excel-assignment preview helper (locked design - see the Phase 4
 * spec's "EXISTING EXCEL ASSIGNMENTS" section): exact, case-sensitive string
 * match only against the raw `voter.coordinator` free-text column - no
 * fuzzy/normalized matching, no automatic linking. A future "ניהול הקצאות"
 * screen may use this to preview "נמצאו N בוחרים שכבר משויכים ל'...'" before
 * a manager explicitly links a coordinator entity to that exact string via
 * `manageCoordinators`'s `link`/`relink` action - this function itself never
 * links anything.
 */
export function countVotersWithRawCoordinatorName(
  voters: readonly ElectionDayVoter[],
  rawCoordinatorName: string,
): number {
  return voters.filter((v) => v.coordinator === rawCoordinatorName).length;
}

/**
 * Coordinator Allocation auto-preload (product decision, 2026-08-20):
 * `voter.coordinator` - the free-text "אחראי" column set at Excel import
 * time - is the authoritative, pre-existing source of who's already
 * responsible for whom. Returns every distinct, non-empty, trimmed raw name
 * not yet represented by any existing coordinator entity, in either its
 * `displayName` or its `linkedAssignmentName`, across every status (not just
 * `"active"` - a name already used by an ended coordinator is still "already
 * represented", not a fresh candidate), in first-seen order.
 *
 * Deliberately does not touch `linkedAssignmentName` itself - the DB
 * migration's "never auto-matched" comment is scoped to that column alone,
 * for explicit-only Excel-assignment linking. A newly-seeded coordinator
 * whose `displayName` equals the raw string already satisfies
 * `isVoterOwnedByCoordinator`'s own `displayName` branch with no link
 * needed, so this stays a plain "add", never an auto-link.
 */
export function resolveMissingCoordinatorNames(
  coordinators: readonly Coordinator[],
  voters: readonly ElectionDayVoter[],
): string[] {
  const existingNames = new Set<string>();
  for (const c of coordinators) {
    existingNames.add(c.displayName);
    if (c.linkedAssignmentName !== null) existingNames.add(c.linkedAssignmentName);
  }
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const voter of voters) {
    const name = voter.coordinator.trim();
    if (!name || existingNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}
