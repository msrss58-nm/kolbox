import { APP_CONFIG } from "../../constants/config";
import type { Permission } from "../../permissions/types";
import type { FollowUpBreakdown } from "./followUpBreakdown";
import type { RideStatusBreakdown } from "./rideStatusBreakdown";

export type AttentionAlertRow =
  | { type: "callAttempts"; permission: Permission; count: number }
  | { type: "ridesUnmatched"; permission: Permission; count: number }
  | {
      type: "coordinatorOverload";
      permission: Permission;
      count: number;
      coordinator: string;
    }
  | { type: "remindersOverdue"; permission: Permission; count: number };

/**
 * Dashboard "מוקדי תשומת לב": up to 4 rows, each derived from an
 * already-computed breakdown (never re-scans the contact list) so this can
 * never disagree with the row-3/row-4 tiles that show the same underlying
 * numbers. A row is omitted entirely when its count is 0 (or, for the
 * coordinator-overload row, below `electionDayAttentionCoordinatorOverloadFloor`
 * - flagging a coordinator with e.g. 2 open contacts left isn't a real
 * "overload"). Order matches the source mockup: call attempts, unmatched
 * rides, coordinator overload, overdue reminders.
 */
export function buildAttentionAlerts(
  followUpBreakdown: FollowUpBreakdown,
  rideStatusBreakdown: RideStatusBreakdown,
  coordinatorBreakdown: readonly { coordinator: string; remaining: number }[],
): AttentionAlertRow[] {
  const rows: AttentionAlertRow[] = [];

  if (followUpBreakdown.callAttempts2Plus > 0) {
    rows.push({
      type: "callAttempts",
      permission: "voter.viewPhone",
      count: followUpBreakdown.callAttempts2Plus,
    });
  }

  if (rideStatusBreakdown.needsRide > 0) {
    rows.push({
      type: "ridesUnmatched",
      permission: "voter.viewRideStatus",
      count: rideStatusBreakdown.needsRide,
    });
  }

  const mostLoaded = [...coordinatorBreakdown].sort(
    (a, b) => b.remaining - a.remaining,
  )[0];
  if (
    mostLoaded &&
    mostLoaded.remaining >= APP_CONFIG.electionDayAttentionCoordinatorOverloadFloor
  ) {
    rows.push({
      type: "coordinatorOverload",
      permission: "voter.viewCoordinator",
      count: mostLoaded.remaining,
      coordinator: mostLoaded.coordinator,
    });
  }

  if (followUpBreakdown.reminderDue > 0) {
    rows.push({
      type: "remindersOverdue",
      permission: "voter.viewReminderStatus",
      count: followUpBreakdown.reminderDue,
    });
  }

  return rows;
}
