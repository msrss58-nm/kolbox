/**
 * Multi-Tenant Phase 2 - the single, approved historical Backfill target.
 *
 * Shared by run-historical-backfill-production.ts and
 * recover-historical-backfill.ts so both tools reference the exact same
 * values - recovery's whole point is to independently verify Production
 * against this fixed target rather than trust anything the receipt claims,
 * so it must never hold its own, potentially-drifted copy of these
 * constants. Values per the explicit administrative decision recorded in
 * CURRENT_STATUS.md's Phase 2 section - not derived, not overridable via
 * CLI args/env.
 */
import { APPROVED_PRODUCTION_PROJECT_REF } from "./productionIdentity";
import type { BackfillReceipt } from "./backfillReceipt";

export const WORKSPACE_NAME = "מודיעין";
export const ELECTION_END_AT_ISO = "2026-08-17T19:00:00.000Z"; // 22:00 Asia/Jerusalem (IDT, UTC+3 in August)
export const OWNER_NAME = "נחום שניר";
export const OWNER_PHONE = "0502342010";
export const OWNER_EMAIL = "simofe8@gmail.com";

export const TABLES = [
  "election_day_settings",
  "election_day_voters",
  "election_day_ride_status_events",
  "election_day_ride_coordinators",
  "election_day_permission_users",
  "election_day_coordinators",
  "election_day_coordinator_operations",
  "election_day_coordinator_operation_items",
  "election_day_roles",
  "election_day_not_voting_reasons",
  "election_day_reminder_events",
  "election_day_reauth_proofs",
] as const;

/**
 * Central "receipt is never authority" fail-closed gate.
 *
 * A receipt carries its own copy of the target metadata (productionProjectRef,
 * workspaceName, electionEndAtIso, ownerName, ownerPhone, ownerEmail) purely
 * as run-specific EVIDENCE of what that run believed it was targeting - never
 * as something recovery/post-flight should act on directly. Every consumer
 * that reads a receipt (lib/backfillRecovery.ts, verify-historical-backfill-
 * postflight.ts) MUST call this function first and MUST use the fixed
 * constants exported above (never the receipt's own copies) for every
 * subsequent live query/comparison. A receipt that fails this check is
 * rejected outright - no partial trust, no "validate then use the receipt's
 * value anyway".
 *
 * Deliberately excludes authUserId/rpcResult/phase/runId/preflight baseline -
 * those are legitimate run-specific evidence with no fixed "approved" value
 * of their own, and stay validated by their own mechanisms (the live
 * Auth-identity cross-check in backfillRecovery.ts, phase-order enforcement
 * in backfillReceipt.ts).
 */
export function assertReceiptMatchesApprovedTarget(receipt: BackfillReceipt): void {
  const mismatches: string[] = [];
  if (receipt.productionProjectRef !== APPROVED_PRODUCTION_PROJECT_REF)
    mismatches.push(
      `productionProjectRef: receipt has "${receipt.productionProjectRef}", approved is "${APPROVED_PRODUCTION_PROJECT_REF}"`,
    );
  if (receipt.workspaceName !== WORKSPACE_NAME)
    mismatches.push(
      `workspaceName: receipt has "${receipt.workspaceName}", approved is "${WORKSPACE_NAME}"`,
    );
  if (receipt.electionEndAtIso !== ELECTION_END_AT_ISO)
    mismatches.push(
      `electionEndAtIso: receipt has "${receipt.electionEndAtIso}", approved is "${ELECTION_END_AT_ISO}"`,
    );
  if (receipt.ownerName !== OWNER_NAME)
    mismatches.push(
      `ownerName: receipt has "${receipt.ownerName}", approved is "${OWNER_NAME}"`,
    );
  if (receipt.ownerPhone !== OWNER_PHONE)
    mismatches.push(
      `ownerPhone: receipt has "${receipt.ownerPhone}", approved is "${OWNER_PHONE}"`,
    );
  if (receipt.ownerEmail !== OWNER_EMAIL)
    mismatches.push(
      `ownerEmail: receipt has "${receipt.ownerEmail}", approved is "${OWNER_EMAIL}"`,
    );

  if (mismatches.length > 0) {
    throw new Error(
      `assertReceiptMatchesApprovedTarget: HARD STOP - receipt target metadata does not exactly match the fixed approved target in backfillTarget.ts. A receipt is evidence, never authority - this disagreement is refused outright, not used anyway. Mismatches: ${mismatches.join("; ")}`,
    );
  }
}
