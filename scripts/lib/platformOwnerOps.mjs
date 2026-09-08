/**
 * Platform Owner Program - Stage 2 shared operator helpers.
 *
 * Used by the two OPERATOR-ONLY local scripts:
 *   - scripts/platform-owner-bootstrap.mjs   (initial Platform Owner provisioning)
 *   - scripts/platform-owner-break-glass.mjs (MFA recovery for a locked-out Owner)
 *
 * Neither script is, or may ever become, an HTTP route. There is deliberately
 * no runtime bootstrap and no "first person wins" path anywhere in the
 * application: creating the singleton Platform Owner requires possession of
 * the service-role key on the operator's own machine, full stop.
 *
 * CREDENTIAL RULE (project-wide, see CLAUDE.md): this module reads the
 * service-role key and consumes it internally. It is NEVER printed, logged,
 * echoed, returned in a report, or written to any artifact. Callers get a
 * ready-made Supabase client, never the key itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

/** The one Production project this program is ever allowed to target. */
export const APPROVED_PRODUCTION_PROJECT_REF = "nbymfgphnsounqncfjgl";

/**
 * Parses `.env.local` without exposing values. Returns only the variables
 * asked for, and the caller is expected to hand them straight to a client
 * constructor rather than inspect them.
 */
function readEnvFile() {
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) {
    throw new Error(
      "MISSING_ENV: .env.local not found. This script must be run locally by the operator, from the repository root.",
    );
  }
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Extracts `<ref>` from `https://<ref>.supabase.co`, refusing partial matches.
 *
 * A local/disposable Supabase stack (`http://127.0.0.1:54321`) has no project
 * ref, so it resolves to a synthetic `local:<host>:<port>` label instead of
 * throwing. This is deliberate and is NOT a weakening of the Production gate:
 * a synthetic local label can never equal APPROVED_PRODUCTION_PROJECT_REF, so
 * `isProduction` stays false and the `--allow-production` requirement is
 * untouched. Rejecting localhost outright would have made these two scripts
 * impossible to rehearse against a disposable replica before pointing them at
 * Production - which this project's own guardrails require.
 */
export function parseProjectRef(supabaseUrl) {
  let parsed;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new Error("BAD_URL: SUPABASE URL is not a valid URL.");
  }
  const host = parsed.hostname;

  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return `local:${host}:${parsed.port || "80"}`;
  }

  const m = /^([a-z0-9]+)\.supabase\.co$/i.exec(host);
  if (!m) {
    throw new Error(
      `BAD_URL: hostname "${host}" is neither "<ref>.supabase.co" nor a localhost stack - refusing a substring match.`,
    );
  }
  return m[1];
}

/**
 * Builds a service-role Supabase client. Accepts either env var name this
 * repo uses (`SUPABASE_SERVICE_ROLE_KEY` locally, `SUPABASE_SECRET_KEY` in
 * the Vercel server runtime). Returns `{ client, projectRef, isProduction }`
 * - never the key.
 */
export function getOperatorClient({ allowProduction }) {
  const env = { ...readEnvFile(), ...process.env };
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

  if (!url) throw new Error("MISSING_ENV: no SUPABASE_URL / VITE_SUPABASE_URL.");
  if (!key) {
    throw new Error(
      "MISSING_ENV: no SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY. (The value is consumed internally and never printed.)",
    );
  }

  const projectRef = parseProjectRef(url);
  const isProduction = projectRef === APPROVED_PRODUCTION_PROJECT_REF;

  if (isProduction && !allowProduction) {
    throw new Error(
      `REFUSING_PRODUCTION: target project is Production (${projectRef}). Re-run with --allow-production only under an explicit, current authorization to mutate Production.`,
    );
  }

  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return { client, projectRef, isProduction };
}

/** Minimal flag parser: `--flag` and `--key=value`. */
export function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (const a of argv.slice(2)) {
    const kv = /^--([A-Za-z0-9-]+)=(.*)$/.exec(a);
    if (kv) values[kv[1]] = kv[2];
    else if (a.startsWith("--")) flags.add(a.slice(2));
  }
  return { flags, values };
}

/** Reads the singleton Platform Owner row, or null. Never returns secrets. */
export async function readSingletonPlatformOwner(client) {
  const { data, error } = await client
    .from("platform_owners")
    .select("id, auth_user_id, email, created_at");
  if (error) throw new Error(`DB_ERROR: ${error.message}`);
  const rows = data ?? [];
  if (rows.length > 1) {
    throw new Error(
      `INVARIANT_VIOLATION: platform_owners holds ${rows.length} rows; the singleton index should make this impossible. STOP and investigate.`,
    );
  }
  return rows[0] ?? null;
}

/** Masks an email for console output: n****@example.com */
export function maskEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return "(hidden)";
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}
