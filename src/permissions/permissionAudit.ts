import type { EffectiveRole, Permission } from "./types";

export interface PermissionDenialEvent {
  /** `null` when there is no Election Day session at all - a denial can
   * happen with no role to attribute it to (e.g. a stale tab after logout). */
  role: EffectiveRole | null;
  permission: Permission;
  timestamp: string;
  /** Optional free-text hint about where the denial happened, e.g. a
   * mutation name - not structured, just enough to grep a console log. */
  context?: string;
}

/**
 * The single, centralized place a denied permission check gets reported.
 * `console.warn` here, no DB table, no external telemetry - see task-plan.md.
 * Wired into `useElectionDay`'s `guardedAction` mutation guards (Stage 3) so
 * every blocked action - including one attempted with no session - reports
 * through this one function instead of each handler logging its own way.
 */
export function reportPermissionDenied(
  event: Omit<PermissionDenialEvent, "timestamp">,
): void {
  const fullEvent: PermissionDenialEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  console.warn("[permissions] denied", fullEvent);
}
