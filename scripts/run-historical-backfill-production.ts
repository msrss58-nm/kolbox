#!/usr/bin/env node
/**
 * Multi-Tenant Phase 2 - ONE-TIME historical Production Backfill runner.
 *
 * HUMAN-RUN ONLY. Never invoke this from Claude Code, a CI job, or any other
 * automated/tool-captured process. It displays a real temporary Auth
 * password to its own stdout exactly once, before any mutation -
 * `refuseUnlessRealTty()` enforces this mechanically.
 *
 * Run with: npx esbuild scripts/run-historical-backfill-production.ts --bundle --format=cjs --platform=node --outfile=scripts/run-historical-backfill-production.cjs && node scripts/run-historical-backfill-production.cjs
 *
 * Required environment variables (read by this script only, never printed):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY - both Production values, set in
 *   the operator's own shell. Never read from `.env*` by this file.
 *
 * Requires the Supabase CLI to already be linked to Production - both the
 * env target and the CLI's own linked project are independently proven to
 * be the exact same, approved project before anything else happens (see
 * lib/productionIdentity.ts).
 *
 * ============================================================================
 * FLOW
 * ============================================================================
 * 1. Refuse unless a real interactive TTY.
 * 2. HARD GATE: prove SUPABASE_URL ref == CLI-linked ref ==
 *    APPROVED_PRODUCTION_PROJECT_REF. Any mismatch/inability to prove it
 *    stops here - before password generation, before any prompt.
 * 3. Require the operator to type the workspace name (`מודיעין`) exactly.
 * 4. Run the COMPLETE pre-flight (identity across all 5 tables, workspace/
 *    owner counts, all 12 tables' fresh baseline, settings shape, RPC ACL,
 *    migration sync). Any failure stops here - still before the password is
 *    even generated.
 * 5. Write the crash-recovery receipt (PREFLIGHT_CONFIRMED) - non-secret
 *    metadata only, in the OS temp dir. Print its runId so the operator can
 *    find it later if needed.
 * 6. Generate the temporary password, display it exactly once, require the
 *    operator to type exactly `SAVED`. Any other input terminates
 *    immediately - zero Auth/DB action.
 * 7. Create the Auth user, update the receipt to AUTH_CREATED (authUserId
 *    only - never the password).
 * 8. Invoke the Backfill RPC. On success, update the receipt to
 *    RPC_CONFIRMED. On any error, the orchestration itself performs
 *    mandatory reconciliation - this script only reacts to which of the 5
 *    named outcomes it receives; it never retries and never deletes
 *    `election_workspaces`.
 * 9. On success, print ONLY non-secret ids/counts and the runId for the
 *    post-flight verifier - the password was already delivered in step 6.
 *
 * Every phase before the final `try` block (identity gate, prompts,
 * pre-flight) is itself wrapped so any unexpected failure - EOF, a CLI
 * error, malformed output - fails closed with a clear message and exit
 * code, never an unmutated but noisy crash and never a silent hang.
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import {
  generateOwnerTemporaryPassword,
  HistoricalBackfillAmbiguousLikelySuccessError,
  HistoricalBackfillAuthCreateFailedError,
  HistoricalBackfillCompensatedError,
  HistoricalBackfillCompensationFailedError,
  HistoricalBackfillHardStopError,
  HistoricalBackfillReceiptWriteFailedError,
  runHistoricalBackfillOrchestration,
} from "./lib/historicalBackfillOrchestration";
import {
  APPROVED_PRODUCTION_PROJECT_REF,
  requireProductionIdentityMatch,
} from "./lib/productionIdentity";
import { runFullPreflight } from "./lib/backfillPreflight";
import { sqlQueryLinked, checkMigrationsInSyncLinked } from "./lib/supabaseCliQuery";
import { makeReconciliationSnapshotReader } from "./lib/backfillReconciliationRead";
import {
  createReceipt,
  generateRunId,
  markAuthCreated,
  markRpcConfirmed,
} from "./lib/backfillReceipt";
import {
  ELECTION_END_AT_ISO,
  OWNER_EMAIL,
  OWNER_NAME,
  OWNER_PHONE,
  TABLES,
  WORKSPACE_NAME,
} from "./lib/backfillTarget";

const SUPABASE_DIR = join(__dirname, "..", "supabase");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing required environment variable: ${name}. Set it in your own shell before running this script - its value is never read or printed by this file itself.`,
    );
    process.exit(1);
  }
  return v;
}

function refuseUnlessRealTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "Refusing to run: this script must be executed directly in a real interactive terminal - " +
        "not piped, not captured, not invoked by Claude Code, CI, or any other automated tool. " +
        "It displays a real temporary Auth password to stdout exactly once before any mutation; " +
        "that must never happen inside any tool-captured or logged output.",
    );
    process.exit(1);
  }
}

/** Every phase before the mutation `try` block runs through this - any
 * thrown error (EOF, CLI failure, malformed output, identity mismatch)
 * fails closed with the given label and a non-zero exit, never a silent
 * hang or an unhandled-rejection crash. Nothing has mutated anything by the
 * time any of these can fail. */
async function failClosed<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`\n${label} FAILED - aborting before any mutation:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function promptExact(
  rl: ReturnType<typeof createInterface>,
  question: string,
  expected: string,
): Promise<boolean> {
  const answer = await rl.question(question);
  return answer.trim() === expected;
}

async function main() {
  refuseUnlessRealTty();

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  await failClosed("Production target identity gate", () => {
    const { urlRef, cliRef } = requireProductionIdentityMatch(supabaseUrl, SUPABASE_DIR);
    console.log(
      `Production target identity confirmed: SUPABASE_URL ref = CLI-linked ref = "${urlRef}"/"${cliRef}" = approved ref "${APPROVED_PRODUCTION_PROJECT_REF}".`,
    );
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("============================================================");
  console.log("KolBox - ONE-TIME Historical Production Backfill");
  console.log(
    `Target project: ${supabaseUrl} (${APPROVED_PRODUCTION_PROJECT_REF}) - PRODUCTION`,
  );
  console.log(`Workspace to create: ${WORKSPACE_NAME}`);
  console.log(`Election end (UTC): ${ELECTION_END_AT_ISO}`);
  console.log(`Owner: ${OWNER_NAME} / ${OWNER_PHONE} / ${OWNER_EMAIL}`);
  console.log("============================================================");

  const workspaceConfirmed = await failClosed("Workspace-name confirmation prompt", () =>
    promptExact(
      rl,
      `Type the workspace name exactly to confirm you intend to target PRODUCTION (${WORKSPACE_NAME}): `,
      WORKSPACE_NAME,
    ),
  );
  if (!workspaceConfirmed) {
    console.error(
      "Workspace name confirmation did not match exactly. Aborting - no action taken.",
    );
    rl.close();
    process.exit(1);
  }

  console.log(
    "\nRunning complete pre-flight (identity, workspace/owner counts, all 12 tables, settings, RPC ACL, migration sync)...",
  );
  const preflight = await failClosed("Pre-flight", () =>
    runFullPreflight({
      sqlQueryOne: sqlQueryLinked,
      ownerEmail: OWNER_EMAIL,
      tables: TABLES,
      checkMigrations: async () => checkMigrationsInSyncLinked(),
    }),
  );
  if (!preflight.ok) {
    console.error(
      "Pre-flight FAILED - aborting before any mutation, before password generation:",
    );
    for (const p of preflight.problems) console.error(` - ${p}`);
    rl.close();
    process.exit(1);
  }
  console.log("Pre-flight OK.");
  if (preflight.migrationsInSync === null)
    console.log(
      "(Migration sync could not be independently verified in this environment - not blocking, but noted.)",
    );

  const runId = generateRunId();
  let currentReceipt = await failClosed("Receipt creation", () =>
    createReceipt({
      runId,
      productionProjectRef: APPROVED_PRODUCTION_PROJECT_REF,
      workspaceName: WORKSPACE_NAME,
      electionEndAtIso: ELECTION_END_AT_ISO,
      ownerName: OWNER_NAME,
      ownerPhone: OWNER_PHONE,
      ownerEmail: OWNER_EMAIL,
      preflight: {
        tableBaseline: preflight.tableBaseline,
        settingsOk: preflight.settingsOk,
        migrationsInSync: preflight.migrationsInSync,
        rpcAcl: preflight.rpcAcl,
      },
    }),
  );
  console.log(
    `Receipt written (PREFLIGHT_CONFIRMED), runId = ${runId}. Keep this runId - it is needed for post-flight verification or recovery.`,
  );

  const password = generateOwnerTemporaryPassword();
  console.log("\n--- TEMPORARY OWNER PASSWORD (shown exactly once, never repeated) ---");
  console.log(password);
  console.log(
    "--- Copy this now. It will not be shown again by this script or any other tool. ---\n",
  );

  const saved = await failClosed("SAVED confirmation prompt", () =>
    promptExact(
      rl,
      'Type exactly "SAVED" once you have securely captured the password above: ',
      "SAVED",
    ),
  );
  if (!saved) {
    console.error(
      "Confirmation not received. Terminating immediately - no Auth user created, no database mutation, no RPC call.",
    );
    rl.close();
    process.exit(1);
  }

  rl.close();

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const readReconciliationSnapshot = makeReconciliationSnapshotReader(sqlQueryLinked);

  console.log("\nProceeding with Auth creation + Backfill RPC...");
  try {
    const result = await runHistoricalBackfillOrchestration(
      admin,
      {
        workspaceName: WORKSPACE_NAME,
        electionEndAtIso: ELECTION_END_AT_ISO,
        ownerName: OWNER_NAME,
        ownerPhone: OWNER_PHONE,
        ownerEmail: OWNER_EMAIL,
        ownerTemporaryPassword: password,
      },
      readReconciliationSnapshot,
      // Invoked by the orchestration immediately after createUser succeeds,
      // BEFORE the RPC is called - the receipt reaches AUTH_CREATED at the
      // real moment it happens, not after the fact, closing the crash-
      // recovery blind spot a prior review found. If this write itself
      // fails, it rejects, and the orchestration never calls the RPC.
      async (authUserId) => {
        currentReceipt = markAuthCreated(currentReceipt, authUserId);
      },
    );

    // currentReceipt is already AUTH_CREATED (written synchronously via the
    // callback above, before the RPC ever ran) - only RPC_CONFIRMED remains.
    try {
      markRpcConfirmed(currentReceipt, {
        workspaceId: result.workspaceId,
        ownerId: result.ownerId,
        rowCounts: result.rowCounts,
      });
    } catch (receiptErr) {
      console.error(
        `(non-fatal) Could not mark the receipt RPC_CONFIRMED after a genuine success: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}. The Backfill itself succeeded regardless - use runId ${runId} with the post-flight verifier.`,
      );
    }

    console.log(
      "\n=== SUCCESS (non-secret result only - the password was already shown above and is not repeated) ===",
    );
    console.log(
      JSON.stringify(
        {
          runId,
          workspaceId: result.workspaceId,
          ownerId: result.ownerId,
          authUserId: result.authUserId,
          rowCounts: result.rowCounts,
        },
        null,
        2,
      ),
    );
    console.log(
      `\nRun scripts/verify-historical-backfill-postflight.ts ${runId} next, before considering the Backfill accepted.`,
    );
  } catch (err) {
    if (err instanceof HistoricalBackfillAuthCreateFailedError) {
      console.error(
        "\nAuth user creation failed. Nothing was mutated. The password shown above was never attached to any account - discard it; a retry must generate a fresh one.",
      );
      console.error(err.message);
    } else if (err instanceof HistoricalBackfillReceiptWriteFailedError) {
      console.error(
        "\nThe Auth user was created, but durably recording that fact (the receipt's AUTH_CREATED write) failed - the RPC was NEVER called, and this Auth user was NOT auto-deleted.",
      );
      console.error(
        `Auth user id (exists, unrecorded, unlinked to anything): ${err.authUserId}`,
      );
      console.error(err.message);
      console.error(
        `Manual reconciliation of this exact authUserId is required - it is not discoverable via runId ${runId}'s own receipt, since the write that would have recorded it is what failed. Do not retry automatically.`,
      );
    } else if (err instanceof HistoricalBackfillCompensatedError) {
      console.error(
        "\nThe Backfill RPC failed. Reconciliation proved zero application-level linkage and an empty election_workspaces, so the orphaned Auth user was safely deleted.",
      );
      console.error(`Auth user id (now deleted): ${err.authUserId}`);
      console.error(err.message);
      console.error(
        `Receipt runId ${runId} reflects AUTH_CREATED for this now-cleaned-up attempt. A retry, if desired, is a separate decision with a fresh password and a fresh run.`,
      );
    } else if (err instanceof HistoricalBackfillAmbiguousLikelySuccessError) {
      console.error(
        "\nAMBIGUOUS OUTCOME - LIKELY COMMITTED. Reconciliation found this exact Auth user already correctly linked to the expected workspace.",
      );
      console.error(`Auth user id: ${err.authUserId}`);
      console.error(err.message);
      console.error(
        `NO automatic action was taken. Run: scripts/recover-historical-backfill.ts ${runId} to reconcile deterministically, or scripts/verify-historical-backfill-postflight.ts ${runId} if you believe this is a real success.`,
      );
    } else if (err instanceof HistoricalBackfillHardStopError) {
      console.error(
        "\nHARD STOP - contradictory/uncertain reconciliation state. NO automatic action was taken.",
      );
      console.error(`Auth user id: ${err.authUserId}`);
      console.error(err.message);
      console.error(
        `Manual review required. Run: scripts/recover-historical-backfill.ts ${runId} for a deterministic read-only report. Do not retry. Do not delete anything, including the workspace.`,
      );
    } else if (err instanceof HistoricalBackfillCompensationFailedError) {
      console.error(
        "\nThe Backfill RPC failed AND the safe compensating deleteUser call itself also failed.",
      );
      console.error(`Auth user id (orphaned, still exists): ${err.authUserId}`);
      console.error(err.message);
      console.error(
        `Manual cleanup of this specific Auth user id is required. Run: scripts/recover-historical-backfill.ts ${runId}. Do not retry automatically.`,
      );
    } else {
      console.error("\nUnexpected error (not one of the named orchestration outcomes):");
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\nUnexpected top-level failure:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
