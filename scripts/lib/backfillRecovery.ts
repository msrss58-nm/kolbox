/**
 * Multi-Tenant Phase 2 - read-only crash-recovery reconciliation logic.
 *
 * This module has NO mutating capability whatsoever - it contains no
 * reference to `auth.admin.deleteUser`, `createClient`, or any Supabase
 * Admin API call of any kind. Its only inputs are read-only SQL results;
 * its only outputs are classification verdicts for a human to act on
 * separately. `recover-historical-backfill.ts` is a thin CLI wrapper around
 * `evaluateRecovery` below and performs no mutation itself either.
 *
 * ============================================================================
 * "THE RECEIPT IS NEVER AUTHORITY" (reviewer-mandated design)
 * ============================================================================
 * `evaluateRecovery` calls `assertReceiptMatchesApprovedTarget` (from
 * backfillTarget.ts) FIRST, before any live query of any kind - a receipt
 * whose productionProjectRef/workspaceName/electionEndAtIso/ownerName/
 * ownerPhone/ownerEmail don't EXACTLY match the fixed approved constants is
 * rejected outright (TARGET_METADATA_MISMATCH_HARD_STOP), never partially
 * trusted. Once validated, every live query and comparison below uses the
 * FIXED constants directly (`OWNER_EMAIL`/`WORKSPACE_NAME`/
 * `ELECTION_END_AT_ISO`) - never `receipt.ownerEmail`/`receipt.workspaceName`/
 * `receipt.electionEndAtIso` - so a bug or future regression in the
 * validation gate can never, by itself, cause a live query to run against a
 * receipt-controlled value.
 *
 * A receipt's `authUserId` gets its own, separate independent check (it has
 * no fixed "approved" value of its own - it's legitimate run-specific
 * evidence): this module queries Production for the live Auth user id found
 * for the fixed, approved Owner email and requires it to match the receipt's
 * claimed `authUserId` exactly. Any disagreement - zero matching accounts,
 * more than one, or a different id than the receipt claims - is a hard stop,
 * never a guess.
 */
import type { SqlQueryOne } from "./backfillPreflight";
import {
  decideReconciliation,
  type ReconciliationDecision,
  type ReconciliationSnapshot,
} from "./historicalBackfillOrchestration";
import type { BackfillReceipt } from "./backfillReceipt";
import {
  OWNER_EMAIL,
  WORKSPACE_NAME,
  ELECTION_END_AT_ISO,
  assertReceiptMatchesApprovedTarget,
} from "./backfillTarget";

export interface TargetIdentityLiveState {
  authUsersForEmailCount: number;
  /** null unless authUsersForEmailCount === 1. */
  authUserIdForEmail: string | null;
  workspaceCount: number;
  electionOwnersForEmail: number;
  pendingOwnerAccessForEmail: number;
  platformOwnersForEmail: number;
  multiEntityOwnerForEmail: number;
}

/** Independent, read-only live query for the one fixed, approved Owner email
 * (`OWNER_EMAIL` from backfillTarget.ts) - every call site in this module
 * calls this with no second argument, so the query always uses the fixed
 * constant. The parameter exists only so this function itself is unit-
 * testable in isolation with a fabricated email; it must never be fed a
 * receipt-controlled value by a caller in this module. */
export async function queryTargetIdentityLiveState(
  sqlQueryOne: SqlQueryOne,
  ownerEmail: string = OWNER_EMAIL,
): Promise<TargetIdentityLiveState> {
  const row = await sqlQueryOne<{
    snapshot: {
      authUsersForEmailCount: number;
      authUserIdForEmail: string | null;
      workspaceCount: number;
      electionOwnersForEmail: number;
      pendingOwnerAccessForEmail: number;
      platformOwnersForEmail: number;
      multiEntityOwnerForEmail: number;
    };
  }>(`
    select jsonb_build_object(
      'authUsersForEmailCount', (select count(*) from auth.users where lower(email) = lower('${ownerEmail}')),
      'authUserIdForEmail', (select id::text from auth.users where lower(email) = lower('${ownerEmail}') order by created_at asc limit 1),
      'workspaceCount', (select count(*) from election_workspaces),
      'electionOwnersForEmail', (select count(*) from election_owners where lower(email) = lower('${ownerEmail}')),
      'pendingOwnerAccessForEmail', (select count(*) from election_workspace_pending_owner_access where lower(email) = lower('${ownerEmail}')),
      'platformOwnersForEmail', (select count(*) from platform_owners where lower(email) = lower('${ownerEmail}')),
      'multiEntityOwnerForEmail', (select count(*) from multi_entity_owner where lower(email) = lower('${ownerEmail}'))
    ) as snapshot
  `);
  return row.snapshot;
}

export type RecoveryVerdict =
  | { kind: "NOTHING_CREATED"; liveState: TargetIdentityLiveState }
  | { kind: "PREFLIGHT_HARD_STOP"; reason: string; liveState: TargetIdentityLiveState }
  | {
      kind: "IDENTITY_MISMATCH_HARD_STOP";
      reason: string;
      liveState: TargetIdentityLiveState;
    }
  | {
      kind: "BRANCH_A_LIKELY_COMMITTED";
      authUserId: string;
      decision: ReconciliationDecision;
      snapshot: ReconciliationSnapshot;
    }
  | {
      kind: "BRANCH_B_ORPHAN_CANDIDATE";
      authUserId: string;
      decision: ReconciliationDecision;
      snapshot: ReconciliationSnapshot;
    }
  | {
      kind: "BRANCH_C_HARD_STOP";
      authUserId: string;
      decision: ReconciliationDecision;
      snapshot: ReconciliationSnapshot;
    }
  | { kind: "ALREADY_CONFIRMED"; phase: BackfillReceipt["phase"] }
  | { kind: "MALFORMED_RECEIPT_HARD_STOP"; reason: string }
  | { kind: "TARGET_METADATA_MISMATCH_HARD_STOP"; reason: string };

/**
 * Evaluates recovery for `receipt.phase === "PREFLIGHT_CONFIRMED"`. A prior
 * review found the process could die in the narrow window between a real
 * Auth user being created and the receipt being durably updated - so this
 * phase must NOT be assumed to mean "nothing happened." Only if live
 * evidence independently confirms a fully clean state (no Auth user for the
 * approved email, zero workspaces, zero identity-table linkage for that
 * email) may "nothing was created" be reported.
 */
export function evaluatePreflightConfirmedRecovery(
  liveState: TargetIdentityLiveState,
): RecoveryVerdict {
  const problems: string[] = [];
  if (liveState.authUsersForEmailCount !== 0)
    problems.push(
      `auth.users has ${liveState.authUsersForEmailCount} row(s) for the approved Owner email, despite the receipt showing no Auth user was ever created.`,
    );
  if (liveState.workspaceCount !== 0)
    problems.push(
      `election_workspaces has ${liveState.workspaceCount} row(s), despite the receipt showing PREFLIGHT_CONFIRMED only.`,
    );
  if (liveState.electionOwnersForEmail !== 0)
    problems.push(
      `election_owners has ${liveState.electionOwnersForEmail} row(s) for the approved Owner email.`,
    );
  if (liveState.pendingOwnerAccessForEmail !== 0)
    problems.push(
      `election_workspace_pending_owner_access has ${liveState.pendingOwnerAccessForEmail} row(s) for the approved Owner email.`,
    );
  if (liveState.platformOwnersForEmail !== 0)
    problems.push(
      `platform_owners has ${liveState.platformOwnersForEmail} row(s) for the approved Owner email.`,
    );
  if (liveState.multiEntityOwnerForEmail !== 0)
    problems.push(
      `multi_entity_owner has ${liveState.multiEntityOwnerForEmail} row(s) for the approved Owner email.`,
    );

  if (problems.length === 0) {
    return { kind: "NOTHING_CREATED", liveState };
  }
  return {
    kind: "PREFLIGHT_HARD_STOP",
    reason: `Live Production state contradicts a PREFLIGHT_CONFIRMED-only receipt - manual investigation required: ${problems.join(" ")}`,
    liveState,
  };
}

/**
 * Evaluates recovery for `receipt.phase === "AUTH_CREATED"`. The receipt's
 * `authUserId` is treated only as a CLAIM until independently confirmed
 * against the live, approved-email identity check - see the module doc
 * comment. Only once confirmed does live A/B/C reconciliation (keyed to the
 * now-independently-verified id) run.
 */
export async function evaluateAuthCreatedRecovery(params: {
  receiptAuthUserId: string;
  liveState: TargetIdentityLiveState;
  readReconciliationSnapshot: (authUserId: string) => Promise<ReconciliationSnapshot>;
}): Promise<RecoveryVerdict> {
  const { receiptAuthUserId, liveState } = params;

  if (liveState.authUsersForEmailCount === 0) {
    return {
      kind: "IDENTITY_MISMATCH_HARD_STOP",
      reason: `Receipt claims Auth user ${receiptAuthUserId} was created for the approved Owner email, but live Production has ZERO auth.users rows for that email. Refusing to guess.`,
      liveState,
    };
  }
  if (liveState.authUsersForEmailCount > 1) {
    return {
      kind: "IDENTITY_MISMATCH_HARD_STOP",
      reason: `Live Production has ${liveState.authUsersForEmailCount} auth.users rows for the approved Owner email (expected at most 1) - contradictory state, refusing to guess.`,
      liveState,
    };
  }
  if (liveState.authUserIdForEmail !== receiptAuthUserId) {
    return {
      kind: "IDENTITY_MISMATCH_HARD_STOP",
      reason: `Receipt claims authUserId ${receiptAuthUserId}, but the live Auth user for the approved Owner email is actually ${liveState.authUserIdForEmail}. The receipt and Production disagree - refusing to guess, refusing to act on the receipt's claim alone.`,
      liveState,
    };
  }

  // Independently confirmed: the receipt's authUserId is genuinely the live
  // Auth user for the one approved email. Now, and only now, reconcile.
  const confirmedAuthUserId = liveState.authUserIdForEmail;
  const snapshot = await params.readReconciliationSnapshot(confirmedAuthUserId);
  // Fixed constants only - never params/receipt-derived values. See the
  // module doc comment's "receipt is never authority" section.
  const decision = decideReconciliation(snapshot, {
    workspaceName: WORKSPACE_NAME,
    electionEndAtIso: ELECTION_END_AT_ISO,
  });

  if (decision.branch === "A") {
    return {
      kind: "BRANCH_A_LIKELY_COMMITTED",
      authUserId: confirmedAuthUserId,
      decision,
      snapshot,
    };
  }
  if (decision.branch === "B") {
    return {
      kind: "BRANCH_B_ORPHAN_CANDIDATE",
      authUserId: confirmedAuthUserId,
      decision,
      snapshot,
    };
  }
  return {
    kind: "BRANCH_C_HARD_STOP",
    authUserId: confirmedAuthUserId,
    decision,
    snapshot,
  };
}

/** Top-level evaluator the CLI wrapper calls - dispatches by receipt phase.
 * Never mutates anything; every branch above is read-only. */
export async function evaluateRecovery(params: {
  receipt: BackfillReceipt;
  sqlQueryOne: SqlQueryOne;
  readReconciliationSnapshot: (authUserId: string) => Promise<ReconciliationSnapshot>;
}): Promise<RecoveryVerdict> {
  const { receipt, sqlQueryOne, readReconciliationSnapshot } = params;

  // Hard stop BEFORE any live query/classification of any kind - a receipt
  // whose target metadata doesn't exactly match the fixed approved target is
  // refused outright, never partially trusted. See the module doc comment.
  try {
    assertReceiptMatchesApprovedTarget(receipt);
  } catch (err) {
    return {
      kind: "TARGET_METADATA_MISMATCH_HARD_STOP",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (receipt.phase === "PREFLIGHT_CONFIRMED") {
    // No second argument - always queries the fixed OWNER_EMAIL, never a
    // receipt-supplied value.
    const liveState = await queryTargetIdentityLiveState(sqlQueryOne);
    return evaluatePreflightConfirmedRecovery(liveState);
  }

  if (receipt.phase === "RPC_CONFIRMED" || receipt.phase === "POSTFLIGHT_VERIFIED") {
    return { kind: "ALREADY_CONFIRMED", phase: receipt.phase };
  }

  if (receipt.phase !== "AUTH_CREATED" || !receipt.authUserId) {
    return {
      kind: "MALFORMED_RECEIPT_HARD_STOP",
      reason: `Receipt is in an unrecognized/malformed state for recovery (phase "${receipt.phase}").`,
    };
  }

  const liveState = await queryTargetIdentityLiveState(sqlQueryOne);
  return evaluateAuthCreatedRecovery({
    receiptAuthUserId: receipt.authUserId,
    liveState,
    readReconciliationSnapshot,
  });
}
