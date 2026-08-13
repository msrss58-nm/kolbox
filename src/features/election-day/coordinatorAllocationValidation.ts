/**
 * Coordinator Allocation Management (Phase 5): pure validation helpers
 * shared by the setup manual-distribution step, the rebalance dialog, and
 * the end-coordinator dialog - extracted so the components and their tests
 * consume the exact same logic (no pinned/re-implemented copies inside
 * tests, no drift between what the UI enforces and what's actually tested).
 */

/**
 * A quantity input keystroke is valid only if it's empty or a plain
 * non-negative integer string - blocks negative numbers and decimals at
 * the character level. Shared by every quantity field in this feature
 * (manual initial-allocation, rebalance sources/destinations).
 */
export function isValidQuantityRaw(raw: string): boolean {
  return /^\d*$/.test(raw);
}

/** `""` (nothing typed yet) parses to `0`, matching every quantity field's
 * "empty means not entered yet, not invalid" treatment. */
export function parseQuantityRaw(raw: string): number {
  return raw === "" ? 0 : Number(raw);
}

export type ManualAllocationStatus = "exact" | "under" | "over";

/** Whether a manual initial-allocation's current total exactly matches,
 * falls short of, or exceeds `targetTotal` (`unassignedCount`) - only
 * `"exact"` may proceed to Preview. */
export function manualAllocationStatus(
  assignedTotal: number,
  targetTotal: number,
): ManualAllocationStatus {
  if (assignedTotal === targetTotal) return "exact";
  return assignedTotal < targetTotal ? "under" : "over";
}

export interface RebalanceSourceEntry {
  coordinatorId: string;
  quantity: number;
  /** The coordinator's current `remainingCount` - a source may never move
   * more than this. */
  remaining: number;
}

export interface RebalanceDestinationEntry {
  coordinatorId: string;
  quantity: number;
}

export type RebalanceValidationReason =
  | "NO_SOURCE"
  | "NO_DESTINATION"
  | "SAME_COORDINATOR"
  | "SOURCE_EXCEEDS_REMAINING"
  | "MISMATCH";

export type RebalanceValidation =
  | { valid: true }
  | { valid: false; reason: RebalanceValidationReason };

/**
 * Validates one proposed rebalance - only entries with `quantity > 0` count
 * as "selected" on either side (a `0` row is simply not part of the
 * transfer, not an error by itself). Checked in a fixed order so a caller
 * showing only the first failure reason gets a stable, predictable result:
 * no source selected -> no destination selected -> same coordinator on both
 * sides -> a source exceeding its own remaining count -> total mismatch.
 */
export function validateRebalance(
  sources: readonly RebalanceSourceEntry[],
  destinations: readonly RebalanceDestinationEntry[],
): RebalanceValidation {
  const selectedSources = sources.filter((s) => s.quantity > 0);
  const selectedDestinations = destinations.filter((d) => d.quantity > 0);

  if (selectedSources.length === 0) return { valid: false, reason: "NO_SOURCE" };
  if (selectedDestinations.length === 0)
    return { valid: false, reason: "NO_DESTINATION" };

  const sourceIds = new Set(selectedSources.map((s) => s.coordinatorId));
  if (selectedDestinations.some((d) => sourceIds.has(d.coordinatorId))) {
    return { valid: false, reason: "SAME_COORDINATOR" };
  }

  if (selectedSources.some((s) => s.quantity > s.remaining)) {
    return { valid: false, reason: "SOURCE_EXCEEDS_REMAINING" };
  }

  const sourceTotal = selectedSources.reduce((sum, s) => sum + s.quantity, 0);
  const destinationTotal = selectedDestinations.reduce((sum, d) => sum + d.quantity, 0);
  if (sourceTotal !== destinationTotal) return { valid: false, reason: "MISMATCH" };

  return { valid: true };
}

/**
 * The `LAST_ACTIVE_COORDINATOR` client-side mirror: ending a coordinator's
 * activity is blocked only when they still have voters remaining AND there
 * is no other active coordinator left to receive them (by either end mode).
 * `remaining === 0` is always allowed, even as the last active coordinator.
 */
export function isEndBlockedByLastActive(
  remaining: number,
  otherActiveCount: number,
): boolean {
  return remaining > 0 && otherActiveCount === 0;
}

/** A transfer target must be chosen and must not be the coordinator being
 * ended themselves. */
export function isValidEndTransferTarget(
  targetId: string | null,
  coordinatorId: string,
): boolean {
  return targetId !== null && targetId !== coordinatorId;
}
