import type { ElectionDayVoter } from "../../types";
import { resolveReminderLifecycleState } from "./reminderLifecycle";

/** Whether a call made from the call button (either the contact modal's or
 * the overdue-reminder popup's own - same `incrementCallAttempts` mutation
 * either way) counts as having handled this specific reminder. Compares
 * against `reminderAt` itself, not "now" or "due-since" - a call made any
 * time from the moment this reminder was SET onward (whether the reminder
 * was future or already due at call time) counts; an older call from before
 * this reminder even existed (e.g. a call last week, followed by a brand
 * new reminder set today) must not silently count as handling today's
 * reminder, which is exactly what comparing against "now" instead would
 * get wrong. */
function isHandledByCall(
  contact: Pick<ElectionDayVoter, "reminderAt" | "lastCallAttemptAt">,
): boolean {
  if (!contact.reminderAt || !contact.lastCallAttemptAt) return false;
  return (
    new Date(contact.lastCallAttemptAt).getTime() >=
    new Date(contact.reminderAt).getTime()
  );
}

/**
 * The persistent overdue-reminder popup stack's source list - every contact
 * (from the caller's already role/scope-filtered list) whose reminder is
 * DUE and not yet handled by a call since it was set. Purely derived from
 * already-persisted fields (`reminderAt`/`reminderClosedReason`/
 * `lastCallAttemptAt`) via `reminderLifecycle.ts`'s own `"due"` state - no
 * separate popup-visibility storage of any kind, so a reload, re-login, or
 * screen navigation always reconstructs the exact same list from the same
 * source of truth, never a transient/local "was this toasted already" flag.
 * Sorted oldest-due-first (ascending `reminderAt`).
 */
export function resolveOverdueReminderPopups(
  contacts: readonly ElectionDayVoter[],
  now: Date = new Date(),
): ElectionDayVoter[] {
  return contacts
    .filter((c) => resolveReminderLifecycleState(c, now) === "due" && !isHandledByCall(c))
    .sort(
      // `reminderAt` is guaranteed non-null here - `resolveReminderLifecycleState`
      // only returns "due" when it is.
      (a, b) => Date.parse(a.reminderAt as string) - Date.parse(b.reminderAt as string),
    );
}
