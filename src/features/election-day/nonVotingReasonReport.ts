import type { ElectionDayVoter, NonVotingReason } from "../../types";

/** One coordinator's contact count for a given reason. `coordinator === ""`
 * represents "no coordinator on this contact" - this module doesn't decide
 * how to label that; that's a UI concern. */
export interface NonVotingReasonReportCoordinatorRow {
  coordinator: string;
  count: number;
}

/** One reason's full report row: total usage plus a per-coordinator
 * breakdown and the underlying voter list. */
export interface NonVotingReasonReportRow {
  reasonId: string;
  reasonName: string;
  total: number;
  /** Sorted by count desc. */
  byCoordinator: NonVotingReasonReportCoordinatorRow[];
  voters: ElectionDayVoter[];
}

/**
 * Builds a per-reason usage report across all contacts.
 *
 * - Iterates reasons in the catalog's own `sortOrder`.
 * - Counts every contact whose `notVotingReasonId === reason.id`,
 *   **regardless of `voted`** - matches the existing `usageCount` convention
 *   already used by `NonVotingReasonsModal.tsx`: a reason is kept for
 *   history/reports even after the voter later votes, by product decision.
 *   This function does not filter by `voted` and must not start doing so.
 * - Groups matching voters by `contact.coordinator` exactly as given
 *   (including `""`), producing `byCoordinator` sorted by count desc.
 * - Reasons with `total === 0` are excluded entirely from the result - a
 *   report row for a reason nobody currently has is just noise.
 * - The final array is sorted by `total` desc.
 */
export function buildNonVotingReasonReport(
  contacts: readonly ElectionDayVoter[],
  reasons: readonly NonVotingReason[],
): NonVotingReasonReportRow[] {
  const orderedReasons = [...reasons].sort((a, b) => a.sortOrder - b.sortOrder);

  const rows: NonVotingReasonReportRow[] = [];

  for (const reason of orderedReasons) {
    const voters = contacts.filter((c) => c.notVotingReasonId === reason.id);
    if (voters.length === 0) continue;

    const countByCoordinator = new Map<string, number>();
    for (const voter of voters) {
      countByCoordinator.set(
        voter.coordinator,
        (countByCoordinator.get(voter.coordinator) ?? 0) + 1,
      );
    }

    const byCoordinator: NonVotingReasonReportCoordinatorRow[] = Array.from(
      countByCoordinator.entries(),
      ([coordinator, count]) => ({ coordinator, count }),
    ).sort((a, b) => b.count - a.count);

    rows.push({
      reasonId: reason.id,
      reasonName: reason.name,
      total: voters.length,
      byCoordinator,
      voters,
    });
  }

  return rows.sort((a, b) => b.total - a.total);
}
