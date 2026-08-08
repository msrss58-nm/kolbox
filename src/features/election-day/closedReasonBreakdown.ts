import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { resolveFollowUpStatus } from "./followUpStatus";

export interface ClosedReasonBreakdownRow {
  reasonId: string;
  reasonName: string;
  count: number;
}

/**
 * Dashboard KPI row 2 breakdown: how many of the coordinator worklist's
 * "closed" contacts (see `followUpStatus.ts`) fall under each reason. Reads
 * every count through `resolveFollowUpStatus` - never re-derives "closed"
 * itself - so this can never drift from `ElectionDayStats.closed`'s own
 * definition. A reason whose `requiresFollowUp` is `true` can never produce
 * a "closed" contact and is skipped without being counted. A reason with 0
 * closed contacts is omitted entirely from the result - callers must not
 * synthesize a zero tile for it.
 */
export function buildClosedReasonBreakdown(
  contacts: readonly ElectionDayVoter[],
  reasons: readonly NonVotingReason[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
): ClosedReasonBreakdownRow[] {
  const orderedReasons = [...reasons]
    .filter((r) => !r.requiresFollowUp)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const rows: ClosedReasonBreakdownRow[] = [];
  for (const reason of orderedReasons) {
    let count = 0;
    for (const c of contacts) {
      if (
        c.notVotingReasonId === reason.id &&
        resolveFollowUpStatus(c, reasonsById) === "closed"
      ) {
        count++;
      }
    }
    if (count > 0) rows.push({ reasonId: reason.id, reasonName: reason.name, count });
  }
  return rows;
}
