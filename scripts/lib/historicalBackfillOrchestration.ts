/**
 * Multi-Tenant Phase 2 - historical Backfill orchestration.
 *
 * NOT deployable - lives under scripts/lib alongside productionTestSafety.ts
 * (this project's established convention for internal server-side modules
 * consumed only by local/disposable test scripts), deliberately outside any
 * `api/` directory so it can never become a Vercel route by accident. A
 * real Vercel Server Function that calls this orchestration will be added
 * only once the approved Platform Owner authentication/authorization layer
 * exists - see CURRENT_STATUS.md's Phase 2 section. Never touches `auth.*`
 * tables directly - only the official Supabase Admin API
 * (`supabaseAdmin.auth.admin.*`), per the approved design.
 *
 * Approved one-time historical exception ONLY: creates the historical
 * Election Workspace + first Election Owner directly, instead of the normal
 * future Pending-Access -> Owner-first-login flow. Do not reuse this
 * orchestration for future customer workspace onboarding.
 *
 * ============================================================================
 * PASSWORD HANDLING (reviewer-mandated design, do not regress)
 * ============================================================================
 * This module never generates, returns, logs, or serializes the Owner's
 * temporary password. `generateOwnerTemporaryPassword()` exists so a CALLER
 * can generate the password BEFORE any mutation, display it exactly once to
 * a human operator, and obtain explicit confirmation that it was captured -
 * only after that confirmation does the caller invoke
 * `runHistoricalBackfillOrchestration`, passing the already-delivered
 * password in as `HistoricalBackfillInput.ownerTemporaryPassword`. This way
 * password delivery never depends on this function - or the RPC it calls -
 * actually succeeding or returning a response.
 *
 * `HistoricalBackfillInput` (which carries the password) must never be
 * logged, `JSON.stringify`'d, or included whole in any thrown Error. Every
 * error message in this file is built from specific, known-safe fields only
 * (ids, table/branch names, reasons) - never from `input` as a whole.
 *
 * ============================================================================
 * AMBIGUOUS RPC OUTCOME - MANDATORY RECONCILIATION (reviewer-mandated design)
 * ============================================================================
 * There is no longer any attempt to classify an RPC error as "definite
 * rejection" vs "ambiguous network failure" by inspecting its message/class -
 * that classification was itself judged an avoidable risk. Instead, ANY
 * error returned from the RPC call triggers the exact same procedure:
 * read-only reconciliation of real database state, keyed on the exact
 * `auth_user_id` this run created, via `decideReconciliation` (a pure,
 * independently unit-testable function - see its own doc comment for the
 * full A/B/C decision rules). Compensation (deleting the just-created Auth
 * user) happens ONLY on a Branch B decision, which requires proving zero
 * application-level reference to this exact auth_user_id AND that
 * `election_workspaces` has zero rows - not merely "no election_owners row",
 * since another Multi-Tenant identity table (election_workspace_pending_
 * owner_access / platform_owners / multi_entity_owner) also carries a
 * foreign key to auth.users and must be checked too. Branch A (likely
 * committed) and Branch C (contradictory/uncertain) both explicitly forbid
 * compensation, forbid retry, and forbid any workspace deletion - the caller
 * must stop and, for Branch A, proceed to full read-only post-flight
 * verification instead of treating the call as a failure.
 *
 * This module never retries anything internally (no loop of any kind) and
 * never deletes `election_workspaces` under any circumstance - the FK from
 * every one of the 12 legacy tables' `workspace_id` to `election_workspaces`
 * is `ON DELETE CASCADE`, so deleting that row after a real backfill would
 * destroy real application data, not just "roll back" this operation.
 *
 * ============================================================================
 * CRASH-RECOVERY ORDERING (reviewer-mandated design, do not regress)
 * ============================================================================
 * A caller-supplied `onAuthCreated(authUserId)` callback is awaited
 * immediately after `auth.admin.createUser` succeeds and BEFORE the Backfill
 * RPC is ever called. The caller uses this to durably record (e.g. write a
 * crash-recovery receipt to disk) that this specific Auth user now exists,
 * closing the window where a process could die between Auth creation and
 * the RPC call with no record of the resulting authUserId anywhere. If the
 * callback rejects, the RPC is never invoked and the Auth user is NOT
 * auto-deleted (see `HistoricalBackfillReceiptWriteFailedError`) - a failed
 * durable-record write is itself too uncertain a state to compensate
 * against blindly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

export interface HistoricalBackfillInput {
  workspaceName: string;
  electionEndAtIso: string;
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string;
  /** Generated and delivered to the operator by the CALLER, before this
   * function is ever invoked - see the module doc comment. This function
   * never generates one itself and never echoes it back anywhere. */
  ownerTemporaryPassword: string;
}

export interface HistoricalBackfillResult {
  authUserId: string;
  workspaceId: string;
  ownerId: string;
  rowCounts: Record<string, number>;
  // Deliberately no password field of any kind - the caller already has it
  // from before this function was ever called (see module doc comment).
}

/** Generates a strong random temporary password. Exported so the CALLER can
 * generate it before any mutation and deliver it to the operator first - see
 * the module doc comment. This module never calls this itself. */
export function generateOwnerTemporaryPassword(): string {
  // 32 random bytes -> 43-char base64url string: well above any reasonable
  // strength floor, generated fresh per attempt, never derived from
  // anything persisted or guessable.
  return randomBytes(32).toString("base64url");
}

/** Read-only facts about whether/how the exact `auth_user_id` this run
 * created is referenced anywhere in the Multi-Tenant application schema.
 * Every one of the 4 identity tables that carries a foreign key to
 * `auth.users(id)` (confirmed via live, read-only introspection of
 * Production's own pg_constraint - see CURRENT_STATUS.md/this session's
 * record) is represented here, not just election_owners. */
export interface ReconciliationSnapshot {
  workspaceCount: number;
  electionOwnerLinked: boolean;
  /** null when electionOwnerLinked is false. */
  electionOwnerWorkspaceName: string | null;
  /** null when electionOwnerLinked is false. ISO-8601. */
  electionOwnerWorkspaceElectionEndAtIso: string | null;
  pendingOwnerAccessLinked: boolean;
  platformOwnerLinked: boolean;
  multiEntityOwnerLinked: boolean;
}

/** Injected by the caller - this module has no DB driver/SQL execution of
 * its own (kept pure/framework-agnostic, matching this module's existing
 * design). A local/disposable test supplies this via direct SQL against a
 * throwaway Postgres container; the production runner supplies it via the
 * already-authenticated `supabase db query --linked` channel (the same
 * credential-safe mechanism used throughout this project's own Production
 * verification work) - never a raw connection string, never service_role
 * over PostgREST (service_role holds no SELECT grant on these tables by
 * design - see the Phase 2 migration's own SECURITY DEFINER notes). */
export type ReadReconciliationSnapshot = (
  authUserId: string,
) => Promise<ReconciliationSnapshot>;

export interface ReconciliationExpectation {
  workspaceName: string;
  electionEndAtIso: string;
}

export type ReconciliationDecision =
  | { branch: "A"; reason: string }
  | { branch: "B"; reason: string }
  | { branch: "C"; reason: string };

/**
 * Pure decision function - independently unit-testable with fabricated
 * snapshots, no DB/network access. Implements the exact reviewer-approved
 * rules:
 *
 * A - an election_owners row references this auth_user_id, AND its linked
 *     workspace's name/election_end_at match what this run expected. The RPC
 *     very likely committed. No compensation, no retry - the caller proceeds
 *     to full post-flight verification instead.
 *
 * B - ALL of the following are true: no election_owners row references this
 *     auth_user_id; no election_workspace_pending_owner_access row
 *     references it; no platform_owners row references it; no
 *     multi_entity_owner row references it; AND election_workspaces has
 *     ZERO rows (not merely "no row linked to this auth_user_id" - the
 *     table itself must be empty). Only then is it proven that deleting
 *     this specific Auth user has no unintended side effect anywhere.
 *     Compensation is permitted.
 *
 * C - anything else: an election_owners row references this auth_user_id
 *     but points at an unexpected workspace; some OTHER identity table
 *     references this auth_user_id even though election_owners does not;
 *     or no table references this auth_user_id at all but
 *     election_workspaces is non-empty anyway (a state this RPC's own
 *     one-shot, single-transaction design should make impossible, which is
 *     exactly why it must never be auto-resolved). Hard stop - no
 *     compensation, no retry, no workspace deletion, manual review only.
 *
 * Note the deliberate consequence: once the one historical workspace exists
 * at all (from this run or an earlier one), a SUBSEQUENT rejected attempt's
 * own fresh, definitely-unlinked auth_user_id no longer qualifies for
 * Branch B (election_workspaces is no longer empty) and falls to Branch C
 * instead - every post-success retry attempt hard-stops for manual account
 * cleanup rather than auto-compensating. This is intentional for a
 * one-time-ever operation: a second attempt after a real success is itself
 * an unexpected event that should surface for human attention, not silently
 * self-heal.
 */
export function decideReconciliation(
  snapshot: ReconciliationSnapshot,
  expected: ReconciliationExpectation,
): ReconciliationDecision {
  if (snapshot.electionOwnerLinked) {
    const matches =
      snapshot.electionOwnerWorkspaceName === expected.workspaceName &&
      snapshot.electionOwnerWorkspaceElectionEndAtIso === expected.electionEndAtIso;
    if (matches) {
      return {
        branch: "A",
        reason:
          "election_owners references this auth_user_id, linked to a workspace matching the expected name/election_end_at.",
      };
    }
    return {
      branch: "C",
      reason:
        "election_owners references this auth_user_id, but the linked workspace's name/election_end_at do not match what this run expected - contradictory state.",
    };
  }

  if (
    snapshot.pendingOwnerAccessLinked ||
    snapshot.platformOwnerLinked ||
    snapshot.multiEntityOwnerLinked
  ) {
    const which = [
      snapshot.pendingOwnerAccessLinked && "election_workspace_pending_owner_access",
      snapshot.platformOwnerLinked && "platform_owners",
      snapshot.multiEntityOwnerLinked && "multi_entity_owner",
    ]
      .filter(Boolean)
      .join(", ");
    return {
      branch: "C",
      reason: `no election_owners linkage, but ${which} references this auth_user_id - unexpected for this flow, contradictory state.`,
    };
  }

  if (snapshot.workspaceCount === 0) {
    return {
      branch: "B",
      reason:
        "no application-level table references this auth_user_id, and election_workspaces has zero rows - safe to compensate.",
    };
  }

  return {
    branch: "C",
    reason: `no application-level table references this auth_user_id, but election_workspaces already has ${snapshot.workspaceCount} row(s) - cannot prove this account's creation is unrelated to that state. Hard stop required.`,
  };
}

export class HistoricalBackfillAuthCreateFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalBackfillAuthCreateFailedError";
  }
}

/** Branch B: the RPC failed, reconciliation proved zero application-level
 * linkage anywhere and an empty election_workspaces, and the just-created
 * Auth user was therefore safely deleted. The overall attempt still failed -
 * a fresh attempt (with a freshly generated password, never the same one)
 * is the caller's decision, not something this module does automatically. */
export class HistoricalBackfillCompensatedError extends Error {
  readonly authUserId: string;
  constructor(message: string, authUserId: string) {
    super(message);
    this.name = "HistoricalBackfillCompensatedError";
    this.authUserId = authUserId;
  }
}

/** Branch A: the RPC errored but reconciliation found this exact
 * auth_user_id already correctly linked to the expected workspace - very
 * likely a lost response, not a real failure. The Auth user was NOT
 * touched. The caller must run full post-flight verification rather than
 * treat this as a plain failure. */
export class HistoricalBackfillAmbiguousLikelySuccessError extends Error {
  readonly authUserId: string;
  readonly snapshot: ReconciliationSnapshot;
  constructor(message: string, authUserId: string, snapshot: ReconciliationSnapshot) {
    super(message);
    this.name = "HistoricalBackfillAmbiguousLikelySuccessError";
    this.authUserId = authUserId;
    this.snapshot = snapshot;
  }
}

/** Branch C: reconciliation found a contradictory/partial/uncertain state.
 * The Auth user was NOT touched, nothing was retried, nothing was deleted.
 * Requires manual review - this module takes no further automatic action. */
export class HistoricalBackfillHardStopError extends Error {
  readonly authUserId: string;
  readonly snapshot: ReconciliationSnapshot;
  constructor(message: string, authUserId: string, snapshot: ReconciliationSnapshot) {
    super(message);
    this.name = "HistoricalBackfillHardStopError";
    this.authUserId = authUserId;
    this.snapshot = snapshot;
  }
}

/** The RPC failed, reconciliation authorized compensation (Branch B), but
 * the compensating deleteUser call itself also failed - the caller is left
 * with a known-orphaned, known-unlinked Auth user id that needs manual
 * cleanup. */
export class HistoricalBackfillCompensationFailedError extends Error {
  readonly authUserId: string;
  constructor(message: string, authUserId: string) {
    super(message);
    this.name = "HistoricalBackfillCompensationFailedError";
    this.authUserId = authUserId;
  }
}

/** The Auth user was created successfully, but the caller's `onAuthCreated`
 * callback (used to durably record the receipt's AUTH_CREATED phase before
 * any further risk is taken) failed. The RPC is never called in this case -
 * see the module doc comment's "crash-recovery ordering" section. The Auth
 * user is deliberately NOT deleted here either: with no durable record of
 * this authUserId anywhere, blindly deleting it on a receipt-write failure
 * would just be a second, less-informed guess - manual reconciliation using
 * the reported authUserId is the correct next step, not an automatic one. */
export class HistoricalBackfillReceiptWriteFailedError extends Error {
  readonly authUserId: string;
  constructor(message: string, authUserId: string) {
    super(message);
    this.name = "HistoricalBackfillReceiptWriteFailedError";
    this.authUserId = authUserId;
  }
}

/** Invoked immediately after `auth.admin.createUser` succeeds, before the
 * Backfill RPC is called - never receives the password, only the resulting
 * `authUserId`. Must durably record that this Auth user now exists (e.g.
 * write the receipt's AUTH_CREATED phase) and only resolve once that write
 * has genuinely succeeded. If it rejects, `runHistoricalBackfillOrchestration`
 * throws `HistoricalBackfillReceiptWriteFailedError` and NEVER calls the
 * RPC - see that error class's own doc comment for why the Auth user is not
 * auto-deleted in that case either. */
export type OnAuthCreated = (authUserId: string) => Promise<void>;

/**
 * Runs the full historical Backfill: create the Owner in Supabase Auth using
 * the caller-supplied, already-delivered temporary password, invoke
 * `onAuthCreated` and require it to succeed BEFORE calling the RPC at all
 * (closes the crash-recovery blind spot where a real Auth user could exist
 * with no durable record of its id), then atomically create the workspace +
 * link the Owner + backfill every legacy row via the
 * `election_day_backfill_historical_workspace` RPC.
 *
 * On any RPC error, performs mandatory read-only reconciliation (see
 * `decideReconciliation`'s doc comment) before taking any further action -
 * never classifies the error itself, never retries, never deletes
 * `election_workspaces`. Throws one of the named error classes above so
 * the caller can react correctly per branch.
 *
 * `supabaseAdmin` must be a client constructed with the service_role key -
 * this function relies on `auth.admin.*` (Admin-API-only) and on being able
 * to call the service_role-only RPC. `readReconciliationSnapshot` must query
 * real, live state - never a cached/assumed value.
 */
export async function runHistoricalBackfillOrchestration(
  supabaseAdmin: SupabaseClient,
  input: HistoricalBackfillInput,
  readReconciliationSnapshot: ReadReconciliationSnapshot,
  onAuthCreated: OnAuthCreated,
): Promise<HistoricalBackfillResult> {
  const { data: createdUser, error: createUserError } =
    await supabaseAdmin.auth.admin.createUser({
      email: input.ownerEmail,
      password: input.ownerTemporaryPassword,
      email_confirm: true,
      user_metadata: { full_name: input.ownerName },
    });

  if (createUserError || !createdUser?.user) {
    throw new HistoricalBackfillAuthCreateFailedError(
      `AUTH_CREATE_FAILED: ${createUserError?.message ?? "no user returned"}`,
    );
  }

  const authUserId = createdUser.user.id;

  try {
    await onAuthCreated(authUserId);
  } catch (receiptErr) {
    throw new HistoricalBackfillReceiptWriteFailedError(
      `AUTH_CREATED_RECEIPT_WRITE_FAILED: the Auth user was created (id ${authUserId}) but durably recording that fact failed, so the Backfill RPC was NOT invoked: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}. This Auth user was NOT deleted automatically - manual reconciliation using this exact authUserId is required.`,
      authUserId,
    );
  }

  const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
    "election_day_backfill_historical_workspace",
    {
      p_auth_user_id: authUserId,
      p_workspace_name: input.workspaceName,
      p_election_end_at: input.electionEndAtIso,
      p_owner_name: input.ownerName,
      p_owner_phone: input.ownerPhone,
      p_owner_email: input.ownerEmail,
    },
  );

  if (rpcError) {
    const snapshot = await readReconciliationSnapshot(authUserId);
    const decision = decideReconciliation(snapshot, {
      workspaceName: input.workspaceName,
      electionEndAtIso: input.electionEndAtIso,
    });

    if (decision.branch === "A") {
      throw new HistoricalBackfillAmbiguousLikelySuccessError(
        `AMBIGUOUS_RPC_OUTCOME_LIKELY_COMMITTED: ${decision.reason} (original RPC error: ${rpcError.message})`,
        authUserId,
        snapshot,
      );
    }

    if (decision.branch === "C") {
      throw new HistoricalBackfillHardStopError(
        `AMBIGUOUS_RPC_OUTCOME_HARD_STOP: ${decision.reason} (original RPC error: ${rpcError.message})`,
        authUserId,
        snapshot,
      );
    }

    // Branch B - proven safe: no application-level reference anywhere, and
    // election_workspaces itself is empty.
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (deleteError) {
      throw new HistoricalBackfillCompensationFailedError(
        `BACKFILL_RPC_FAILED (${rpcError.message}) | COMPENSATION_FAILED: could not delete orphaned auth user ${authUserId}: ${deleteError.message}`,
        authUserId,
      );
    }
    throw new HistoricalBackfillCompensatedError(
      `BACKFILL_RPC_FAILED: ${rpcError.message} (auth user ${authUserId} safely compensated - reconciliation proved zero application-level linkage before deletion)`,
      authUserId,
    );
  }

  const result = rpcResult as {
    workspace_id: string;
    owner_id: string;
    row_counts: Record<string, number>;
  };

  return {
    authUserId,
    workspaceId: result.workspace_id,
    ownerId: result.owner_id,
    rowCounts: result.row_counts,
  };
}
