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
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

export interface HistoricalBackfillInput {
  workspaceName: string;
  electionEndAtIso: string;
  ownerName: string;
  ownerPhone: string | null;
  ownerEmail: string;
}

export interface HistoricalBackfillResult {
  authUserId: string;
  workspaceId: string;
  ownerId: string;
  rowCounts: Record<string, number>;
  /** Present exactly once, in-memory only - the caller is responsible for
   * relaying it to the Platform Owner exactly once and never
   * persisting/logging it. This orchestration function itself never writes
   * it anywhere. */
  temporaryPassword: string;
}

function generateTemporaryPassword(): string {
  // 32 random bytes -> 43-char base64url string: well above any reasonable
  // strength floor, generated fresh per execution, never derived from
  // anything persisted or guessable.
  return randomBytes(32).toString("base64url");
}

/**
 * Runs the full historical Backfill: create the Owner in Supabase Auth,
 * then atomically create the workspace + link the Owner + backfill every
 * legacy row via the `election_day_backfill_historical_workspace` RPC. If
 * the RPC call fails for any reason (including the idempotency guard
 * rejecting a duplicate attempt), the just-created Auth user is deleted as
 * compensation before the error is re-thrown - the DB and Auth stay
 * consistent even on a failed/retried run.
 *
 * `supabaseAdmin` must be a client constructed with the service_role key -
 * this function relies on `auth.admin.*` (Admin-API-only) and on being able
 * to call the service_role-only RPC.
 */
export async function runHistoricalBackfillOrchestration(
  supabaseAdmin: SupabaseClient,
  input: HistoricalBackfillInput,
): Promise<HistoricalBackfillResult> {
  const temporaryPassword = generateTemporaryPassword();

  const { data: createdUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
    email: input.ownerEmail,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { full_name: input.ownerName },
  });

  if (createUserError || !createdUser?.user) {
    throw new Error(`AUTH_CREATE_FAILED: ${createUserError?.message ?? "no user returned"}`);
  }

  const authUserId = createdUser.user.id;

  try {
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc("election_day_backfill_historical_workspace", {
      p_auth_user_id: authUserId,
      p_workspace_name: input.workspaceName,
      p_election_end_at: input.electionEndAtIso,
      p_owner_name: input.ownerName,
      p_owner_phone: input.ownerPhone,
      p_owner_email: input.ownerEmail,
    });

    if (rpcError) {
      throw new Error(`BACKFILL_RPC_FAILED: ${rpcError.message}`);
    }

    const result = rpcResult as { workspace_id: string; owner_id: string; row_counts: Record<string, number> };

    return {
      authUserId,
      workspaceId: result.workspace_id,
      ownerId: result.owner_id,
      rowCounts: result.row_counts,
      temporaryPassword,
    };
  } catch (err) {
    // Compensation: the DB transaction never committed (the RPC's own
    // function body is one implicit transaction), so the Auth user created
    // above is now orphaned - delete it so a retry starts clean and no
    // unlinked Auth account is left behind.
    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(authUserId);
    if (deleteError) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} | COMPENSATION_FAILED: could not delete orphaned auth user ${authUserId}: ${deleteError.message}`,
      );
    }
    throw err;
  }
}
