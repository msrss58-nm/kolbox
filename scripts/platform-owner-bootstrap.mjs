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
 * confirmed email and no password, then generates a one-time recovery link
 * which is written to a file OUTSIDE the repository (path printed, contents
 * never printed) for the operator to hand over out-of-band.
 *
 * Usage:
 *   node scripts/platform-owner-bootstrap.mjs --email=owner@example.com --name="Full Name" [--phone=...]
 *     -> DRY RUN (default): validates and reports, mutates nothing.
 *   ... --confirm                 -> actually provisions (local/disposable stack).
 *   ... --confirm --allow-production -> required to target Production at all.
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

  console.log("=== Platform Owner bootstrap ===");
  console.log(`mode:         ${dryRun ? "DRY RUN (no mutation)" : "APPLY"}`);
  console.log(`project ref:  ${projectRef}${isProduction ? "  [PRODUCTION]" : ""}`);
  console.log(`owner email:  ${maskEmail(email)}`);
  console.log(`owner name:   ${name}`);

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
  const { data: link, error: linkErr } = await client.auth.admin.generateLink({
    type: "recovery",
    email,
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

  // The link is a one-time credential: written to a file, never printed. It is
  // written OUTSIDE the repository on purpose - a credential file must never
  // become untracked residue in a git working tree.
  const outPath = join(tmpdir(), `kolbox-platform-owner-activation-${Date.now()}.txt`);
  writeFileSync(
    outPath,
    `One-time activation link for the KolBox Platform Owner.\n` +
      `Hand this to the Owner out-of-band, then DELETE this file.\n` +
      `The Owner sets their own password; no temporary password exists.\n\n` +
      `${link.properties.action_link}\n`,
    { encoding: "utf8" },
  );

  console.log("");
  console.log("Provisioning complete.");
  console.log(`Activation link written to: ${outPath}`);
  console.log("  (contents deliberately not printed - it is a one-time credential)");
  console.log("  Hand it over out-of-band, then DELETE that file.");
  console.log("");
  console.log("Next: the Owner signs in, sets their own password, and is then");
  console.log("required to enrol TOTP before reaching the Platform console.");
  return 0;
}

process.exitCode = await main();
