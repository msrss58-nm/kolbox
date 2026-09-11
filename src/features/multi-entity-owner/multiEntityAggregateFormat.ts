import { ROUTES } from "../../constants/routes";
import { fmtVotedPct } from "../../lib/utils";
import type { MultiEntityAggregateMetrics } from "./multiEntityOwnerClient";

/**
 * Platform Stage 7: pure presentation helpers for the Multi-Entity dashboard.
 * A .ts module with no component export (react-refresh/only-export-components).
 */

/** Share of contacts who voted, derived ONLY from counts the server released.
 * `null` when there is no denominator - rendered as a dash, never "0%". */
export function formatVotedShare(metrics: MultiEntityAggregateMetrics): string | null {
  if (metrics.contactsTotal <= 0) return null;
  return fmtVotedPct((metrics.voted / metrics.contactsTotal) * 100);
}

/** `HH:MM` for the "last updated" line. */
export function formatClock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function multiEntityWorkspacePath(workspaceId: string): string {
  return ROUTES.multiEntityWorkspace.replace(
    ":workspaceId",
    encodeURIComponent(workspaceId),
  );
}
