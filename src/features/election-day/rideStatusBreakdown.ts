import type { ElectionDayVoter } from "../../types";

export interface RideStatusBreakdown {
  needsRide: number;
  arranged: number;
  completed: number;
}

/**
 * Dashboard row 4 ("הסעות"): the 3-stage ride pipeline count, mirroring
 * `useElectionDay.ts`'s own `ridePipelineStage` stages - a contact only ever
 * counts once, in its most-advanced stage (never double-counted across
 * buckets). Reads `scopedContacts` directly (not `rideCoordinationQueue`,
 * which excludes already-voted contacts) so `completed` reflects every ride
 * that happened today, even after the voter went on to vote.
 */
export function buildRideStatusBreakdown(
  contacts: readonly ElectionDayVoter[],
): RideStatusBreakdown {
  const breakdown: RideStatusBreakdown = { needsRide: 0, arranged: 0, completed: 0 };

  for (const c of contacts) {
    if (c.rideCompleted) breakdown.completed++;
    else if (c.rideArranged) breakdown.arranged++;
    else if (c.rideRequested) breakdown.needsRide++;
  }

  return breakdown;
}
