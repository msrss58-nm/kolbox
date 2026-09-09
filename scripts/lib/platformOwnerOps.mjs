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

/* -------------------------------------------------------------------------- *
 * Activation / recovery redirect target
 *
 * `auth.admin.generateLink()` with no `redirectTo` makes hosted GoTrue fall
 * back to the project's Site URL - which on this project is still Supabase's
 * default `http://localhost:3000`, i.e. a link the Owner cannot use. The
 * target therefore has to be passed explicitly, and it has to be configurable
 * (Production, a preview deployment, and a local dev stack are all different
 * origins).
 *
 * IMPORTANT - passing `redirectTo` is necessary but NOT sufficient: GoTrue
 * silently DISCARDS a redirect target that is not in the project's Auth
 * "Redirect URLs" allow-list and falls back to the Site URL without any error.
 * That is why the caller must compare the requested target against the one
 * GoTrue actually returned (see `extractRedirectTo`) instead of assuming the
 * request was honoured.
 * -------------------------------------------------------------------------- */

/** The frontend route the Owner's one-time link must land on. */
export const PLATFORM_SET_PASSWORD_PATH = "/platform/set-password";

/**
 * Fallback base URLs, used only when neither `--redirect-base=` nor
 * `KOLBOX_APP_BASE_URL` is supplied. Chosen by target so a local/disposable
 * stack never defaults to the Production origin (and vice versa).
 *
 * ORIGIN SEPARATION: this is the PLATFORM OWNER origin, deliberately NOT the
 * Election Day origin the server runtime uses as its default allowed origin.
 * The only thing built from this base is `/platform/set-password`, which after
 * origin separation exists solely on the platform surface - a link built
 * against the election origin would resolve to no route there, and the agreed
 * old-origin redirect deliberately does not forward one-time tokens. Pointing
 * the default at the election origin would therefore emit dead recovery links
 * whenever an operator forgot to set `KOLBOX_APP_BASE_URL`.
 */
export const DEFAULT_PRODUCTION_APP_BASE_URL = "https://kolbox-platform.vercel.app";
export const DEFAULT_LOCAL_APP_BASE_URL = "http://localhost:5173";

/**
 * Validates and normalizes a base URL: absolute http(s), no query, no fragment,
 * no trailing slash.
 *
 * A path prefix is accepted by this validator but is NOT supported by the app:
 * `createBrowserRouter` is configured with no `basename`, and the capture in
 * `platformOwnerRecoveryUrl.ts` compares the absolute pathname against
 * `/platform/set-password`. A base such as `https://host/app` therefore yields a
 * link that matches no route and never triggers the capture. Use an origin only
 * unless the app is given a basename first.
 */
export function normalizeAppBaseUrl(raw, sourceLabel) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error(`BAD_REDIRECT_BASE: ${sourceLabel} is empty.`);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `BAD_REDIRECT_BASE: ${sourceLabel} ("${value}") is not an absolute URL - expected e.g. https://example.com`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `BAD_REDIRECT_BASE: ${sourceLabel} must be http(s), got "${parsed.protocol}".`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `BAD_REDIRECT_BASE: ${sourceLabel} must not carry a query string or fragment.`,
    );
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/**
 * Resolves the app's public base URL, in this precedence order:
 *   1. `--redirect-base=<url>` (explicit, per-run)
 *   2. `KOLBOX_APP_BASE_URL`, from `.env.local` merged with `process.env`
 *   3. a safe default chosen by target: the Platform Owner Production origin
 *      for the approved Production project ref, otherwise the local dev origin.
 *
 * `SESSION_ALLOWED_ORIGIN` was removed from step 2 by ORIGIN SEPARATION. It
 * means exactly one thing - the ELECTION DAY browser origin the API's CSRF
 * Origin checks accept - and reusing it as a Platform Owner recovery-link base
 * overloaded one variable with two unrelated security purposes, silently
 * producing a link on the wrong origin.
 *
 * Returns `{ baseUrl, source }` - `source` is reported so an operator can see
 * which layer won without having to guess.
 */
export function resolveAppBaseUrl({ cliValue, isProduction }) {
  if (cliValue !== undefined && String(cliValue).trim() !== "") {
    return {
      baseUrl: normalizeAppBaseUrl(cliValue, "--redirect-base"),
      source: "--redirect-base flag",
    };
  }

  let env = {};
  try {
    env = { ...readEnvFile(), ...process.env };
  } catch {
    env = { ...process.env };
  }

  for (const name of ["KOLBOX_APP_BASE_URL"]) {
    const raw = env[name];
    if (raw !== undefined && String(raw).trim() !== "") {
      return { baseUrl: normalizeAppBaseUrl(raw, name), source: `env ${name}` };
    }
  }

  const fallback = isProduction
    ? DEFAULT_PRODUCTION_APP_BASE_URL
    : DEFAULT_LOCAL_APP_BASE_URL;
  return {
    baseUrl: normalizeAppBaseUrl(fallback, "built-in default"),
    source: `built-in default (${isProduction ? "production" : "non-production"} target)`,
  };
}

/** `<base>/platform/set-password` - the one-time link's landing page. */
export function buildSetPasswordRedirectUrl(baseUrl) {
  return `${baseUrl}${PLATFORM_SET_PASSWORD_PATH}`;
}

/**
 * Reads the `redirect_to` query parameter back out of a generated action link,
 * so the caller can prove GoTrue actually honoured the requested target.
 *
 * The action link is a one-time credential: this returns ONLY the redirect_to
 * value and never the link, the token, or any other part of it. Returns null
 * when the link is unparseable or carries no redirect_to at all (which itself
 * means the request was not honoured).
 */
export function extractRedirectTo(actionLink) {
  try {
    return new URL(String(actionLink)).searchParams.get("redirect_to");
  } catch {
    return null;
  }
}

/**
 * PRIMARY activation link: a direct app URL that does NOT route through
 * GoTrue's `/verify` endpoint at all.
 *
 *   <base>/platform/set-password?token_hash=<hashed_token>&type=recovery
 *
 * The frontend calls `verifyOtp({ token_hash, type: 'recovery' })` with these
 * two query parameters, which means:
 *   - it does not depend on the project's Site URL or its Redirect URLs
 *     allow-list (the allow-list is what silently swallows `redirectTo`), so
 *     it works in Production with no dashboard change at all; and
 *   - no `#access_token=...` fragment is ever put on our origin, so no other
 *     Supabase client loaded on the page can pick up a session that was not
 *     meant for it.
 *
 * `hashed_token` comes from `generateLink()`'s
 * `data.properties.hashed_token` (see GenerateLinkProperties in
 * @supabase/auth-js lib/types.d.ts). It is a one-time credential: like the
 * action link, this URL must never be printed or logged.
 */
export function buildDirectSetPasswordUrl(baseUrl, hashedToken) {
  const params = new URLSearchParams({
    token_hash: String(hashedToken),
    type: "recovery",
  });
  return `${buildSetPasswordRedirectUrl(baseUrl)}?${params.toString()}`;
}
