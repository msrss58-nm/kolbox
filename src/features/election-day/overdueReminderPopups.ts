import type { ElectionDayVoter } from "../../types";
import { resolveReminderLifecycleState } from "./reminderLifecycle";

/**
 * The persistent overdue-reminder popup stack's source list - every contact
 * (from the caller's already role/scope-filtered list) whose reminder is
 * DUE. Purely derived from already-persisted fields (`reminderAt`/
 * `reminderClosedReason`) via `reminderLifecycle.ts`'s own `"due"` state -
 * no separate popup-visibility storage of any kind, so a reload, re-login,
 * or screen navigation always reconstructs the exact same list from the
 * same source of truth, never a transient/local "was this toasted already"
 * flag. Sorted oldest-due-first (ascending `reminderAt`).
 *
 * Due-Reminder Auto-Close: a card leaves this list only when the reminder
 * itself actually closes (`reminderAt` cleared - via a real recorded
 * `no_answer`/`answered` outcome, a manual cancel, marking voted, or a
 * case-closing non-voting reason). A dial alone is deliberately NOT enough
 * to silence a card anymore - `lastCallAttemptAt >= reminderAt` used to
 * suppress it here, which was wrong once dialing stopped implying an
 * outcome (Call Outcome Tracking): a coordinator could dial, get no
 * answer, and never hear about it again just because the click itself
 * happened. Only recording the call's actual outcome closes the
 * reminder now (see `election_day_record_no_answer`/
 * `election_day_record_call_answered`'s Due-Reminder Auto-Close), and that
 * closure is exactly what removes the card here too - same single source
 * of truth, no separate suppression rule to keep in sync with it.
 */
export function resolveOverdueReminderPopups(
  contacts: readonly ElectionDayVoter[],
  now: Date = new Date(),
): ElectionDayVoter[] {
  return contacts
    .filter((c) => resolveReminderLifecycleState(c, now) === "due")
    .sort(
      // `reminderAt` is guaranteed non-null here - `resolveReminderLifecycleState`
      // only returns "due" when it is.
      (a, b) => Date.parse(a.reminderAt as string) - Date.parse(b.reminderAt as string),
    );
}
