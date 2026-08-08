import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { APP_CONFIG } from "../../constants/config";
import { resolveFollowUpStatus } from "./followUpStatus";

export interface FollowUpBreakdown {
  callAttempts2Plus: number;
  reminderDue: number;
  reminderWaiting: number;
  notYetHandled: number;
}

/**
 * Dashboard row 3 ("מה דורש טיפול עכשיו"): partitions every contact whose
 * `resolveFollowUpStatus` is `"remaining"` into 4 mutually-exclusive buckets,
 * checked in priority order so each contact lands in exactly one - never
 * re-derives "remaining" itself, always reads through `resolveFollowUpStatus`
 * so this can never drift from `ElectionDayStats.remaining`'s own count.
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
    notYetHandled: 0,
  };
  const nowMs = now.getTime();

  for (const c of contacts) {
    if (resolveFollowUpStatus(c, reasonsById) !== "remaining") continue;

    if (c.callAttempts >= APP_CONFIG.electionDayAttentionCallAttemptsThreshold) {
      breakdown.callAttempts2Plus++;
    } else if (c.reminderAt && new Date(c.reminderAt).getTime() <= nowMs) {
      breakdown.reminderDue++;
    } else if (c.reminderAt) {
      breakdown.reminderWaiting++;
    } else {
      breakdown.notYetHandled++;
    }
  }

  return breakdown;
}
