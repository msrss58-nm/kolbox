export type CoordinatorAllocationPhase = "setup" | "live";

/**
 * Coordinator Allocation Management (Phase 5): the ONLY signal that decides
 * whether the screen shows the one-time setup flow or the day-of live
 * management view. Locked rule (found to be wrong once, see the Phase 5 UI
 * hardening pass that introduced this file - the previous version used "any
 * coordinator's totalAssigned > 0" as an activity signal, which broke the
 * moment a coordinator was linked to a handful of pre-existing Excel
 * assignments while hundreds of voters were still genuinely unassigned):
 *
 * - `unassignedCount > 0` -> always "setup", regardless of how many
 *   coordinators exist or whether any of them already owns voters via a
 *   direct/linked Excel match. There is still a real Initial Allocation
 *   decision to make for the remaining unassigned voters.
 * - `unassignedCount === 0` and at least one coordinator exists -> "live".
 *   Nothing is left to distribute, so Initial Allocation is meaningless;
 *   day-of management (rebalance/end) is the only thing left to offer.
 * - `unassignedCount === 0` and zero coordinators exist -> "setup" (not
 *   "live" with an empty roster) - the manager still needs to define
 *   today's coordinators before there's anything to manage.
 *
 * Deliberately takes only these two numbers - never a coordinator's
 * `totalAssigned`/`remainingCount`, and never a separately-persisted
 * "setup complete" flag that could drift out of sync with real data.
 */
export function resolveCoordinatorAllocationPhase(
  unassignedCount: number,
  coordinatorCount: number,
): CoordinatorAllocationPhase {
  if (unassignedCount > 0) return "setup";
  return coordinatorCount > 0 ? "live" : "setup";
}
