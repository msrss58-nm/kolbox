import type { ElectionDayVoter } from "../../types";
import {
  isReminderOutstanding,
  resolveReminderLifecycleState,
} from "./reminderLifecycle";

/** Whether a contact has an outstanding (future OR due) reminder - used to
 * decide whether to show a reminder badge/pulse. Reads through
 * `reminderLifecycle.ts`, the single source of truth for this decision.
 *
 * NOTE: this used to take `reminderAt: string | null` directly and mean
 * "future only" - DUE reminders (time already passed) were invisible, which
 * was the root cause of the reminder-lifecycle bug this module now fixes.
 * It now takes the whole contact (needs `reminderClosedReason` too) and
 * means "future or due". */
export function isReminderActive(
  contact: Pick<ElectionDayVoter, "reminderAt" | "reminderClosedReason">,
  now: Date = new Date(),
): boolean {
  return isReminderOutstanding(resolveReminderLifecycleState(contact, now));
}

/** Whether a contact's reminder is specifically DUE (time already passed) as
 * opposed to FUTURE (still waiting) - lets the UI visually distinguish the
 * two (e.g. amber for future, red for due). */
export function isReminderDue(
  contact: Pick<ElectionDayVoter, "reminderAt" | "reminderClosedReason">,
  now: Date = new Date(),
): boolean {
  return resolveReminderLifecycleState(contact, now) === "due";
}
