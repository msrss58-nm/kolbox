#!/usr/bin/env node
/**
 * Multi-Tenant Phase 2 - historical Backfill process-death recovery report.
 *
 * STRICTLY READ-ONLY. This file contains no reference to
 * `auth.admin.deleteUser`, no `createClient`, no Supabase Admin API call of
 * any kind, and needs no service_role key or TTY - every check goes through
 * the same credential-safe `supabase db query --linked` channel as
 * pre-flight/post-flight. Its only job is to: validate Production identity,
 * read/validate the receipt, independently query Production for the fixed
 * approved Owner identity (never trusting the receipt's claims at face
 * value - see lib/backfillRecovery.ts's own doc comment), perform fresh
 * live reconciliation, classify the state, and print the safe recommended
 * MANUAL next action. It never decides or performs any mutation itself.
 *
 * Any future Auth deletion is a separate, explicitly-authorized manual
 * action (e.g. via the Supabase Dashboard, or a dedicated, separately
 * reviewed script) taken by a human after reading this report - not
 * something this tool offers or gates behind a prompt.
 *
 * Usage: npx esbuild scripts/recover-historical-backfill.ts --bundle --format=cjs --platform=node --outfile=scripts/recover-historical-backfill.cjs && node scripts/recover-historical-backfill.cjs <runId>
 */
import { join } from "node:path";
import {
  APPROVED_PRODUCTION_PROJECT_REF,
  requireProductionIdentityMatch,
} from "./lib/productionIdentity";
import { sqlQueryLinked } from "./lib/supabaseCliQuery";
import { makeReconciliationSnapshotReader } from "./lib/backfillReconciliationRead";
import { readReceipt } from "./lib/backfillReceipt";
import { evaluateRecovery } from "./lib/backfillRecovery";

const SUPABASE_DIR = join(__dirname, "..", "supabase");

async function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error("usage: node recover-historical-backfill.cjs <runId>");
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    console.error(
      "SUPABASE_URL is required (used only for the identity cross-check - this tool never mutates and never needs a service_role key).",
    );
    process.exit(1);
  }
  try {
    requireProductionIdentityMatch(supabaseUrl, SUPABASE_DIR);
  } catch (err) {
    console.error("Production target identity gate FAILED - hard stop:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  let receipt;
  try {
    receipt = readReceipt(runId);
  } catch (err) {
    console.error("No valid receipt - HARD STOP, refusing to guess:");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (receipt.productionProjectRef !== APPROVED_PRODUCTION_PROJECT_REF) {
    console.error(
      `Receipt's productionProjectRef "${receipt.productionProjectRef}" does not match the approved ref - refusing to act.`,
    );
    process.exit(1);
  }

  const readReconciliationSnapshot = makeReconciliationSnapshotReader(sqlQueryLinked);
  const verdict = await evaluateRecovery({
    receipt,
    sqlQueryOne: sqlQueryLinked,
    readReconciliationSnapshot,
  });

  switch (verdict.kind) {
    case "ALREADY_CONFIRMED":
      console.log(
        `Receipt phase is already ${verdict.phase} - the RPC outcome is already known and confirmed. Run the post-flight verifier if you have not already, not this tool.`,
      );
      return;

    case "MALFORMED_RECEIPT_HARD_STOP":
      console.error(`HARD STOP - ${verdict.reason}`);
      process.exit(1);
      return;

    case "TARGET_METADATA_MISMATCH_HARD_STOP":
      console.error(`HARD STOP - receipt target metadata mismatch.\n${verdict.reason}`);
      console.error(
        "The receipt is NEVER treated as authority on its own - a receipt whose target metadata doesn't exactly match the fixed approved target (backfillTarget.ts) is refused outright, no live query was performed.",
      );
      process.exit(1);
      return;

    case "NOTHING_CREATED":
      console.log(
        "Nothing to recover: live Production independently confirms no Auth user, no workspace, and no identity-table linkage exist for the approved Owner email. This run's receipt (PREFLIGHT_CONFIRMED) matches reality.",
      );
      return;

    case "PREFLIGHT_HARD_STOP":
      console.error(
        `HARD STOP - live Production state contradicts a receipt that shows nothing was ever created.\n${verdict.reason}`,
      );
      console.error(
        "Manual investigation required before any further action of any kind.",
      );
      process.exit(1);
      return;

    case "IDENTITY_MISMATCH_HARD_STOP":
      console.error(
        `HARD STOP - the receipt and live Production disagree on Auth identity.\n${verdict.reason}`,
      );
      console.error(
        "The receipt is NEVER treated as authority on its own - this disagreement requires manual investigation, not a guess in either direction.",
      );
      process.exit(1);
      return;

    case "BRANCH_A_LIKELY_COMMITTED":
      console.log(
        `Branch A - likely committed. Live Auth user ${verdict.authUserId} (independently confirmed against the approved Owner email) is already correctly linked to the expected workspace.`,
      );
      console.log(`Reason: ${verdict.decision.reason}`);
      console.log(
        "NO action recommended here beyond running the post-flight verifier next to confirm. Never rerun the Backfill RPC.",
      );
      return;

    case "BRANCH_B_ORPHAN_CANDIDATE":
      console.log(
        `ORPHAN AUTH USER - SAFE CANDIDATE FOR SEPARATELY AUTHORIZED MANUAL CLEANUP`,
      );
      console.log(
        `Auth user id (independently confirmed against the approved Owner email): ${verdict.authUserId}`,
      );
      console.log(`Reason: ${verdict.decision.reason}`);
      console.log(JSON.stringify(verdict.snapshot, null, 2));
      console.log(
        "This tool does NOT delete it. Deletion, if desired, is a separate, explicitly-authorized manual action after independent reviewer inspection.",
      );
      return;

    case "BRANCH_C_HARD_STOP":
      console.error(
        `HARD STOP - contradictory/uncertain reconciliation state for Auth user ${verdict.authUserId} (independently confirmed against the approved Owner email).`,
      );
      console.error(`Reason: ${verdict.decision.reason}`);
      console.error(JSON.stringify(verdict.snapshot, null, 2));
      console.error(
        "No deletion, no retry, no workspace deletion. Manual review required beyond this report.",
      );
      process.exit(1);
      return;
  }
}

main().catch((err) => {
  console.error("Unexpected failure:");
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
