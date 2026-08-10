import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { APP_CONFIG } from "../../constants/config";
import { resolveFollowUpStatus } from "./followUpStatus";
import { resolveReminderLifecycleState } from "./reminderLifecycle";

export interface FollowUpBreakdown {
  callAttempts2Plus: number;
  reminderDue: number;
  reminderWaiting: number;
}

/**
 * Dashboard row 3 ("מה דורש טיפול עכשיו"): partitions every contact whose
 * `resolveFollowUpStatus` is `"remaining"` into 3 mutually-exclusive buckets,
 * checked in priority order so each contact lands in exactly one - never
 * re-derives "remaining" itself, always reads through `resolveFollowUpStatus`
 * so this can never drift from `ElectionDayStats.remaining`'s own count.
 * DUE/FUTURE are read through `resolveReminderLifecycleState`, the single
 * source of truth for reminder state - never re-derived inline.
 */
export function buildFollowUpBreakdown(
  contacts: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
  now: Date = new Date(),
): FollowUpBreakdown {
  const breakdown: FollowUpBreakdown = {
    callAttempts2Plus: 0,
    reminderDue: 0,
    reminderWaiting: 0,
  };

  for (const c of contacts) {
    if (resolveFollowUpStatus(c, reasonsById) !== "remaining") continue;

    if (c.callAttempts >= APP_CONFIG.electionDayAttentionCallAttemptsThreshold) {
      breakdown.callAttempts2Plus++;
    } else {
      const state = resolveReminderLifecycleState(c, now);
      if (state === "due") breakdown.reminderDue++;
      else if (state === "future") breakdown.reminderWaiting++;
    }
  }

  return breakdown;
}

/**
 * Count of reminders closed on today's LOCAL calendar day (never UTC - a
 * reminder closed at 23:30 Israel time must not roll into "tomorrow" just
 * because UTC has already turned over). Reads current-state fields directly
 * off `election_day_voters` (no join to the reminder-events table - the hot
 * dashboard path must stay fast). `cancelled` is excluded by explicit
 * product decision - a cancelled reminder was never "handled", so it doesn't
 * count toward today's closed-reminders tally.
 *
 * Mirrors `reminderDisplay.ts`'s `formatReminderDisplay` same-local-day
 * comparison (year/month/date equality against `now`) so both agree on what
 * "today" means.
 */
export function buildClosedRemindersToday(
  contacts: readonly ElectionDayVoter[],
  now: Date = new Date(),
): number {
  let count = 0;
  for (const c of contacts) {
    if (!c.reminderClosedAt || !c.reminderClosedReason) continue;
    if (c.reminderClosedReason === "cancelled") continue;
    const closedAt = new Date(c.reminderClosedAt);
    if (
      closedAt.getFullYear() === now.getFullYear() &&
      closedAt.getMonth() === now.getMonth() &&
      closedAt.getDate() === now.getDate()
    ) {
      count++;
    }
  }
  return count;
}
