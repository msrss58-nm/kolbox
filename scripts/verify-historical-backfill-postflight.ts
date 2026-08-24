#!/usr/bin/env node
/**
 * Multi-Tenant Phase 2 - historical Backfill post-flight verifier.
 *
 * Read-only. Needs no service_role key, no JS Admin client, no TTY - every
 * check (including "does the Auth user exist") goes through the same
 * credential-safe `supabase db query --linked` channel as pre-flight, since
 * `auth.users` existence is checked directly via SQL rather than the Admin
 * API. Safe to run from any automated context, including Claude Code.
 *
 * Usage: npx esbuild scripts/verify-historical-backfill-postflight.ts --bundle --format=cjs --platform=node --outfile=scripts/verify-historical-backfill-postflight.cjs && node scripts/verify-historical-backfill-postflight.cjs <runId>
 *
 * Consumes the exact receipt written by the run being verified - every
 * comparison is against THAT run's own fresh pre-flight baseline, never a
 * number from any other run or planning document. Mutates nothing except
 * the receipt's own `phase` field, and only advances it to
 * POSTFLIGHT_VERIFIED once every check has passed.
 */
import { requireProductionIdentityMatch } from "./lib/productionIdentity";
import { sqlQueryLinked } from "./lib/supabaseCliQuery";
import { runPostflightVerification } from "./lib/backfillPostflight";
import { markPostflightVerified, readReceipt } from "./lib/backfillReceipt";
import {
  WORKSPACE_NAME,
  ELECTION_END_AT_ISO,
  OWNER_NAME,
  OWNER_PHONE,
  OWNER_EMAIL,
  assertReceiptMatchesApprovedTarget,
} from "./lib/backfillTarget";
import { join } from "node:path";

const SUPABASE_DIR = join(__dirname, "..", "supabase");

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: node verify-historical-backfill-postflight.cjs <runId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (supabaseUrl) {
    try {
      requireProductionIdentityMatch(supabaseUrl, SUPABASE_DIR);
    } catch (err) {
      console.error("Production target identity gate FAILED:");
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    console.log(
      "(SUPABASE_URL not set - skipping the SUPABASE_URL-vs-CLI identity cross-check; the CLI's own `--linked` target is still what every query below uses.)",
    );
  }

  const receipt = readReceipt(runId);
  // Hard stop BEFORE any live query - a receipt whose target metadata
  // doesn't exactly match the fixed approved target (backfillTarget.ts) is
  // refused outright, never partially trusted. Covers productionProjectRef
  // too (superseding the narrower standalone check this used to be).
  try {
    assertReceiptMatchesApprovedTarget(receipt);
  } catch (err) {
    console.error("HARD STOP - receipt target metadata mismatch.");
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "The receipt is NEVER treated as authority on its own - no live query was performed.",
    );
    process.exit(1);
  }
  if (receipt.phase !== "RPC_CONFIRMED" && receipt.phase !== "POSTFLIGHT_VERIFIED") {
    console.error(
      `Receipt phase is "${receipt.phase}" - post-flight requires RPC_CONFIRMED (a confirmed successful RPC response). If the outcome is ambiguous, run recover-historical-backfill.ts first.`,
    );
    process.exit(1);
  }
  if (!receipt.authUserId || !receipt.rpcResult) {
    console.error(
      "Receipt is missing authUserId or rpcResult despite its phase - refusing to verify a malformed receipt.",
    );
    process.exit(1);
  }

  console.log(`Verifying runId ${runId} (workspace "${WORKSPACE_NAME}")...`);
  // Expected workspace/Owner identity comes from the fixed backfillTarget.ts
  // constants, NOT from the receipt - see assertReceiptMatchesApprovedTarget
  // above. Only genuinely run-specific evidence (authUserId, this run's own
  // fresh pre-flight baseline/RPC-ACL snapshot) still comes from the receipt.
  const result = await runPostflightVerification(sqlQueryLinked, {
    workspaceName: WORKSPACE_NAME,
    electionEndAtIso: ELECTION_END_AT_ISO,
    ownerName: OWNER_NAME,
    ownerPhone: OWNER_PHONE,
    ownerEmail: OWNER_EMAIL,
    authUserId: receipt.authUserId,
    tableBaseline: receipt.preflight.tableBaseline,
    expectedRpcAcl: receipt.preflight.rpcAcl,
  });

  if (!result.ok) {
    console.error("POST-FLIGHT FAILED:");
    for (const p of result.problems) console.error(` - ${p}`);
    console.error(
      "\nReceipt phase NOT advanced. Do not accept this Backfill as verified.",
    );
    process.exit(1);
  }

  markPostflightVerified(receipt);
  console.log(
    "POST-FLIGHT PASSED - every check matched the receipt's own baseline. Receipt phase advanced to POSTFLIGHT_VERIFIED.",
  );
  console.log(
    "Note: Git/protected-script state is unrelated to this DB-only verification - check that separately (SHA-256 baseline) if relevant.",
  );
}

main().catch((err) => {
  console.error("Unexpected failure:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
