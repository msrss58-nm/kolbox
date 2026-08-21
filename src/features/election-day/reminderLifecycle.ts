import type { ElectionDayVoter } from "../../types";

/**
 * A contact's reminder lifecycle state - the single source of truth for this
 * decision, mirroring `followUpStatus.ts`'s `resolveFollowUpStatus` role.
 * Other code (row badges, the contact modal, dashboard breakdowns) must read
 * through `resolveReminderLifecycleState`/`isReminderOutstanding` below,
 * never re-derive `reminderAt`/`reminderClosedReason` comparisons inline.
 *
 * - `"none"` - no reminder was ever set (and none was ever closed/cancelled).
 * - `"future"` - a reminder is set (`reminderAt` non-null) and its time
 *   hasn't arrived yet.
 * - `"due"` - a reminder is set and its time has passed. **Purely
 *   time-derived** - DUE is never written to the database and never requires
 *   a background write when the clock ticks past `reminderAt`; it's just
 *   `reminderAt <= now`, recomputed on every read.
 * - `"closed"` - the reminder was closed (`reminderClosedReason` is
 *   `"handled"`, `"voted"`, `"case_closed"`, `"no_answer"`, or `"answered"`)
 *   and no new reminder has been set since. Only ever set by the closing
 *   RPC (manual close, voted, non-voting reason, or Due-Reminder
 *   Auto-Close) - never inferred.
 * - `"cancelled"` - the reminder was explicitly cancelled
 *   (`reminderClosedReason === "cancelled"`) and no new reminder has been
 *   set since. Only ever set by the cancel RPC - never inferred.
 *
 * A fresh `reminderAt` (a new call to `setReminder`/`setReminderAt`, e.g. a
 * reschedule) always wins over a stale `reminderClosedReason` from a prior
 * cycle - that's why `reminderAt` is checked first below.
 */
export type ReminderLifecycleState = "none" | "future" | "due" | "closed" | "cancelled";

export function resolveReminderLifecycleState(
  contact: Pick<ElectionDayVoter, "reminderAt" | "reminderClosedReason">,
  now: Date = new Date(),
): ReminderLifecycleState {
  if (contact.reminderAt) {
    return new Date(contact.reminderAt).getTime() <= now.getTime() ? "due" : "future";
  }
  if (contact.reminderClosedReason === "cancelled") return "cancelled";
  if (contact.reminderClosedReason) return "closed"; // handled | voted | case_closed
  return "none";
}

/** Whether a lifecycle state represents a reminder that's still open and
 * needs attention (a badge/pulse in the UI) - the direct replacement for the
 * old future-only `isReminderActive` check. */
export function isReminderOutstanding(state: ReminderLifecycleState): boolean {
  return state === "future" || state === "due";
}
