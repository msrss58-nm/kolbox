import type { EffectiveRole, Permission } from "./types";

export interface PermissionDenialEvent {
  role: EffectiveRole;
  permission: Permission;
  timestamp: string;
  /** Optional free-text hint about where the denial happened, e.g. a
   * mutation name - not structured, just enough to grep a console log. */
  context?: string;
}

/**
 * The single, centralized place a denied permission check gets reported.
 * Stage 1 only: `console.warn` here, no DB table, no external telemetry -
 * see task-plan.md. Nothing calls this yet; Stage 3 is expected to wire it
 * into `useElectionDay`'s mutation guards so every blocked action reports
 * through this one function instead of each `handler` logging its own way.
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
