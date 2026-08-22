import type { Coordinator, ElectionDayVoter } from "../../types";
import { resolveReminderLifecycleState } from "./reminderLifecycle";

/** One coordinator's worth of currently-DUE reminders - the manager
 * dashboard's "תזכורות לטיפול" section source list. `voters` is sorted
 * oldest-reminderAt-first (same ordering convention as
 * `resolveOverdueReminderPopups`), so `voters[0]` is always "the oldest". */
export interface CoordinatorReminderSupervisionRow {
  coordinator: string;
  dueCount: number;
  oldestReminderAt: string;
  voters: ElectionDayVoter[];
}

/** Manager Dashboard Reminders ("תזכורות לטיפול"): one row per coordinator
 * that currently has at least one DUE reminder - reuses
 * `resolveReminderLifecycleState`'s existing `"due"` state, the same single
 * source of truth `resolveOverdueReminderPopups` (the personal popup stack)
 * already reads through, so "due" never gets a second definition. Purely
 * derived from already-fetched contacts - no new fetch, no new RPC. A
 * coordinator with zero due reminders never appears (nothing to supervise).
 * Rows are sorted by their own oldest-due-reminder first, so the most
 * urgent coordinator surfaces first. */
export function buildCoordinatorReminderSupervision(
  contacts: readonly ElectionDayVoter[],
  now: Date = new Date(),
): CoordinatorReminderSupervisionRow[] {
  const byCoordinator = new Map<string, ElectionDayVoter[]>();
  for (const c of contacts) {
    if (resolveReminderLifecycleState(c, now) !== "due") continue;
    const list = byCoordinator.get(c.coordinator) ?? [];
    list.push(c);
    byCoordinator.set(c.coordinator, list);
  }

  const rows = [...byCoordinator.entries()].map(([coordinator, voters]) => {
    const sorted = [...voters].sort(
      // `reminderAt` is guaranteed non-null here - `resolveReminderLifecycleState`
      // only returns "due" when it is.
      (a, b) => Date.parse(a.reminderAt as string) - Date.parse(b.reminderAt as string),
    );
    return {
      coordinator,
      dueCount: sorted.length,
      oldestReminderAt: sorted[0].reminderAt as string,
      voters: sorted,
    };
  });

  return rows.sort((a, b) => Date.parse(a.oldestReminderAt) - Date.parse(b.oldestReminderAt));
}

/** Resolves a reminder-group's raw coordinator name string to its phone,
 * matching against `displayName` OR `linkedAssignmentName` - the same
 * two-name identity match `coordinatorAllocationStats.ts`/the safe-edit-
 * remove RPC use elsewhere. Deliberately conservative: returns `null` (no
 * call action) unless the name resolves to EXACTLY one coordinator row, so
 * an ambiguous/unmatched name never guesses at a phone that might belong to
 * a different coordinator. */
export function resolveCoordinatorPhoneForReminderRow(
  coordinators: readonly Coordinator[],
  coordinatorName: string,
): string | null {
  const matches = coordinators.filter(
    (c) => c.displayName === coordinatorName || c.linkedAssignmentName === coordinatorName,
  );
  return matches.length === 1 ? matches[0].phone : null;
}
