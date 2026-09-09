/**
 * OPERATOR-ONLY: regenerate a one-time recovery / password-set link for the
 * Platform Owner that ALREADY EXISTS.
 *
 * WHY THIS IS A SEPARATE SCRIPT (not a flag on platform-owner-bootstrap.mjs)
 * -------------------------------------------------------------------------
 * `platform-owner-bootstrap.mjs` REFUSES to run once a Platform Owner exists,
 * and that refusal is a safety property worth keeping absolute. Adding a
 * "...unless --regenerate" escape hatch would put first-time provisioning and
 * the existing-owner path on a shared code path that CAN create a user - one
 * bad flag away from a second identity. This script instead has no ability to
 * create anything: it never calls `auth.admin.createUser`, never INSERTs into
 * `platform_owners`, and never UPDATEs a row. It can only read the existing
 * owner and ask GoTrue for a fresh link. `platform-owner-break-glass.mjs` set
 * the same precedent for existing-owner operations.
 *
 * WHAT IT DOES
 *   1. Loads the singleton `platform_owners` row - refuses if none exists, and
 *      `readSingletonPlatformOwner` itself throws if more than one somehow does.
 *   2. Loads the mapped `auth.users` row by id and requires it to exist.
 *   3. Requires --email and requires it to match BOTH the platform_owners row
 *      and the mapped auth user, case-insensitively. A mismatch fails closed:
 *      this is what stops a link being minted for the wrong identity.
 *   4. Asks GoTrue for a fresh recovery link and writes it - and only it - to a
 *      new temp file outside the repository.
 *
 * WHAT IT NEVER DOES
 *   No user creation, no platform_owners insert/update, no name/phone/mapping
 *   change, no password change, no MFA enrolment or unenrolment, no ACL/RLS or
 *   schema change, and nothing at all to the Election Owner. It prints no link,
 *   no token, no password and no key - only a masked email and a file path.
 *
 * SAFETY GATES
 *   Dry run by default; a real run needs BOTH --confirm and --allow-production
 *   (the latter enforced centrally by `getOperatorClient`).
 *
 * USAGE
 *   node scripts/platform-owner-regenerate-recovery.mjs --email=owner@example.com
 *   node scripts/platform-owner-regenerate-recovery.mjs --email=owner@example.com --confirm --allow-production
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDirectSetPasswordUrl,
  buildSetPasswordRedirectUrl,
  extractRedirectTo,
  getOperatorClient,
  maskEmail,
  parseArgs,
  readSingletonPlatformOwner,
  resolveAppBaseUrl,
} from "./lib/platformOwnerOps.mjs";

function fail(msg) {
  console.error(`FAILED: ${msg}`);
  return 1;
}

/** Case-insensitive, whitespace-tolerant address comparison. Deliberately not
 * a normalising email parser - it only has to decide "is this the same string
 * the database holds", and anything cleverer would risk matching too much. */
function sameEmail(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

async function main() {
  const { flags, values } = parseArgs(process.argv);
  const dryRun = !flags.has("confirm");
  const allowProduction = flags.has("allow-production");
  const email = (values.email ?? "").trim();

  if (!email || !email.includes("@")) {
    return fail(
      "--email=<address> is required, and must match the existing Platform Owner exactly.",
    );
  }

  let ctx;
  try {
    ctx = getOperatorClient({ allowProduction });
  } catch (e) {
    return fail(e.message);
  }
  const { client, projectRef, isProduction } = ctx;

  let baseUrl;
  let baseSource;
  try {
    ({ baseUrl, source: baseSource } = resolveAppBaseUrl({
      cliValue: values["redirect-base"],
      isProduction,
    }));
  } catch (e) {
    return fail(e.message);
  }
  const requestedRedirectTo = buildSetPasswordRedirectUrl(baseUrl);

  console.log("=== Platform Owner recovery-link REGENERATION ===");
  console.log("scope:          EXISTING owner only - this script cannot create anything");
  console.log(`mode:           ${dryRun ? "DRY RUN (no link generated)" : "APPLY"}`);
  console.log(`project ref:    ${projectRef}${isProduction ? "  [PRODUCTION]" : ""}`);
  console.log(`supplied email: ${maskEmail(email)}`);
  console.log(`redirect base:  ${baseUrl}   (${baseSource})`);
  console.log(`redirect to:    ${requestedRedirectTo}`);

  // --- 1. the singleton platform_owners row must already exist --------------
  let owner;
  try {
    owner = await readSingletonPlatformOwner(client);
  } catch (e) {
    return fail(e.message);
  }
  if (!owner) {
    return fail(
      "no Platform Owner exists - there is nothing to regenerate a link for. Use platform-owner-bootstrap.mjs to provision the first one.",
    );
  }

  // --- 2. the mapped auth user must exist -----------------------------------
  const { data: userData, error: userErr } = await client.auth.admin.getUserById(
    owner.auth_user_id,
  );
  if (userErr || !userData?.user) {
    return fail(
      `the platform_owners row maps to auth user ${owner.auth_user_id}, which could not be loaded: ${userErr?.message ?? "not found"}. STOP and investigate.`,
    );
  }
  const authUser = userData.user;

  // --- 3. the supplied address must match that exact identity ---------------
  // Checked against BOTH records: a divergence between them is itself a
  // reportable inconsistency, not something to silently pick a winner for.
  if (!sameEmail(email, owner.email) || !sameEmail(email, authUser.email)) {
    console.error("");
    console.error("REFUSING: --email does not match the existing Platform Owner.");
    console.error(`  platform_owners.email: ${maskEmail(owner.email)}`);
    console.error(`  auth.users.email:      ${maskEmail(authUser.email ?? "")}`);
    console.error(`  supplied:              ${maskEmail(email)}`);
    console.error("");
    console.error(
      "A recovery link is a credential for one specific identity - it is never minted for an address that was not verified against the stored owner.",
    );
    return 1;
  }

  console.log("");
  console.log(`platform_owner_id: ${owner.id}`);
  console.log(`auth_user_id:      ${authUser.id}`);
  console.log(`email:             ${maskEmail(authUser.email ?? "")}  (matches - OK)`);
  console.log(
    "precheck:          existing owner confirmed; no user or mapping will be created.",
  );

  if (dryRun) {
    console.log("");
    console.log("DRY RUN complete. No link was generated and nothing was changed.");
    console.log(
      `Primary link (A) would be: ${requestedRedirectTo}?token_hash=...&type=recovery`,
    );
    console.log(
      "  (redeemed by the deployed set-password screen - independent of the Site URL / Redirect URLs allow-list)",
    );
    console.log(`Fallback link (B) would be requested with redirect_to=${requestedRedirectTo}`);
    console.log("Re-run with --confirm to generate a real link.");
    return 0;
  }

  // --- 4. mint exactly one fresh recovery link ------------------------------
  // `redirectTo` must be nested under `options` - GoTrueAdminApi.generateLink
  // destructures `options` off the params and only reads `options.redirectTo`.
  const { data: link, error: linkErr } = await client.auth.admin.generateLink({
    type: "recovery",
    email: authUser.email,
    options: { redirectTo: requestedRedirectTo },
  });
  if (linkErr || !link?.properties?.action_link) {
    return fail(`could not generate a recovery link: ${linkErr?.message ?? "unknown error"}`);
  }

  const hashedToken = link.properties.hashed_token;
  const directLink = hashedToken ? buildDirectSetPasswordUrl(baseUrl, hashedToken) : null;
  const actualRedirectTo =
    extractRedirectTo(link.properties.action_link) ?? link.properties.redirect_to ?? null;
  const redirectHonoured = actualRedirectTo === requestedRedirectTo;

  const outPath = join(tmpdir(), `kolbox-platform-owner-recovery-${Date.now()}.txt`);
  writeFileSync(
    outPath,
    `REGENERATED one-time recovery link(s) for the EXISTING KolBox Platform Owner.\n` +
      `Any previously issued recovery link for this account is now superseded.\n` +
      `Hand ONE of these over out-of-band, then DELETE this file.\n` +
      `The Owner chooses their own password; no temporary password exists.\n` +
      `\n` +
      `============================================================\n` +
      `(A) PRIMARY - USE THIS ONE\n` +
      `============================================================\n` +
      `A direct link into the deployed app. It carries the recovery token as a\n` +
      `token_hash query parameter, redeemed by the set-password screen itself,\n` +
      `so it does not depend on the project's Site URL / Redirect URLs setting\n` +
      `and leaves no access token in a URL fragment.\n` +
      `\n` +
      `${directLink ?? "(unavailable - GoTrue returned no hashed_token; use (B) instead)"}\n` +
      `\n` +
      `============================================================\n` +
      (redirectHonoured
        ? `(B) FALLBACK - only if (A) cannot be used\n`
        : `(B) FALLBACK - DO NOT USE - REDIRECT WAS REJECTED\n`) +
      `============================================================\n` +
      `VERDICT: ${
        redirectHonoured
          ? `redirect honoured (redirect_to=${actualRedirectTo}) - (B) is usable.`
          : `REDIRECT REJECTED. GoTrue used redirect_to=${actualRedirectTo ?? "(none)"} instead of ${requestedRedirectTo}. This link lands on the WRONG page - do NOT hand it over; use (A).`
      }\n` +
      `\n` +
      `${link.properties.action_link}\n`,
    { encoding: "utf8" },
  );

  console.log("");
  console.log("Recovery link regenerated.");
  console.log(`Written to: ${outPath}`);
  console.log("  (contents deliberately not printed - they are one-time credentials)");
  console.log("");
  console.log(
    `link (A) PRIMARY:  ${
      directLink
        ? `${requestedRedirectTo}?token_hash=***&type=recovery`
        : "UNAVAILABLE - GoTrue returned no hashed_token"
    }`,
  );
  console.log("link (B) FALLBACK: the standard Supabase action link");
  console.log(`  redirect_to requested: ${requestedRedirectTo}`);
  console.log(`  redirect_to in link:   ${actualRedirectTo ?? "(none)"}`);

  if (!redirectHonoured) {
    console.warn("");
    console.warn(
      "WARNING: GoTrue did NOT use the requested redirect target - link (B) lands on the wrong page.",
    );
    console.warn(
      `  Cause is almost always that "${requestedRedirectTo}" is not in the project's`,
    );
    console.warn("  Auth -> URL Configuration -> Redirect URLs allow-list.");
    console.warn("  Link (A) is unaffected - hand that one over.");
  }

  console.log("");
  console.log(
    "No user was created, no mapping was changed, no password or MFA factor was touched.",
  );
  return 0;
}

process.exitCode = await main();
