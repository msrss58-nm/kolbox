import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { APP_CONFIG } from "../../constants/config";
import { resolveFollowUpStatus } from "./followUpStatus";
import { resolveReminderLifecycleState } from "./reminderLifecycle";

export interface FollowUpBreakdown {
  callAttempts2Plus: number;
  reminderDue: number;
  reminderWaiting: number;
}

export interface CallAttemptsWatchlistRow {
  id: string;
  firstName: string;
  lastName: string;
  coordinator: string;
  callAttempts: number;
}

/**
 * Single source of truth for "בוחר עם 2+ ניסיונות חיוג" - still on the
 * coordinator worklist (`resolveFollowUpStatus === "remaining"`) and at or
 * past the configured call-attempts threshold. Both the `callAttempts2Plus`
 * KPI tally below and `buildCallAttemptsWatchlist`'s drill-down rows read
 * through this exact check, so a future threshold/definition change happens
 * in one place and the two can never disagree.
 */
export function isCallAttempts2Plus(
  contact: ElectionDayVoter,
  reasonsById: ReadonlyMap<string, NonVotingReason>,
): boolean {
  return (
    resolveFollowUpStatus(contact, reasonsById) === "remaining" &&
    contact.callAttempts >= APP_CONFIG.electionDayAttentionCallAttemptsThreshold
  );
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

    if (isCallAttempts2Plus(c, reasonsById)) {
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
 * Dashboard "בוחרים עם 2+ ניסיונות חיוג" card - the exact same contacts
 * `FollowUpBreakdown.callAttempts2Plus` counts (`isCallAttempts2Plus` above),
 * just returned as rows instead of a tally, so the card can never show a
 * different set or total than the KPI tile next to it. Sorted by call
 * attempts descending (deterministic tie-break by name) - highest-attention
 * voters first, never random order.
 */
export function buildCallAttemptsWatchlist(
  contacts: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
): CallAttemptsWatchlistRow[] {
  const rows: CallAttemptsWatchlistRow[] = [];

  for (const c of contacts) {
    if (!isCallAttempts2Plus(c, reasonsById)) continue;
    rows.push({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      coordinator: c.coordinator,
      callAttempts: c.callAttempts,
    });
  }

  return rows.sort((a, b) => {
    if (b.callAttempts !== a.callAttempts) return b.callAttempts - a.callAttempts;
    return (a.lastName + a.firstName).localeCompare(b.lastName + b.firstName, "he");
  });
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
