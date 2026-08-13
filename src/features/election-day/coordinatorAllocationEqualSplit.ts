/**
 * Coordinator Allocation Management (Phase 5): the "חלוקה שווה" preview
 * calculation shared by initial allocation (splitting `unassignedCount`
 * across active coordinators) and the "end coordinator activity" equal-split
 * mode (splitting one coordinator's `remainingCount` across the OTHER active
 * coordinators). Client-side preview only - the server RPCs
 * (`election_day_apply_initial_allocation`/`end_coordinator_activity`)
 * always recount/revalidate real DB state, this function is never
 * authoritative for a write decision.
 *
 * Deterministic: `base = floor(total / n)`, the remainder is distributed one
 * extra unit at a time to entries in the given order (not re-sorted) -
 * `coordinatorIds` must already be in the same stable order the caller reads
 * elsewhere (`useCoordinatorAllocation`'s `activeCoordinators`), so a preview
 * and its later submission never disagree on who gets the remainder.
 */
export function computeEqualSplit(
  total: number,
  coordinatorIds: readonly string[],
): Map<string, number> {
  const result = new Map<string, number>();
  const n = coordinatorIds.length;
  if (n === 0) return result;

  const base = Math.floor(total / n);
  const remainder = total % n;
  coordinatorIds.forEach((id, index) => {
    result.set(id, base + (index < remainder ? 1 : 0));
  });
  return result;
}
