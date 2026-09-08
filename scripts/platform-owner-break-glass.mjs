/**
 * Platform Owner Program - Stage 2: OPERATOR-ONLY break-glass MFA recovery.
 *
 * For the one case the design must survive: the singleton Platform Owner has
 * lost their TOTP device and can no longer reach aal2, so no privileged
 * Platform Owner request can ever succeed again.
 *
 * Deliberate properties:
 *   - LOCAL SCRIPT ONLY. There is no HTTP route, no "recovery" endpoint, and
 *     no reachable-from-the-internet path. Running it requires possession of
 *     the service-role key on the operator's own machine.
 *   - NO PERMANENT BYPASS. It does not disable MFA, does not lower the aal2
 *     requirement, and does not mint a long-lived escape hatch. It deletes the
 *     enrolled factor(s), which drops the Owner back to aal1 - and the guard
 *     then forces a FRESH TOTP enrolment before the console is reachable
 *     again. The aal2 requirement is never weakened, for anyone, at any point.
 *   - AUDITED. Every run that mutates writes a durable
 *     platform_owner_recovery_audit row via a service_role-only RPC.
 *   - NO SECRETS ANYWHERE. Factor IDs only. Never a TOTP secret, never a key,
 *     never a password - not in the audit row, not in stdout.
 *
 * Usage:
 *   node scripts/platform-owner-break-glass.mjs --reason="lost device"
 *     -> DRY RUN (default): reports what it would delete, mutates nothing.
 *   ... --confirm                 -> actually deletes the factor(s).
 *   ... --confirm --allow-production -> required to target Production at all.
 *
 * Exit codes: 0 ok / 1 refused or failed. (Set via `process.exitCode` and a
 * normal return - never `process.exit()`, which races undici's keep-alive
 * sockets on Windows and aborts with a libuv assertion, destroying the very
 * exit code this contract promises.)
 */
import { userInfo } from "node:os";
import {
  getOperatorClient,
  maskEmail,
  parseArgs,
  readSingletonPlatformOwner,
} from "./lib/platformOwnerOps.mjs";

function fail(msg) {
  console.error(`FAILED: ${msg}`);
  return 1;
}

async function main() {
  const { flags, values } = parseArgs(process.argv);
  const dryRun = !flags.has("confirm");
  const allowProduction = flags.has("allow-production");
  const reason = (values.reason ?? "").trim();

  if (!reason) {
    return fail(
      '--reason="why this recovery is being performed" is required (it is recorded in the audit).',
    );
  }

  let ctx;
  try {
    ctx = getOperatorClient({ allowProduction });
  } catch (e) {
    return fail(e.message);
  }
  const { client, projectRef, isProduction } = ctx;

  const performedBy = (() => {
    try {
      return userInfo().username || "unknown";
    } catch {
      return "unknown";
    }
  })();

  console.log("=== Platform Owner break-glass MFA recovery ===");
  console.log(`mode:         ${dryRun ? "DRY RUN (no mutation)" : "APPLY"}`);
  console.log(`project ref:  ${projectRef}${isProduction ? "  [PRODUCTION]" : ""}`);
  console.log(`performed by: ${performedBy}`);
  console.log(`reason:       ${reason}`);

  // --- Identify the singleton Platform Owner --------------------------------
  let owner;
  try {
    owner = await readSingletonPlatformOwner(client);
  } catch (e) {
    return fail(e.message);
  }
  if (!owner) {
    return fail(
      "no Platform Owner exists - there is nothing to recover. Use platform-owner-bootstrap.mjs first.",
    );
  }

  console.log("");
  console.log(`platform_owner_id: ${owner.id}`);
  console.log(`auth_user_id:      ${owner.auth_user_id}`);
  console.log(`email:             ${maskEmail(owner.email)}`);

  // --- Enumerate enrolled factors (IDs only, never secrets) ------------------
  const { data: factorData, error: factorErr } = await client.auth.admin.mfa.listFactors({
    userId: owner.auth_user_id,
  });
  if (factorErr) return fail(`could not list MFA factors: ${factorErr.message}`);

  const factors = factorData?.factors ?? [];
  console.log("");
  console.log(`enrolled factors: ${factors.length}`);
  for (const f of factors) {
    console.log(`  - id=${f.id} type=${f.factor_type} status=${f.status}`);
  }

  if (factors.length === 0) {
    console.log("");
    console.log(
      "Nothing to delete: the Owner has no enrolled factor, so they are already required to enrol on next login.",
    );
    return 0;
  }

  if (dryRun) {
    console.log("");
    console.log("DRY RUN complete. No factor was deleted and no audit row was written.");
    console.log("Re-run with --confirm to perform the recovery.");
    return 0;
  }

  // --- Delete the factor(s) --------------------------------------------------
  const deleted = [];
  for (const f of factors) {
    const { error } = await client.auth.admin.mfa.deleteFactor({
      id: f.id,
      userId: owner.auth_user_id,
    });
    if (error) {
      console.error(`  FAILED to delete factor ${f.id}: ${error.message}`);
      continue;
    }
    deleted.push(f.id);
    console.log(`  deleted factor ${f.id}`);
  }

  if (deleted.length === 0) {
    return fail(
      "no factor could be deleted - the Owner is still locked out. Investigate before retrying.",
    );
  }

  // --- Durable audit (factor IDs only) --------------------------------------
  const { data: auditId, error: auditErr } = await client.rpc(
    "platform_record_recovery_audit",
    {
      p_platform_owner_id: owner.id,
      p_auth_user_id: owner.auth_user_id,
      p_factor_ids: deleted,
      p_reason: reason,
      p_performed_by: performedBy,
    },
  );

  if (auditErr) {
    console.error("");
    console.error(
      `WARNING: factor(s) were deleted but the audit row FAILED to write: ${auditErr.message}`,
    );
    console.error(
      "This is a reportable condition - record the recovery manually and investigate the RPC.",
    );
    return 1;
  }

  console.log("");
  console.log(`audit row written: ${auditId}`);
  console.log("");
  console.log("Recovery complete.");
  console.log("The Owner is now at aal1 with no enrolled factor. On next login the");
  console.log("guard requires a FRESH TOTP enrolment before the console is reachable.");
  console.log("No permanent bypass was created and the aal2 requirement is unchanged.");
  return 0;
}

process.exitCode = await main();
