/**
 * Platform Owner Program - Stage 2: OPERATOR-ONLY initial provisioning.
 *
 * Creates the ONE Platform Owner. This is deliberately a local script run by
 * the operator with the service-role key, and never an HTTP route, never a
 * runtime bootstrap, and never "whoever signs up first wins" - the Election
 * Day empty-roster bootstrap window was removed for exactly that reason, and
 * an analogous window on a platform-wide singleton principal would be far
 * worse (Production Supabase signup is open, so anyone can self-register and
 * self-enroll a TOTP factor to reach aal2; only membership of the
 * platform_owners row confers authority).
 *
 * The Owner CHOOSES THEIR OWN PASSWORD. This script never generates,
 * transmits, or stores a temporary password. It creates the auth user with a
 * confirmed email and no password, then generates a one-time recovery token
 * and writes TWO forms of activation link to a file OUTSIDE the repository
 * (path printed, contents never printed) for the operator to hand over
 * out-of-band:
 *
 *   (A) PRIMARY - `<base>/platform/set-password?token_hash=...&type=recovery`,
 *       a direct app link the set-password screen redeems itself with
 *       `verifyOtp({ token_hash, type: 'recovery' })`. It never routes through
 *       GoTrue's `/verify`, so it is independent of the project's Site URL and
 *       Redirect URLs allow-list, and it never lands an `#access_token=...`
 *       fragment on our origin for other Supabase clients to consume.
 *   (B) FALLBACK - the standard GoTrue action link, generated with an explicit
 *       `redirectTo`, usable only once that target is in the allow-list.
 *
 * Usage:
 *   node scripts/platform-owner-bootstrap.mjs --email=owner@example.com --name="Full Name" [--phone=...]
 *     -> DRY RUN (default): validates and reports, mutates nothing.
 *   ... --confirm                 -> actually provisions (local/disposable stack).
 *   ... --confirm --allow-production -> required to target Production at all.
 *   ... --redirect-base=https://example.com -> overrides where the link lands.
 *
 * The one-time link's landing page is `<base>/platform/set-password`, where
 * `<base>` resolves as: --redirect-base > KOLBOX_APP_BASE_URL > a built-in
 * default chosen by target (the PLATFORM OWNER origin for Production, since
 * origin separation put `/platform/set-password` on its own host). Without an
 * explicit redirect target hosted GoTrue falls back to the project's Site URL
 * (still Supabase's default http://localhost:3000 on this project), and even
 * WITH one it silently discards a target that is missing from the project's
 * Auth "Redirect URLs" allow-list - so this script reports both the requested
 * target and the one GoTrue actually used, and warns loudly when they differ.
 *
 * Exit codes: 0 ok / 1 refused or failed. (Set via `process.exitCode` and a
 * normal return - never `process.exit()`, which races undici's keep-alive
 * sockets on Windows and aborts with a libuv assertion, destroying the very
 * exit code this contract promises.)
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

async function main() {
  const { flags, values } = parseArgs(process.argv);
  const dryRun = !flags.has("confirm");
  const allowProduction = flags.has("allow-production");

  const email = (values.email ?? "").trim();
  const name = (values.name ?? "").trim();
  const phone = (values.phone ?? "").trim() || null;

  if (!email || !email.includes("@")) return fail("--email=<address> is required.");
  if (!name) return fail('--name="Full Name" is required.');

  let ctx;
  try {
    ctx = getOperatorClient({ allowProduction });
  } catch (e) {
    return fail(e.message);
  }
  const { client, projectRef, isProduction } = ctx;

  // --- Where the one-time link must land ------------------------------------
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

  console.log("=== Platform Owner bootstrap ===");
  console.log(`mode:         ${dryRun ? "DRY RUN (no mutation)" : "APPLY"}`);
  console.log(`project ref:  ${projectRef}${isProduction ? "  [PRODUCTION]" : ""}`);
  console.log(`owner email:  ${maskEmail(email)}`);
  console.log(`owner name:   ${name}`);
  console.log(`redirect base: ${baseUrl}   (from ${baseSource})`);
  console.log(`redirect to:   ${requestedRedirectTo}`);

  if (isProduction && baseUrl.startsWith("http://")) {
    console.warn(
      `WARNING: the redirect base is plain http:// while targeting Production (${projectRef}).`,
    );
  }

  // --- Hard gate: the singleton must not already exist -----------------------
  let existing;
  try {
    existing = await readSingletonPlatformOwner(client);
  } catch (e) {
    return fail(e.message);
  }

  if (existing) {
    console.error("");
    console.error("REFUSING: a Platform Owner already exists.");
    console.error(`  platform_owner_id: ${existing.id}`);
    console.error(`  email:             ${maskEmail(existing.email)}`);
    console.error(`  created_at:        ${existing.created_at}`);
    console.error("");
    console.error(
      "Replacing the Platform Owner is a separate, deliberate operation - never a second insert (the singleton index would reject it anyway).",
    );
    return 1;
  }

  console.log("precheck:     platform_owners is empty - OK to provision.");

  if (dryRun) {
    console.log("");
    console.log("DRY RUN complete. Nothing was created.");
    console.log(`Primary link (A) would be: ${requestedRedirectTo}?token_hash=...&type=recovery`);
    console.log(
      "  (independent of the project's Site URL / Redirect URLs allow-list - it is redeemed by the app)",
    );
    console.log(`Fallback link (B) would be requested with redirect_to=${requestedRedirectTo}`);
    console.log(
      "  (whether GoTrue HONOURS that depends on the Auth Redirect URLs allow-list; it can only be",
    );
    console.log("   confirmed on a real --confirm run, which reports the requested vs actual value)");
    console.log("Re-run with --confirm to provision for real.");
    return 0;
  }

  // --- Create the Supabase Auth user (no password - Owner sets their own) ----
  const { data: created, error: createErr } = await client.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createErr || !created?.user?.id) {
    return fail(
      `could not create the auth user: ${createErr?.message ?? "unknown error"}`,
    );
  }
  const authUserId = created.user.id;
  console.log(`created:      auth user ${authUserId}`);

  // --- Insert the singleton platform_owners row ------------------------------
  const { data: inserted, error: insertErr } = await client
    .from("platform_owners")
    .insert({ auth_user_id: authUserId, name, email, phone })
    .select("id")
    .single();

  if (insertErr) {
    console.error(`FAILED: could not insert platform_owners row: ${insertErr.message}`);
    console.error(
      `Rolling back the orphaned auth user ${authUserId} so the next run starts clean...`,
    );
    const { error: delErr } = await client.auth.admin.deleteUser(authUserId);
    console.error(delErr ? `  rollback FAILED: ${delErr.message}` : "  rollback OK.");
    return 1;
  }
  console.log(`created:      platform_owners row ${inserted.id}`);

  // --- One-time link so the Owner chooses their OWN password -----------------
  // `redirectTo` MUST sit inside `options` - verified against
  // node_modules/@supabase/auth-js/dist/main/GoTrueAdminApi.js (generateLink
  // destructures `options` off the params and passes `options?.redirectTo` to
  // `_request`, which turns it into the `redirect_to` query parameter; see also
  // GenerateRecoveryLinkParams in lib/types.d.ts). A top-level `redirectTo`
  // would be posted as an unknown body field and silently ignored.
  const { data: link, error: linkErr } = await client.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: requestedRedirectTo },
  });
  if (linkErr || !link?.properties?.action_link) {
    console.log("");
    console.log(
      "NOTE: the Owner record was created, but a recovery link could not be generated:",
    );
    console.log(`  ${linkErr?.message ?? "unknown error"}`);
    console.log(
      "Send the Owner a password-reset from the Supabase dashboard instead. Do NOT set a password on their behalf.",
    );
    return 0;
  }

  // Two links are emitted, PRIMARY first:
  //
  //   (A) a direct app URL carrying `token_hash` + `type=recovery`, which the
  //       set-password screen redeems with verifyOtp(). It never touches
  //       GoTrue's /verify endpoint, so it does NOT depend on the project's
  //       Site URL or its Redirect URLs allow-list, and it never puts an
  //       `#access_token=...` fragment on our origin for any other Supabase
  //       client on the page to consume.
  //   (B) the standard GoTrue action link, still generated with an explicit
  //       redirectTo - kept as a fallback, but only usable once the target is
  //       actually in the allow-list (see the mismatch check below).
  //
  // Both are one-time credentials: written to a file, never printed. The file
  // is written OUTSIDE the repository on purpose - a credential file must
  // never become untracked residue in a git working tree.
  const hashedToken = link.properties.hashed_token;
  const directLink = hashedToken
    ? buildDirectSetPasswordUrl(baseUrl, hashedToken)
    : null;

  // --- Prove GoTrue actually honoured the requested redirect target ---------
  // Computed BEFORE the file is written, so the handover file itself records the
  // verdict. Writing first and warning afterwards leaves a credential file on
  // disk whose "(B) FALLBACK" section looks usable when it is not.
  // Only the redirect_to value is read back out of the link - never the link,
  // its token, or any other part of it.
  const actualRedirectTo =
    extractRedirectTo(link.properties.action_link) ?? link.properties.redirect_to ?? null;
  const redirectHonoured = actualRedirectTo === requestedRedirectTo;

  const outPath = join(tmpdir(), `kolbox-platform-owner-activation-${Date.now()}.txt`);
  writeFileSync(
    outPath,
    `One-time activation link(s) for the KolBox Platform Owner.\n` +
      `Hand ONE of these to the Owner out-of-band, then DELETE this file.\n` +
      `The Owner sets their own password; no temporary password exists.\n` +
      `\n` +
      `============================================================\n` +
      `(A) PRIMARY - USE THIS ONE\n` +
      `============================================================\n` +
      `A direct link into the app. It carries the recovery token as a\n` +
      `token_hash query parameter, which the set-password screen redeems\n` +
      `itself. It does not go through Supabase's /verify redirect, so it\n` +
      `works regardless of the project's Site URL / Redirect URLs settings,\n` +
      `and it never leaves an access token in the page URL fragment.\n` +
      `\n` +
      `${directLink ?? "(unavailable - GoTrue returned no hashed_token; use (B) instead)"}\n` +
      `\n` +
      `============================================================\n` +
      (redirectHonoured
        ? `(B) FALLBACK - only if (A) cannot be used\n`
        : `(B) FALLBACK - DO NOT USE - REDIRECT WAS REJECTED\n`) +
      `============================================================\n` +
      `The standard Supabase action link. It was requested with\n` +
      `redirect_to=${requestedRedirectTo}\n` +
      `but Supabase silently ignores that target unless it is present in the\n` +
      `project's Auth -> URL Configuration -> Redirect URLs allow-list; when\n` +
      `it is ignored, this link lands on the project's Site URL instead. The\n` +
      `script's console output states which of the two actually happened.\n` +
      `\n` +
      `VERDICT: ${
        redirectHonoured
          ? `redirect honoured (redirect_to=${actualRedirectTo}) - (B) is usable.`
          : `REDIRECT REJECTED - GoTrue used ${actualRedirectTo ?? "(none)"} instead of ${requestedRedirectTo}. This link lands on the WRONG page. Do NOT hand it over; use (A).`
      }\n` +
      `\n` +
      `${link.properties.action_link}\n`,
    { encoding: "utf8" },
  );


  console.log("");
  console.log("Provisioning complete.");
  console.log(`Activation links written to: ${outPath}`);
  console.log("  (contents deliberately not printed - they are one-time credentials)");
  console.log("  Hand ONE over out-of-band, then DELETE that file.");
  console.log("");
  console.log(
    `link (A) PRIMARY:  ${
      directLink
        ? `${requestedRedirectTo}?token_hash=***&type=recovery`
        : "UNAVAILABLE - GoTrue returned no hashed_token"
    }`,
  );
  console.log(
    "  Direct app link, redeemed by the set-password screen itself - independent of the",
  );
  console.log("  project's Site URL and Redirect URLs allow-list. Prefer this one.");
  console.log("");
  console.log("link (B) FALLBACK: the standard Supabase action link");
  console.log(`  redirect_to requested:  ${requestedRedirectTo}`);
  console.log(`  redirect_to in link:    ${actualRedirectTo ?? "(none)"}`);

  if (!redirectHonoured) {
    console.warn("");
    console.warn(
      "WARNING: GoTrue did NOT use the requested redirect target - it fell back to something else.",
    );
    console.warn(
      "  This is what a silently rejected redirect looks like: the call succeeded and the link",
    );
    console.warn("  works, but it lands on the wrong page (usually the project's Site URL).");
    console.warn(
      `  Almost always cause: "${requestedRedirectTo}" is not in the Supabase project's`,
    );
    console.warn("  Auth -> URL Configuration -> Redirect URLs allow-list.");
    console.warn(
      "  Effect: fallback link (B) is NOT usable for this flow - do not hand it over as-is.",
    );
    console.warn(
      directLink
        ? "  Link (A) is unaffected by this and is still the correct one to hand over."
        : "  Link (A) is also unavailable - fix the allow-list and re-issue before handing anything over.",
    );
    console.warn("");
  } else {
    console.log("  (match - the redirect target was honoured, so (B) would work too)");
  }

  console.log("");
  console.log("Next: the Owner signs in, sets their own password, and is then");
  console.log("required to enrol TOTP before reaching the Platform console.");
  return 0;
}

process.exitCode = await main();
