import {
  extractPlatformBearerToken,
  verifyPlatformOwnerJwt,
} from "../election-day/_platformAuth.js";
import { getAnonAuthClient, getServiceClient } from "../election-day/_ownerAuth.js";
import { handleAuthBrokerRequest, isAuthBrokerRequest } from "./_authBroker.js";
import { handleMultiEntityRequest, isMultiEntityRequest } from "./_multiEntitySession.js";

// Platform Stage 2 - PLATFORM OWNER session/context endpoint.
// Platform Stage 3B - plus the Platform Owner's one write operation.
//
// GET answers the single question: "does this Supabase JWT belong to the
// singleton platform owner?" On success it returns the bare
// {platformOwnerId, email} pair and NOTHING else - no voter data, no
// workspace data, no Election Day operational fields, and no Election Owner
// APIs are reachable through it.
//
// POST carries an `op` multiplex (create_owner_access, the Stage 4A
// Multi-Entity seat/assignment ops, the Stage 4B provisioning-orphan purge,
// and the Stage 8B reissue_owner_access). GET carries an optional `op` too
// (multi_entity_state, Stage 8B owner_access), with the original no-op
// payload preserved as the default.
//
// Platform Stage 5 - a SECOND, fully separate principal partition. Any request
// carrying the `me_op` query key belongs to the MULTI-ENTITY OWNER and is
// handed WHOLESALE to _multiEntitySession.ts before a single line of the
// Platform Owner path below runs (no Origin/op parsing, no Platform verifier).
// That handler has its own verifier (_multiEntityAuth.ts) and its own rules;
// `op` + `me_op` together is refused there as ambiguous. The Platform Owner
// path is otherwise unchanged. A separate file is impossible for the same
// 12/12 reason given below, and vercel.json maps the clean public paths
// /api/multi-entity/{session,workspace} onto this partition.
//
// Stage 3B needed the Platform Owner console to perform a real mutation, and
// this project is at exactly 12/12 Vercel Hobby Functions with no per-project
// exclusion mechanism - so a 13th file is impossible. Multiplexing onto the
// principal's OWN existing endpoint is the established house answer (see
// owner-actions.ts's op table and permission-users.ts's __pu_action marker),
// and it keeps the Platform principal's surface in the Platform principal's
// file rather than smuggling it into an Election Day handler.
//
// A DIFFERENT principal from the Election Owner endpoints under
// /api/election-day/*: this route verifies via _platformAuth.ts's
// verifyPlatformOwnerJwt (getUser -> getClaims/aal2 -> platform_owners row)
// and never via _ownerAuth.ts's verifyOwnerJwt. The two principals must
// never authorize each other. Only the service-client plumbing is shared.
//
// ORIGIN, AND WHY THIS ENDPOINT NEEDS ITS OWN ALLOW-LIST
//
// Every state-changing handler under /api/election-day/* validates Origin
// against allowedOrigins(), which resolves to a SINGLE value: the Election
// origin (SESSION_ALLOWED_ORIGIN, defaulting to kolbox-gamma). That is
// correct for those handlers and must not be widened - but it means a POST
// from the Platform Owner console, which after ORIGIN SEPARATION is served
// from a different origin entirely, would be rejected 403 by every one of
// them. The Platform principal therefore carries its own single-valued
// allow-list here, deliberately NOT reusing SESSION_ALLOWED_ORIGIN: that
// variable means exactly one thing (the Election Day browser origin the CSRF
// checks accept), and scripts/lib/platformOwnerOps.mjs already removed it
// from an unrelated chain for precisely this "one variable, two security
// purposes" reason. GET keeps its documented no-Origin-check behaviour.
//
// No Origin check on GET - browsers do not reliably send an Origin header on
// a same-origin simple GET (matches the existing session endpoints in this
// project); that path is read-only with no state-changing side effect,
// so a forged cross-site GET can at most read back {platformOwnerId, email}
// for a JWT the caller already possesses.

interface MinimalRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
  // Present on Vercel's response object; used by the Stage 5 Multi-Entity
  // partition (Cache-Control: no-store) and by the auth broker, which emits
  // two Set-Cookie headers when a sign-in also ends the previous principal's
  // session. The Platform path itself never calls it.
  setHeader: (name: string, value: string | string[]) => unknown;
}

const DEFAULT_PLATFORM_ORIGIN = "https://kolbox-platform.vercel.app";

// The Election origin, used ONLY to build the Election Owner's activation link
// - the owner set-password route lives on the Election surface, not the
// Platform one. Deliberately a separate variable from SESSION_ALLOWED_ORIGIN
// (see the header) and from the Platform origin above.
const DEFAULT_ELECTION_APP_BASE_URL = "https://kolbox-gamma.vercel.app";
const LOCAL_APP_BASE_URL = "http://localhost:5173";
const OWNER_SET_PASSWORD_PATH = "/election-day/owner-set-password";

// Platform Stage 5 - the Multi-Entity Owner's set-password route, served ONLY
// by the dedicated `multi_entity` surface (its own origin). Stage 4B pointed
// this link at the Election Owner screen on the Election origin, which would
// have dead-ended the seat holder AND made the most privileged cross-workspace
// credential a saved-password fill candidate on the Election login forms.
// One variable, one purpose - and deliberately NO hardcoded production
// default: the origin is only known once its Vercel project exists, so an
// unset value in production must fail closed rather than guess.
const MULTI_ENTITY_SET_PASSWORD_PATH = "/multi-entity/set-password";

// Per-op body-key allow-lists. Deliberately NOT one flat shared set: an op must
// not silently accept another op's fields. Matches owner-actions.ts's own
// per-descriptor allowedBodyKeys construction.
//
// create_owner_access's list is byte-for-byte the keys the single-op version
// accepted, so its request contract is unchanged.
/**
 * A contact phone, normalized to the canonical local Israeli form, or null
 * when it is not a plausible Israeli number.
 *
 * This restates src/lib/phone.ts's `normalizeIsraeliPhone` +
 * `isValidIsraeliPhone` rather than importing them: `api/` is a separate
 * bundle that imports nothing from `src/`, so the rule has to exist on both
 * sides of that boundary. The same duplication already exists in SQL, in the
 * coordinator phone migration (INVALID_COORDINATOR_PHONE). If one copy
 * changes, all three must.
 *
 * The SERVER is the authority: the console validates too, but a caller that
 * skips the console is refused here.
 */
function normalizedIsraeliPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local =
    digits.startsWith("972") && digits.length === 12
      ? `0${digits.slice(3)}`
      : digits.length === 9 && !digits.startsWith("0")
        ? `0${digits}`
        : digits;
  return /^0\d{8,9}$/.test(local) ? local : null;
}

const POST_OP_KEYS: Record<string, readonly string[]> = {
  // Stage 9: `modules` (the explicit module entitlement choice) is required.
  // `username` is the Election Owner's LOGIN username for /login/election-owner.
  // Required: without a directory row the Owner could never sign in at all.
  create_owner_access: ["name", "email", "phone", "expiresInDays", "modules", "username"],
  // The Platform Owner's own application username for /login/platform-owner.
  set_own_username: ["username"],
  set_workspace_modules: ["workspaceId", "modules"],
  // Gate 4: a module's GLOBAL availability (the platform-wide kill switch).
  set_module_availability: ["moduleKey", "available"],
  // `ownerId` is OPTIONAL on provision: absent means ADD a new owner, present
  // means REPLACE that owner's identity. It is REQUIRED on assign/unassign -
  // with several owners there is no "the" owner to fall back on, and guessing
  // one would silently grant or revoke the wrong person's visibility.
  provision_multi_entity_owner: ["name", "email", "phone", "username", "ownerId"],
  remove_multi_entity_owner: ["ownerId"],
  reissue_multi_entity_password_link: ["ownerId"],
  assign_workspace: ["ownerId", "workspaceId"],
  unassign_workspace: ["ownerId", "workspaceId"],
  purge_replaced_auth_user: ["previousAuthUserId"],
  purge_provisioning_orphan: ["authUserId"],
  reissue_owner_access: ["pendingId"],
  // The Election Owner's own account. `workspaceId` identifies WHICH Owner -
  // the server re-resolves them from it, so no auth id ever crosses the wire.
  set_owner_username: ["workspaceId", "username"],
  set_owner_password: ["workspaceId", "password"],
  set_owner_profile: ["workspaceId", "name", "email", "phone"],
  // The Platform Owner's OWN password. Verified and set entirely server-side.
  change_own_password: ["currentPassword", "newPassword"],
  // Permanent deletion of an election system. `confirmName` is the workspace's
  // own name as the operator typed it - the DATABASE compares it, so the
  // confirmation is a boundary and not a browser courtesy.
  delete_workspace: ["workspaceId", "confirmName"],
};

const GET_OPS = new Set<string>([
  "multi_entity_state",
  "owner_access",
  "workspace_modules",
  "owner_account",
  "activity",
]);

// Stage 9: syntactic shape of a module key. The database is the authority on
// which keys exist (platform_modules); this only keeps junk out of the RPC.
const MODULE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
const MAX_MODULES_PER_REQUEST = 20;

/** A non-empty, de-duplicated list of syntactically valid module keys, or
 * null. Never trusts the client's list as authoritative - the RPC validates
 * every key against the catalog. */
function parseModules(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_MODULES_PER_REQUEST) {
    return null;
  }
  const out = new Set<string>();
  for (const m of v) {
    if (typeof m !== "string" || !MODULE_KEY_PATTERN.test(m)) return null;
    out.add(m);
  }
  return [...out];
}

// Stage 8B: set in app_metadata on every Auth user create_owner_access creates.
// app_metadata is writable only through the service-role Admin API, so an
// unheld account carrying this marker can only be one this flow created and
// then failed to attach - platform_classify_owner_access_email re-uses it
// instead of creating a duplicate. Never read for authorization.
const ELECTION_OWNER_MINT_MARKER = { kolbox_mint: "election_owner_approval" } as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseQuery(url: string | undefined): Record<string, unknown> {
  if (!url) return {};
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

function allowedPlatformOrigins(): Set<string> {
  const origins = new Set<string>([
    process.env.PLATFORM_ALLOWED_ORIGIN ?? DEFAULT_PLATFORM_ORIGIN,
  ]);
  if (!isProduction()) {
    origins.add(LOCAL_APP_BASE_URL);
  }
  return origins;
}

function electionAppBaseUrl(): string {
  const configured = process.env.KOLBOX_ELECTION_APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return isProduction() ? DEFAULT_ELECTION_APP_BASE_URL : LOCAL_APP_BASE_URL;
}

/** Stage 5: the Multi-Entity origin for the seat holder's set-password link.
 * `null` in production when KOLBOX_MULTI_ENTITY_APP_BASE_URL is unset - the
 * caller must refuse BEFORE creating any Auth account. Local/preview builds
 * fall back to the dev server, matching electionAppBaseUrl(). */
function multiEntityAppBaseUrl(): string | null {
  const configured = (process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return isProduction() ? null : LOCAL_APP_BASE_URL;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Fixed, generic codes only - never a raw Postgres or GoTrue message.
  res.status(status).json({ error: code });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Intentionally permissive: GoTrue is the authority on what it will accept as
// an email. This only rejects input that is obviously not an address, so a
// typo fails here rather than creating a stranded Auth user.
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

function mapRpcError(message: string): { status: number; code: string } {
  const m = message.toUpperCase();
  if (m.includes("UNAUTHORIZED")) return { status: 401, code: "UNAUTHORIZED" };
  if (m.includes("OWNER_ALREADY_PROVISIONED")) {
    return { status: 409, code: "OWNER_ALREADY_PROVISIONED" };
  }
  if (m.includes("PENDING_ACCESS_ALREADY_CONSUMED")) {
    return { status: 409, code: "PENDING_ACCESS_ALREADY_CONSUMED" };
  }
  if (m.includes("PENDING_ACCESS_EXPIRED")) {
    return { status: 409, code: "PENDING_ACCESS_EXPIRED" };
  }
  // Stage 8B - re-issue of an approval that does not exist (never, or deleted).
  if (m.includes("PENDING_ACCESS_NOT_FOUND")) {
    return { status: 404, code: "PENDING_ACCESS_NOT_FOUND" };
  }
  if (m.includes("INVALID_PENDING_ID")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  // The Owner profile update's own named refusals.
  if (m.includes("OWNER_NOT_FOUND")) return { status: 404, code: "OWNER_NOT_FOUND" };
  if (m.includes("INVALID_NAME")) return { status: 400, code: "INVALID_NAME" };
  if (m.includes("INVALID_EMAIL")) return { status: 400, code: "INVALID_EMAIL" };
  if (m.includes("INVALID_PHONE")) return { status: 400, code: "INVALID_PHONE" };
  if (m.includes("MISSING_OWNER_NAME") || m.includes("MISSING_OWNER_EMAIL")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  if (m.includes("INVALID_EXPIRY_WINDOW")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  // Stage 9 - a module key the catalog does not know, or an empty choice.
  if (m.includes("INVALID_MODULES")) {
    return { status: 400, code: "INVALID_MODULES" };
  }
  // --- Stage 4A codes -----------------------------------------------------
  // IDENTITY_PENDING_ELECTION_OWNER is checked BEFORE IDENTITY_ALREADY_PRINCIPAL
  // only for readability; the two strings do not overlap, so order is not
  // load-bearing here. Both are 409: the request is well-formed and the caller
  // is authorized - the target identity is simply not eligible.
  if (m.includes("IDENTITY_PENDING_ELECTION_OWNER")) {
    return { status: 409, code: "IDENTITY_PENDING_ELECTION_OWNER" };
  }
  if (m.includes("IDENTITY_ALREADY_PRINCIPAL")) {
    return { status: 409, code: "IDENTITY_ALREADY_PRINCIPAL" };
  }
  // Distinct from NOT_PROVISIONED on purpose: "no owner exists yet" and "the
  // owner you named is not there" are different operator situations, and with
  // several owners the second is the one that actually happens.
  if (m.includes("MULTI_ENTITY_OWNER_NOT_FOUND")) {
    return { status: 404, code: "MULTI_ENTITY_OWNER_NOT_FOUND" };
  }
  if (m.includes("MULTI_ENTITY_OWNER_NOT_PROVISIONED")) {
    return { status: 409, code: "MULTI_ENTITY_OWNER_NOT_PROVISIONED" };
  }
  if (m.includes("WORKSPACE_NOT_FOUND")) {
    return { status: 404, code: "WORKSPACE_NOT_FOUND" };
  }
  // Gate 4 - global module availability.
  if (m.includes("MODULE_AVAILABILITY_FIXED")) {
    return { status: 409, code: "MODULE_AVAILABILITY_FIXED" };
  }
  if (m.includes("MODULE_NOT_FOUND")) {
    return { status: 404, code: "MODULE_NOT_FOUND" };
  }
  // --- Permanent workspace deletion ---------------------------------------
  // The typed confirmation did not match the workspace's own name. 409, not
  // 400: the request is well-formed and the caller is authorized - the
  // confirmation is simply not the one this workspace requires.
  if (m.includes("WORKSPACE_NAME_MISMATCH")) {
    return { status: 409, code: "WORKSPACE_NAME_MISMATCH" };
  }
  // The Budget delete guard refused. The workspace is untouched, and the
  // operator has a concrete next step - produce a fresh verified Budget
  // export - so these two codes are passed through rather than flattened.
  if (m.includes("BUDGET_EXPORT_REQUIRED")) {
    return { status: 409, code: "BUDGET_EXPORT_REQUIRED" };
  }
  if (m.includes("BUDGET_EXPORT_STALE")) {
    return { status: 409, code: "BUDGET_EXPORT_STALE" };
  }
  // Both mean the deletion refused to finish and rolled itself back. There is
  // no operator action, so they are reported as what they are: a server fault.
  if (
    m.includes("WORKSPACE_DELETE_INCOMPLETE") ||
    m.includes("BUDGET_PURGE_INCOMPLETE")
  ) {
    return { status: 500, code: "SERVER_ERROR" };
  }
  if (m.includes("INVALID_MODULE_AVAILABILITY")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  if (
    m.includes("MISSING_AUTH_USER_ID") ||
    m.includes("INVALID_WORKSPACE_ID") ||
    m.includes("INVALID_AUTH_CLEANUP_TARGET") ||
    m.includes("OWNER_NAME_TOO_LONG") ||
    m.includes("OWNER_EMAIL_TOO_LONG")
  ) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  return { status: 500, code: "SERVER_ERROR" };
}

/** Unwraps PostgREST's array-or-scalar RPC result shape. */
function rpcRow<T>(data: unknown): T | undefined {
  return (Array.isArray(data) ? data[0] : data) as T | undefined;
}

/**
 * True when a GoTrue Admin API error means "this account does not exist".
 *
 * Matched on the STRUCTURED fields GoTrue returns (HTTP 404 and the stable
 * `user_not_found` code), never on message text - message wording is not a
 * contract. Anything else is deliberately not treated as absence, so a
 * transient 5xx can never be mistaken for a completed deletion.
 */
function isAuthNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 404 || e.code === "user_not_found";
}

/**
 * Compensating delete for an Auth account THIS request created moments ago.
 *
 * Returns true only when the account is CONFIRMED gone. Two shapes count as
 * gone, and both must be recognised:
 *   - the delete itself succeeded, or
 *   - the account was already absent - GoTrue answers that with a STRUCTURED
 *     404 / "user_not_found", either on the delete or on a follow-up probe.
 * Anything else (a transient 5xx, an unreadable world) returns false: the
 * account MAY still exist, and the caller must say so rather than drop it.
 *
 * Same delete-then-probe classification handlePurgeReplacedAuthUser uses, on
 * structured status/code fields and never on message text. Deliberately a
 * separate helper rather than a refactor of that handler: its behaviour is
 * already production-verified, and this fix must not re-open it.
 */
async function deleteAuthUserConfirmed(
  supabase: ReturnType<typeof getServiceClient>,
  authUserId: string,
): Promise<boolean> {
  const { error: delErr } = await supabase.auth.admin.deleteUser(authUserId);
  if (!delErr) return true;
  // Already absent -> the compensation is complete. Idempotent, not an error.
  if (isAuthNotFound(delErr)) return true;

  const { data: probe, error: probeErr } =
    await supabase.auth.admin.getUserById(authUserId);
  return isAuthNotFound(probeErr) || (!probeErr && !probe?.user?.id);
}

/**
 * Provisioning failed AND the compensating Auth delete could not be confirmed,
 * so an orphaned Auth account may remain.
 *
 * The HTTP status and `error` code stay EXACTLY what the provisioning failure
 * alone would have returned, so existing client handling is unchanged; the two
 * extra fields are purely additive. `orphanedAuthUserId` is the plain UUID this
 * request just minted - an identifier the success path already returns as
 * `seatAuthUserId`, never a credential - and it is the one thing an operator
 * needs in order to remediate. No raw GoTrue/Postgres error text is included.
 */
function sendOrphanedAuthUser(
  res: MinimalResponse,
  status: number,
  code: string,
  orphanedAuthUserId: string,
): void {
  res.status(status).json({
    error: code,
    warning: "AUTH_CLEANUP_INCOMPLETE",
    orphanedAuthUserId,
  });
}

/**
 * Close a provisioning orphan's lifecycle: the attempt failed AND the account
 * it minted is CONFIRMED gone, so write the terminal audit row.
 *
 * Without this, a failed provision whose compensating delete SUCCEEDED left the
 * write-ahead `provisioning_auth_minted` row with no terminal counterpart, and
 * platform_get_multi_entity_state - which derives eligibility from exactly that
 * absence - went on listing an account that no longer exists. The console then
 * showed a permanent "delete this account" card for nothing: a phantom cleanup
 * task standing in front of genuine ones.
 *
 * MAY ONLY BE CALLED WHERE THE MINT RECORD IS KNOWN TO BE DURABLE.
 * platform_record_provisioning_orphan_cleanup deliberately does NOT re-check
 * the mint binding - that check lives in platform_check_provisioning_orphan_-
 * purgeable, which runs on the operator-driven purge path where the id is
 * untrusted input. Here the id is not untrusted: it is `created.user.id` from
 * this same request, and the mint RPC returned success moments ago. Both call
 * sites below are past that point, which is exactly why the mint-failure branch
 * does NOT call this - an id with no committed mint row must never acquire a
 * terminal cleanup row, because that would assert history that was rolled back.
 *
 * Returns whether the terminal row is durable. Idempotent: a duplicate is
 * absorbed by the recorder (existing-row short-circuit, plus a unique_violation
 * catch for a genuine race), so a repeat converges instead of raising.
 */
async function recordProvisioningOrphanCleared(
  supabase: ReturnType<typeof getServiceClient>,
  platformOwnerAuthUserId: string,
  authUserId: string,
): Promise<boolean> {
  const { error } = await supabase.rpc("platform_record_provisioning_orphan_cleanup", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_auth_user_id: authUserId,
    p_deleted: true,
  });
  return !error;
}

/**
 * Provisioning failed and the compensating Auth delete IS confirmed.
 *
 * The HTTP status and `error` code are always the provisioning failure's own,
 * unchanged. When the terminal audit row was also written this is an ordinary
 * error response and nothing is added.
 *
 * When only the audit write failed, saying nothing would be a lie by omission:
 * the destructive step DID happen. It deliberately does not reuse
 * AUTH_CLEANUP_INCOMPLETE - that code means "an account may still exist", which
 * is the opposite of what is known here - and it does not return
 * `orphanedAuthUserId`, because there is no orphaned account to hand back. It
 * reuses handlePurgeProvisioningOrphan's exact vocabulary for exactly the same
 * situation (`accountDeleted` / `auditRecorded` / AUTH_CLEANUP_AUDIT_WRITE_-
 * FAILED) rather than minting a second name for it.
 *
 * Recovery needs nothing from this response: the mint row is still terminal-
 * less, so the id stays in pending_provisioning_orphans and the operator's
 * ordinary purge converges on it - the guard passes, the delete probes absent,
 * and the terminal row is written then. No raw GoTrue/Postgres text is
 * included in either shape.
 */
function sendProvisioningFailure(
  res: MinimalResponse,
  status: number,
  code: string,
  auditRecorded: boolean,
): void {
  if (auditRecorded) {
    sendError(res, status, code);
    return;
  }
  res.status(status).json({
    error: code,
    warning: "AUTH_CLEANUP_AUDIT_WRITE_FAILED",
    accountDeleted: true,
    auditRecorded: false,
  });
}

/**
 * Approve a new Election Owner.
 *
 * Order matters and is not interchangeable:
 *   0. (Stage 8B) Classify the address first - an existing approval answers
 *      409 APPROVAL_EXISTS (re-issue it from the list), any other account
 *      409 EMAIL_ALREADY_REGISTERED, and only an unheld account this flow
 *      itself minted earlier (app_metadata marker) is re-used. No duplicate.
 *   1. Create the Supabase Auth user with NO PASSWORD. The Platform Owner
 *      never sets and never learns an Election Owner's credential - the same
 *      rule scripts/platform-owner-bootstrap.mjs already enforces for the
 *      Platform Owner's own account.
 *   2. Record pending access. This must come second because that table's
 *      auth_user_id carries a FK to auth.users.
 *   3. If step 2 fails, delete the Auth user created in step 1 - a
 *      compensating action scoped to the one id this request just created,
 *      never an id found by lookup.
 *   4. Mint a one-time recovery link so the Owner sets their own password.
 *
 * The link returned is the DIRECT token_hash URL, not GoTrue's action link.
 * The direct form is redeemed client-side with verifyOtp(), so it never
 * touches GoTrue's /verify endpoint and therefore does NOT depend on the
 * project's Site URL or its Redirect URLs allow-list - which on this project
 * still point at localhost and would silently swallow the redirect. It also
 * never puts an #access_token fragment on our origin for another Supabase
 * client on the page to consume. Same reasoning, same two-link analysis, as
 * scripts/platform-owner-bootstrap.mjs.
 */
/**
 * The login-username half of provisioning, shared by both Owner classes.
 *
 * WHY IT LIVES HERE. Every dedicated login surface resolves a principal
 * through auth_identities. An Owner created without a directory row is an
 * Owner who can never sign in, so claiming the username is part of
 * provisioning, not an afterthought.
 *
 * Checked BEFORE any Auth account is created, so the ordinary collision case
 * costs nothing and answers with the next free name instead of a bare error -
 * the same contract the worker create path uses.
 */
async function usernameUnavailable(
  supabase: ReturnType<typeof getServiceClient>,
  res: MinimalResponse,
  realm: string,
  username: string,
): Promise<boolean> {
  // ONE call, and deliberately the SUGGESTION function rather than a resolve.
  // It answers the base itself exactly when the base is free, so "is it
  // taken" and "what should I offer instead" come from a single source that
  // is by construction the same namespace auth_identity_assign will enforce.
  //
  // A resolve would be wrong in two ways now: it is scoped to ONE realm,
  // while a shared-login username competes across all of them, and it ignores
  // a disabled row - which still reserves its name, so a resolve would report
  // free a username the unique index then refuses.
  const { data: suggestion, error } = await supabase.rpc(
    "auth_identity_suggest_username",
    { p_realm: realm, p_base: username },
  );
  if (error) {
    sendError(res, 500, "SERVER_ERROR");
    return true;
  }
  const offered = typeof suggestion === "string" ? suggestion : null;
  // Compared on the canonical form the function itself returns, so a trimmed
  // or differently-composed input is not mistaken for a collision.
  if (offered !== null && offered === username.trim().normalize("NFC")) return false;

  res.status(409).json({
    error: "USERNAME_TAKEN",
    requested: username,
    suggestion: offered,
  });
  return true;
}

/** The login username a principal holds, or null when unclaimed. Used for the
 * Platform Owner's own identity and for the Multi-Entity seat holder's - both
 * keyed by a SERVER-VERIFIED auth user id, never anything client-supplied. */
async function readOwnUsername(authUserId: string): Promise<string | null> {
  try {
    const supabase = getServiceClient();
    // Through the DEFINER accessor, never a direct table read: auth_identities
    // grants nothing to any role by design.
    const { data, error } = await supabase.rpc("auth_identity_for_subject", {
      p_auth_user_id: authUserId,
    });
    if (error) return null;
    return typeof data === "string" && data !== "" ? data : null;
  } catch {
    return null;
  }
}

/** Maps auth_identity_assign's named errors onto the console's shapes. */
function usernameErrorCode(message: string): { status: number; code: string } {
  if (message.includes("USERNAME_TAKEN")) return { status: 409, code: "USERNAME_TAKEN" };
  if (message.includes("SUBJECT_ALREADY_ASSIGNED")) {
    return { status: 409, code: "USERNAME_ALREADY_SET" };
  }
  return { status: 400, code: "INVALID_USERNAME" };
}

/**
 * The Platform Owner sets their OWN application username - the identity the
 * dedicated /login/platform-owner screen resolves. Claimed once; a username is
 * permanent for the life of the principal.
 */
async function handleSetOwnUsername(
  req: MinimalRequest,
  res: MinimalResponse,
  authUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = str(body.username).trim();
  if (!username) {
    sendError(res, 400, "INVALID_USERNAME");
    return;
  }
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  if (await usernameUnavailable(supabase, res, "platform_owner", username)) return;

  const { error } = await supabase.rpc("auth_identity_assign", {
    p_realm: "platform_owner",
    p_username: username,
    p_auth_user_id: authUserId,
    p_actor_id: null,
    p_workspace_id: null,
  });
  if (error) {
    const { status, code } = usernameErrorCode(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  res.status(200).json({ ok: true, username });
}

async function handleCreateOwnerAccess(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = str(body.name);
  const email = str(body.email).toLowerCase();
  const phone = str(body.phone);
  const username = str(body.username).trim();
  const expiresInDaysRaw = body.expiresInDays;

  // A contact phone is REQUIRED now: the console offers to hand the new Owner
  // their login details over WhatsApp, and there is nothing to send them to
  // without one. Existing rows that predate this keep their null - nothing
  // backfills them and nothing reads them as mandatory.
  const normalizedPhone = normalizedIsraeliPhone(phone);
  if (!name || !email || !looksLikeEmail(email) || !username || !normalizedPhone) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (name.length > 200 || phone.length > 40) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Stage 9: the Platform Owner must choose the workspace's modules
  // explicitly. Checked before any Auth user is created.
  const modules = parseModules(body.modules);
  if (!modules) {
    sendError(res, 400, "INVALID_MODULES");
    return;
  }

  let expiresInDays = 7;
  if (expiresInDaysRaw !== undefined && expiresInDaysRaw !== null) {
    if (
      typeof expiresInDaysRaw !== "number" ||
      !Number.isInteger(expiresInDaysRaw) ||
      expiresInDaysRaw < 1 ||
      expiresInDaysRaw > 30
    ) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    expiresInDays = expiresInDaysRaw;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // Stage 9: every requested module must exist in the catalog - checked
  // BEFORE any Auth user is created, so a bad choice never mints an account.
  // The approval RPC re-validates the same set inside its own transaction.
  const { data: catalogRows, error: catalogErr } = await supabase
    .from("platform_modules")
    .select("key");
  if (catalogErr) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  const knownModules = new Set(
    (Array.isArray(catalogRows) ? catalogRows : []).map((r) =>
      String((r as { key?: unknown }).key),
    ),
  );
  if (!modules.every((m) => knownModules.has(m))) {
    sendError(res, 400, "INVALID_MODULES");
    return;
  }

  // --- 0a. The login username must be free BEFORE anything is created, so
  // the ordinary collision case costs nothing and answers with the next free
  // name instead of a bare error.
  if (await usernameUnavailable(supabase, res, "election_owner", username)) return;

  // --- 0. Classify the address BEFORE creating anything (Stage 8B) ---------
  // An address with an approval is re-issued from the approvals list, never
  // re-created; any other existing account is refused as before. Only an
  // account this same flow created and failed to attach (marker, unheld) is
  // re-used - so no request here ever creates a duplicate Auth user.
  const { data: cls, error: clsErr } = await supabase.rpc(
    "platform_classify_owner_access_email",
    { p_platform_owner_auth_user_id: platformOwnerAuthUserId, p_email: email },
  );
  if (clsErr) {
    const { status, code } = mapRpcError(clsErr.message ?? "");
    sendError(res, status, code);
    return;
  }
  const classified = rpcRow<{ classification?: unknown; auth_user_id?: unknown }>(cls);
  const kind = classified?.classification;
  if (kind === "approval_exists") {
    sendError(res, 409, "APPROVAL_EXISTS");
    return;
  }
  if (kind === "registered") {
    sendError(res, 409, "EMAIL_ALREADY_REGISTERED");
    return;
  }

  // --- 1. Auth user, no password ------------------------------------------
  let authUserId: string;
  // Whether THIS request created the account - only such an account may be
  // deleted by the compensation below. An adopted one pre-dates the request.
  let createdHere: boolean;
  if (
    kind === "adoptable" &&
    typeof classified?.auth_user_id === "string" &&
    UUID_PATTERN.test(classified.auth_user_id)
  ) {
    authUserId = classified.auth_user_id;
    createdHere = false;
  } else if (kind === "new") {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: ELECTION_OWNER_MINT_MARKER,
    });

    if (createErr || !created?.user?.id) {
      // Most often a concurrent request created the address between the
      // classification and here. GoTrue does not answer that race with a
      // stable shape (observed locally: status 500, message "{}"), so the
      // address is re-classified instead of the message being trusted. Never
      // adopted from this branch - the other request may still be mid-flight.
      const { data: again } = await supabase.rpc("platform_classify_owner_access_email", {
        p_platform_owner_auth_user_id: platformOwnerAuthUserId,
        p_email: email,
      });
      const now = rpcRow<{ classification?: unknown }>(again)?.classification;
      if (now === "approval_exists") {
        sendError(res, 409, "APPROVAL_EXISTS");
        return;
      }
      const msg = (createErr?.message ?? "").toLowerCase();
      if (
        (typeof now === "string" && now !== "new") ||
        msg.includes("already") ||
        msg.includes("registered")
      ) {
        sendError(res, 409, "EMAIL_ALREADY_REGISTERED");
        return;
      }
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    authUserId = created.user.id;
    createdHere = true;
  } else {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  // --- 1b. Claim the Owner's login username --------------------------------
  // Before the approval row, so a collision costs only the compensating
  // delete of the account created moments ago and leaves no approval behind.
  //
  // IDEMPOTENT for a re-approval: when this flow adopts an account it created
  // earlier, that account already holds its username. Re-approval never
  // RENAMES a principal - the existing name stands and the claim is skipped,
  // so re-approving cannot fail with SUBJECT_ALREADY_ASSIGNED. An Election
  // Owner's username is no longer permanent, though: an authorized Platform
  // Owner may change it from the console through `set_owner_username`, which
  // releases the old name and claims the new one and records the change.
  const existingUsername = await readOwnUsername(authUserId);
  const { error: usernameErr } = existingUsername
    ? { error: null as null }
    : await supabase.rpc("auth_identity_assign", {
        p_realm: "election_owner",
        p_username: username,
        p_auth_user_id: authUserId,
        p_actor_id: null,
        p_workspace_id: null,
      });
  if (usernameErr) {
    const { status, code } = usernameErrorCode(usernameErr.message ?? "");
    await sendOwnerAccessFailure(
      res,
      supabase,
      status,
      code,
      createdHere ? authUserId : null,
    );
    return;
  }

  // --- 2. Pending access row ----------------------------------------------
  const { data: pending, error: rpcErr } = await supabase.rpc(
    "platform_create_pending_owner_access",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_name: name,
      p_email: email,
      p_phone: normalizedPhone,
      p_expires_in_days: expiresInDays,
      p_modules: modules,
    },
  );

  if (rpcErr) {
    // --- 3. Compensating delete, scoped to the id created moments ago ------
    const { status, code } = mapRpcError(rpcErr.message ?? "");
    await sendOwnerAccessFailure(
      res,
      supabase,
      status,
      code,
      createdHere ? authUserId : null,
    );
    return;
  }

  const row = (Array.isArray(pending) ? pending[0] : pending) as
    | { pending_id?: unknown; expires_at?: unknown; already_existed?: unknown }
    | undefined;

  if (!row || typeof row.pending_id !== "string") {
    await sendOwnerAccessFailure(
      res,
      supabase,
      500,
      "SERVER_ERROR",
      createdHere ? authUserId : null,
    );
    return;
  }

  // --- 4. One-time activation link ----------------------------------------
  // The pending row and the Auth user are both valid at this point, so a link
  // failure is NOT rolled back - the approval stands and a new link can be
  // issued from the approvals list (reissue_owner_access). The console is told
  // so explicitly rather than being shown a half-success it cannot interpret.
  const activationLink = await mintOwnerActivationLink(supabase, email);

  res.status(201).json({
    pendingId: row.pending_id,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    alreadyExisted: row.already_existed === true,
    activationLink,
  });
}

/**
 * The MULTI-ENTITY Owner's one-time set-password link for an EXISTING Auth
 * account, or null when GoTrue could not mint one.
 *
 * THE ONLY place a Multi-Entity set-password link is created - provisioning
 * and re-issuing both call this, so there is exactly one credential flow and
 * the two can never diverge in mechanism, origin or token type.
 *
 * Security property, verified empirically against the pinned GoTrue rather
 * than assumed: minting a recovery link REPLACES the account's previous
 * recovery token, so issuing a new one invalidates any earlier link for that
 * account, and redeeming a link consumes it so it cannot be replayed. That is
 * what makes re-issue safe - an operator who re-issues has, by that act,
 * killed whatever link was circulating before.
 */
async function mintMultiEntityActivationLink(
  supabase: ReturnType<typeof getServiceClient>,
  email: string,
  baseUrl: string,
): Promise<string | null> {
  const redirectTo = `${baseUrl}${MULTI_ENTITY_SET_PASSWORD_PATH}`;
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  const hashedToken = link?.properties?.hashed_token;
  return !linkErr && typeof hashedToken === "string" && hashedToken
    ? `${redirectTo}?${new URLSearchParams({ token_hash: hashedToken, type: "recovery" }).toString()}`
    : null;
}

/**
 * The Election Owner's direct token_hash set-password link for an EXISTING
 * Auth account, or null when GoTrue could not mint one. A recovery link
 * replaces the account's previous recovery token, so issuing a new one
 * invalidates any earlier link for the same account.
 */
async function mintOwnerActivationLink(
  supabase: ReturnType<typeof getServiceClient>,
  email: string,
): Promise<string | null> {
  const redirectTo = `${electionAppBaseUrl()}${OWNER_SET_PASSWORD_PATH}`;
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  const hashedToken = link?.properties?.hashed_token;
  return !linkErr && typeof hashedToken === "string" && hashedToken
    ? `${redirectTo}?${new URLSearchParams({ token_hash: hashedToken, type: "recovery" }).toString()}`
    : null;
}

/**
 * create_owner_access failed after an Auth account was attached to it.
 *
 * Stage 8B: the compensating delete is CONFIRMED (deleteAuthUserConfirmed),
 * never fire-and-forget. When it cannot be confirmed the response keeps the
 * failure's own status/code and adds AUTH_CLEANUP_INCOMPLETE + the id
 * (sendOrphanedAuthUser, the Stage 4A shape). That account carries the mint
 * marker, so re-approving the same address re-uses it rather than creating a
 * duplicate. An ADOPTED account (createdAuthUserId null) pre-dates this request
 * and is never deleted here - it simply stays re-usable.
 */
async function sendOwnerAccessFailure(
  res: MinimalResponse,
  supabase: ReturnType<typeof getServiceClient>,
  status: number,
  code: string,
  createdAuthUserId: string | null,
): Promise<void> {
  if (
    createdAuthUserId &&
    !(await deleteAuthUserConfirmed(supabase, createdAuthUserId))
  ) {
    sendOrphanedAuthUser(res, status, code, createdAuthUserId);
    return;
  }
  sendError(res, status, code);
}

/** Stage 8B: every Election Owner approval, with its derived state. */
async function handleOwnerAccessList(
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_list_owner_access", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  res.status(200).json({ approvals: Array.isArray(data) ? data : [] });
}

/**
 * Stage 8B: re-issue access for one approval - a new one-time link for an
 * active approval (window unchanged), or a renewed window plus a link for an
 * expired one. Never creates an Auth user: the link is minted for the
 * approval's own existing account, whose address is read by id from GoTrue.
 * The DB refuses a consumed approval or an account now held by a principal.
 */
async function handleReissueOwnerAccess(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pendingId = str(body.pendingId);
  if (!UUID_PATTERN.test(pendingId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_reissue_pending_owner_access", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_pending_id: pendingId,
    p_expires_in_days: 7,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  const row = rpcRow<{ auth_user_id?: unknown; expires_at?: unknown; renewed?: unknown }>(
    data,
  );
  if (!row || typeof row.auth_user_id !== "string") {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  // The renewal (if any) is already committed; a link failure leaves it in
  // place and a repeat of this op simply issues the link.
  const { data: account, error: accountErr } = await supabase.auth.admin.getUserById(
    row.auth_user_id,
  );
  const accountEmail = !accountErr ? (account?.user?.email ?? null) : null;
  const activationLink = accountEmail
    ? await mintOwnerActivationLink(supabase, accountEmail)
    : null;

  // Stage 8D (H-3): close the reissue-after-consume race. The reissue RPC above
  // serializes with election_day_provision_workspace on the pending row's FOR
  // UPDATE lock, so a provisioning that committed BEFORE the RPC already made it
  // raise 409. But a provisioning can also commit DURING the mint just above -
  // after the RPC returned "active" - which would otherwise leave the link we
  // just minted live for a consumed approval. Re-check the approval now: if it
  // is consumed, the just-minted recovery token is invalidated server-side and
  // we answer 409 instead of returning a usable post-consumption link.
  const { data: finalize, error: finalizeErr } = await supabase.rpc(
    "platform_reissue_finalize",
    { p_platform_owner_auth_user_id: platformOwnerAuthUserId, p_pending_id: pendingId },
  );
  if (finalizeErr) {
    const { status, code } = mapRpcError(finalizeErr.message ?? "");
    sendError(res, status, code);
    return;
  }
  if (rpcRow<{ consumed?: unknown }>(finalize)?.consumed === true) {
    sendError(res, 409, "PENDING_ACCESS_ALREADY_CONSUMED");
    return;
  }

  res.status(200).json({
    pendingId,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    renewed: row.renewed === true,
    activationLink,
  });
}

// ---------------------------------------------------------------------------
// Stage 4A - Multi-Entity Owner seat + workspace assignments.
//
// Every handler below is Platform-Owner-only and reaches the database through a
// SECURITY DEFINER RPC that independently re-resolves the caller against
// platform_owners. None of them grants the Multi-Entity Owner any runtime
// access: this stage creates that principal's identity and records their
// assignments, and nothing more. Authentication, AAL2 and entity-scoped
// authorization for that principal belong to a later stage.
// ---------------------------------------------------------------------------

async function handleMultiEntityState(
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_get_multi_entity_state", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
  });

  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  // Each owner's own login username, merged in from the identity directory.
  // The RPC above cannot return it (auth_identities is a separate concern with
  // its own DEFINER accessor), and without it the hand-off details the console
  // shows after provisioning are unrecoverable on the next page load - the
  // operator is left knowing an owner's e-mail but not the name they must
  // actually type to sign in. Additive and non-fatal: unreadable means the
  // field is simply absent, never a failed read of the whole section.
  //
  // Resolved in PARALLEL, not in a loop: this is now N round trips rather than
  // one, and N grows with the number of owners.
  const state = (data ?? { owners: [], workspaces: [] }) as {
    owners?: unknown;
  };
  const owners = Array.isArray(state.owners) ? state.owners : [];
  const withUsernames = await Promise.all(
    owners.map(async (owner) => {
      const row = owner as { auth_user_id?: unknown };
      const authUserId = typeof row.auth_user_id === "string" ? row.auth_user_id : null;
      if (!authUserId) return owner;
      return { ...row, username: await readOwnUsername(authUserId) };
    }),
  );

  res.status(200).json({ ...state, owners: withUsernames });
}

/**
 * Re-issue a Multi-Entity Owner's one-time set-password link.
 *
 * WHY THIS EXISTS. The link is minted once, at provisioning, and held in the
 * console's memory only - never persisted, because it is a credential. That
 * is the right rule, but until now it left no way back: an operator who lost
 * the link before handing it over had to REPLACE the owner (to a temporary
 * address, purge, replace back) just to mint another. That is a destructive
 * workaround for a non-destructive problem.
 *
 * THIS INVENTS NO SECOND CREDENTIAL FLOW. It mints through exactly the same
 * helper provisioning uses, for the same account, with the same recovery
 * token type and the same Multi-Entity redirect. The only difference is that
 * no account is created.
 *
 * AUTHORIZATION. The caller is already a verified Platform Owner (checked
 * before dispatch). `platform_get_multi_entity_state` re-resolves that
 * independently and is the ONLY source of which owners exist, so an ownerId
 * that is not a live Multi-Entity Owner cannot be turned into a link - the
 * op can never mint a recovery link for an arbitrary account.
 *
 * The e-mail is read from GoTrue by the owner's auth id rather than taken
 * from the console, mirroring the Stage 8B reissue: the address the link is
 * sent to must be the account's own, never one supplied by the caller.
 *
 * Re-issuing INVALIDATES the previous link for that account (a new recovery
 * token replaces the old one), so this cannot leave two live links behind.
 */
async function handleReissueMultiEntityPasswordLink(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ownerId = str(body.ownerId);
  if (!ownerId || !UUID_PATTERN.test(ownerId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Resolved BEFORE anything else, exactly as provisioning does: a missing
  // production configuration must never produce a link pointing somewhere
  // else, and must fail closed instead.
  const multiEntityBaseUrl = multiEntityAppBaseUrl();
  if (!multiEntityBaseUrl) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_get_multi_entity_state", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  const owners = Array.isArray((data as { owners?: unknown })?.owners)
    ? ((data as { owners: unknown[] }).owners as Array<{
        owner_id?: unknown;
        auth_user_id?: unknown;
      }>)
    : [];
  const owner = owners.find((o) => o.owner_id === ownerId);
  if (!owner || typeof owner.auth_user_id !== "string") {
    sendError(res, 404, "MULTI_ENTITY_OWNER_NOT_FOUND");
    return;
  }

  const { data: account, error: accountErr } = await supabase.auth.admin.getUserById(
    owner.auth_user_id,
  );
  const accountEmail = !accountErr ? (account?.user?.email ?? null) : null;
  if (!accountEmail) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const activationLink = await mintMultiEntityActivationLink(
    supabase,
    accountEmail,
    multiEntityBaseUrl,
  );
  if (!activationLink) {
    // Nothing was changed by a failed mint; the operator can simply retry.
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  // The link is returned to the caller and NOWHERE else: not logged, not
  // stored, not audited. It is a credential, and the console holds it in
  // memory only for as long as its panel is on screen.
  res.status(200).json({ ownerId, activationLink });
}

/**
 * Revoke ONE Multi-Entity Owner.
 *
 * With a single seat, "replace" WAS revocation - there was no way to end the
 * capability except by handing it to someone else. With several owners that
 * conflation breaks down, so removal is its own operation.
 *
 * Like replacement, it deliberately does NOT delete the Auth account: that
 * stays a separate, separately-approved destructive step, and the removed
 * account shows up in the same durable cleanup queue a replaced one does.
 */
async function handleRemoveMultiEntityOwner(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ownerId = str(body.ownerId);

  if (!ownerId || !UUID_PATTERN.test(ownerId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_remove_multi_entity_owner", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_owner_id: ownerId,
  });

  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  const row = rpcRow<{
    previous_auth_user_id?: unknown;
    assignments_removed?: unknown;
  }>(data);

  res.status(200).json({
    removed: true,
    ownerId,
    // Returned so the console can point the operator at the purge step; the
    // queue itself still comes from durable server state, never from here.
    previousAuthUserId:
      typeof row?.previous_auth_user_id === "string" ? row.previous_auth_user_id : null,
    assignmentsRemoved:
      typeof row?.assignments_removed === "number" ? row.assignments_removed : 0,
  });
}

/**
 * Create or replace the singleton Multi-Entity Owner.
 *
 * This handler NEVER deletes the previous Auth account, in any environment.
 * Replacement is deliberately a two-operation flow: the seat is updated here,
 * and purging the replaced account is a separate, separately-approved request
 * to purge_replaced_auth_user. There is no environment-conditional destructive
 * path - a destructive branch that only runs "somewhere else" is exactly the
 * shape that produces "it was safe locally" incidents.
 *
 * Ordering is not interchangeable: multi_entity_owner.auth_user_id is
 * ON DELETE CASCADE from auth.users, so deleting the old account before the
 * seat UPDATE would delete the seat row itself.
 */
async function handleProvisionMultiEntityOwner(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = str(body.name);
  const email = str(body.email).toLowerCase();
  const phone = str(body.phone);
  const meUsername = str(body.username).trim();
  // ABSENT  -> add a NEW Multi-Entity Owner alongside any existing ones.
  // PRESENT -> replace THAT owner's Auth identity, keeping their assignments.
  // An empty string is not "absent": it is a malformed selector, and treating
  // it as "add" would turn a client bug into a surprise extra owner.
  const meOwnerId = Object.hasOwn(body, "ownerId") ? str(body.ownerId) : null;

  // Required here too, so the two provisioning paths cannot drift apart.
  const meNormalizedPhone = normalizedIsraeliPhone(phone);
  if (!name || !email || !looksLikeEmail(email) || !meUsername || !meNormalizedPhone) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (meOwnerId !== null && !UUID_PATTERN.test(meOwnerId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (name.length > 200 || phone.length > 40) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Stage 5: the set-password link must target the dedicated Multi-Entity
  // origin. Resolved FIRST, before any Auth account exists, so a missing
  // production configuration can never strand an orphan or fall back to the
  // Election origin.
  const multiEntityBaseUrl = multiEntityAppBaseUrl();
  if (!multiEntityBaseUrl) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // --- 1. Auth user, no password (same rule as an Election Owner) ----------
  // Same pre-check as the Election Owner path: free the collision case from
  // ever creating an Auth account.
  if (await usernameUnavailable(supabase, res, "multi_entity_owner", meUsername)) return;

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (createErr || !created?.user?.id) {
    const msg = (createErr?.message ?? "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered")) {
      sendError(res, 409, "EMAIL_ALREADY_REGISTERED");
      return;
    }
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const authUserId = created.user.id;

  // --- 1b. WRITE-AHEAD durable record, in its OWN transaction --------------
  // This must happen BEFORE the seat RPC and cannot be folded into it.
  // PostgREST runs one transaction per RPC call, and the seat RPC RAISES on
  // failure - so anything it wrote, audit row included, rolls back with it.
  // A record written there would vanish in exactly the case it exists for.
  // Written here, it survives that rollback and is what makes an orphaned
  // account recoverable after a reload instead of living only in the response
  // body below.
  const { error: mintErr } = await supabase.rpc(
    "platform_record_provisioning_auth_mint",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_email: email,
    },
  );

  if (mintErr) {
    // FAIL CLOSED. An identity we cannot durably account for must not be
    // provisioned: proceeding would recreate the very gap this record closes,
    // and the account is seconds old and holds nothing, so compensating now is
    // strictly safer than continuing. Same delete-then-probe classification and
    // the same unconfirmed-cleanup reporting as the seat-failure path below.
    //
    // NO terminal cleanup row is written on this branch, in either outcome.
    // The write that failed IS the binding evidence, so there is no mint record
    // for a terminal row to close, and inventing one would assert a history
    // that was rolled back. Nothing is lost by staying silent: with no mint
    // row, this id was never eligible for pending_provisioning_orphans in the
    // first place, so a confirmed delete needs no bookkeeping to disappear from
    // the console. The unconfirmed case keeps the response-only warning below -
    // and that is genuinely the limit of what is recoverable here, because
    // durable recovery is precisely the thing that failed.
    const cleaned = await deleteAuthUserConfirmed(supabase, authUserId);
    const { status, code } = mapRpcError(mintErr.message ?? "");
    if (!cleaned) {
      sendOrphanedAuthUser(res, status, code, authUserId);
      return;
    }
    sendError(res, status, code);
    return;
  }

  // --- 1b. Claim the seat holder's login username --------------------------
  // Same rule as the Election Owner: without a directory row the holder could
  // never reach /login/multi-entity-owner.
  const { error: meUsernameErr } = await supabase.rpc("auth_identity_assign", {
    p_realm: "multi_entity_owner",
    p_username: meUsername,
    p_auth_user_id: authUserId,
    p_actor_id: null,
    p_workspace_id: null,
  });
  if (meUsernameErr) {
    await deleteAuthUserConfirmed(supabase, authUserId);
    const { status, code } = usernameErrorCode(meUsernameErr.message ?? "");
    sendError(res, status, code);
    return;
  }

  // --- 2. Seat -------------------------------------------------------------
  // The _v2 contract (EXPAND migration 20260926000000). The 5-argument
  // original still exists during the overlap window for the PREVIOUS
  // deployment; this code never calls it, because it can and must name the
  // owner it means rather than relying on there being only one.
  const { data: seat, error: rpcErr } = await supabase.rpc(
    "platform_provision_multi_entity_owner_v2",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_name: name,
      p_email: email,
      p_phone: meNormalizedPhone,
      p_owner_id: meOwnerId,
    },
  );

  if (rpcErr) {
    // --- 3. Compensating delete, scoped to the id created moments ago ------
    // The previous seat holder is untouched: the RPC either committed or did
    // not, and this deletes only the account this request just created.
    // An UNCONFIRMED delete is reported, never swallowed - the provisioning
    // failure code is preserved either way.
    const cleaned = await deleteAuthUserConfirmed(supabase, authUserId);
    const { status, code } = mapRpcError(rpcErr.message ?? "");
    if (!cleaned) {
      // The account MAY still exist. No terminal row: the mint record must stay
      // the sole outstanding fact so the console keeps listing it for cleanup.
      sendOrphanedAuthUser(res, status, code, authUserId);
      return;
    }
    // Confirmed gone - close the lifecycle the mint record opened, so the
    // console does not list an account that is already deleted.
    const auditRecorded = await recordProvisioningOrphanCleared(
      supabase,
      platformOwnerAuthUserId,
      authUserId,
    );
    sendProvisioningFailure(res, status, code, auditRecorded);
    return;
  }

  const row = rpcRow<{
    owner_id?: unknown;
    already_existed?: unknown;
    replaced?: unknown;
    previous_auth_user_id?: unknown;
  }>(seat);

  if (!row) {
    // Same orphan risk as the rpcErr branch above: the account exists, the
    // seat does not, so an unconfirmed cleanup must not be silent either.
    const cleaned = await deleteAuthUserConfirmed(supabase, authUserId);
    if (!cleaned) {
      sendOrphanedAuthUser(res, 500, "SERVER_ERROR", authUserId);
      return;
    }
    const auditRecorded = await recordProvisioningOrphanCleared(
      supabase,
      platformOwnerAuthUserId,
      authUserId,
    );
    sendProvisioningFailure(res, 500, "SERVER_ERROR", auditRecorded);
    return;
  }

  const replaced = row.replaced === true;
  const previousAuthUserId =
    typeof row.previous_auth_user_id === "string" ? row.previous_auth_user_id : null;

  // --- 4. One-time set-password link (Multi-Entity origin, Stage 5) --------
  // Through the SHARED minter, so provisioning and re-issue cannot drift.
  const activationLink = await mintMultiEntityActivationLink(
    supabase,
    email,
    multiEntityBaseUrl,
  );

  // requiresDestructiveApproval is surfaced explicitly rather than quietly
  // leaving an orphaned Auth account behind: the console must show this as an
  // outstanding operator action.
  res.status(201).json({
    ownerId: typeof row.owner_id === "string" ? row.owner_id : null,
    seatAuthUserId: authUserId,
    alreadyExisted: row.already_existed === true,
    replaced,
    previousAuthUserId,
    previousAccountDeleted: false,
    requiresDestructiveApproval: replaced && previousAuthUserId !== null,
    activationLink,
  });
}

async function handleWorkspaceAssignment(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
  rpc: "platform_assign_workspace_v2" | "platform_unassign_workspace_v2",
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);
  // REQUIRED, and validated here rather than left to the RPC: an assignment
  // that names no owner has no safe interpretation once several exist.
  const ownerId = str(body.ownerId);

  if (
    !workspaceId ||
    !UUID_PATTERN.test(workspaceId) ||
    !ownerId ||
    !UUID_PATTERN.test(ownerId)
  ) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc(rpc, {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_owner_id: ownerId,
    p_workspace_id: workspaceId,
  });

  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  res.status(200).json(data ?? {});
}

/**
 * Purge a replaced Multi-Entity Owner's Auth account. DESTRUCTIVE.
 *
 * Two conditions are deliberately never conflated:
 *   - "a success audit row already exists" - a RECORD fact, from the guard RPC.
 *   - "the Auth user is already absent"    - a WORLD fact, established here by
 *     probing getUserById.
 * Either is sufficient to stop deleting, but only the first means the audit
 * trail is complete. "Absent but unrecorded" is precisely the state that a
 * delete-succeeded-then-audit-write-failed run leaves behind, and re-running
 * this handler is what recovers it.
 *
 * Absence is treated as terminal success rather than an error because the guard
 * has already bound this id to a real `replaced` audit event - it cannot be an
 * arbitrary or mistyped account.
 */
async function handlePurgeReplacedAuthUser(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const previousAuthUserId = str(body.previousAuthUserId);

  if (!previousAuthUserId || !UUID_PATTERN.test(previousAuthUserId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // --- 1. Guard ------------------------------------------------------------
  const { data: guard, error: guardErr } = await supabase.rpc(
    "platform_check_auth_user_purgeable",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: previousAuthUserId,
    },
  );

  if (guardErr) {
    const { status, code } = mapRpcError(guardErr.message ?? "");
    sendError(res, status, code);
    return;
  }

  const g = rpcRow<{
    purgeable?: unknown;
    reason?: unknown;
    held_by?: unknown;
    already_completed?: unknown;
  }>(guard);

  if (!g) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  if (g.already_completed === true) {
    res.status(200).json({
      previousAuthUserId,
      previousAccountDeleted: true,
      auditRecorded: true,
      alreadyCompleted: true,
    });
    return;
  }

  if (g.purgeable !== true) {
    const reason = typeof g.reason === "string" ? g.reason : "AUTH_USER_STILL_HELD";
    res.status(409).json({
      error: reason === "NOT_A_REPLACED_PRINCIPAL" ? reason : "AUTH_USER_STILL_HELD",
      heldBy: typeof g.held_by === "string" ? g.held_by : null,
    });
    return;
  }

  // --- 2. Delete, then classify by PROBING (never by error-string sniffing) -
  const { error: delErr } = await supabase.auth.admin.deleteUser(previousAuthUserId);

  let deleted = !delErr;
  if (delErr) {
    const { data: probe, error: probeErr } =
      await supabase.auth.admin.getUserById(previousAuthUserId);

    // "Absent" has two equally definitive shapes, and both must be recognised.
    // GoTrue answers a lookup for a missing account with a STRUCTURED 404
    // (status 404 / code "user_not_found"), not with an empty success - so
    // treating every probe error as "unknown" would strand the recovery path
    // forever. Matched on the structured status/code fields, never on message
    // text. Any OTHER error status is genuinely unknown and fails closed.
    const notFound = isAuthNotFound(probeErr) || (!probeErr && !probe?.user?.id);

    // Absence is evidence the destructive objective was achieved - safe here
    // because the guard already bound this id to a real `replaced` audit event.
    // Anything else (still present, or an unreadable world) stays false.
    deleted = notFound;
  }

  // --- 3. Record the outcome ----------------------------------------------
  const { data: recorded, error: recErr } = await supabase.rpc(
    "platform_record_multi_entity_auth_cleanup",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_previous_auth_user_id: previousAuthUserId,
      p_deleted: deleted,
    },
  );

  if (recErr) {
    // The destructive step may already have happened. Never report a plain
    // success, and never retry the delete blindly - say exactly what is known
    // so a retry (which probes absent and records) can converge.
    res.status(200).json({
      previousAuthUserId,
      previousAccountDeleted: deleted,
      auditRecorded: false,
      warning: "AUTH_CLEANUP_AUDIT_WRITE_FAILED",
    });
    return;
  }

  const r = rpcRow<{ already_completed?: unknown }>(recorded);

  res.status(200).json({
    previousAuthUserId,
    previousAccountDeleted: deleted,
    auditRecorded: true,
    alreadyCompleted: r?.already_completed === true,
  });
}

/**
 * Purge an Auth account left behind by a FAILED provisioning attempt.
 * DESTRUCTIVE.
 *
 * Deliberately a separate operation from purge_replaced_auth_user rather than
 * a widened version of it. The two describe different business facts - an
 * account displaced from the seat versus one that never reached it - they are
 * bound by different evidence (a 'replaced' row versus a
 * 'provisioning_auth_minted' row), and they record different audit actions. A
 * single op taking "some Auth id to delete" would be exactly the shape that
 * lets one path's guarantees be used to justify the other path's deletion.
 *
 * Everything else mirrors handlePurgeReplacedAuthUser exactly, because those
 * properties are production-verified and worth reproducing rather than
 * reinventing: the guard runs first, "a success audit already exists" (a RECORD
 * fact) is never conflated with "the account is absent" (a WORLD fact), absence
 * is classified by PROBING on structured status/code and never by sniffing
 * message text, and a failed audit write reports the truth instead of a plain
 * success so a retry can converge.
 */
async function handlePurgeProvisioningOrphan(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const authUserId = str(body.authUserId);

  if (!authUserId || !UUID_PATTERN.test(authUserId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // --- 1. Guard ------------------------------------------------------------
  const { data: guard, error: guardErr } = await supabase.rpc(
    "platform_check_provisioning_orphan_purgeable",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
    },
  );

  if (guardErr) {
    const { status, code } = mapRpcError(guardErr.message ?? "");
    sendError(res, status, code);
    return;
  }

  const g = rpcRow<{
    purgeable?: unknown;
    reason?: unknown;
    held_by?: unknown;
    already_completed?: unknown;
  }>(guard);

  if (!g) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  if (g.already_completed === true) {
    res.status(200).json({
      authUserId,
      accountDeleted: true,
      auditRecorded: true,
      alreadyCompleted: true,
    });
    return;
  }

  if (g.purgeable !== true) {
    const reason = typeof g.reason === "string" ? g.reason : "AUTH_USER_STILL_HELD";
    res.status(409).json({
      error: reason === "NOT_A_PROVISIONING_ORPHAN" ? reason : "AUTH_USER_STILL_HELD",
      heldBy: typeof g.held_by === "string" ? g.held_by : null,
    });
    return;
  }

  // --- 2. Delete, then classify by PROBING ---------------------------------
  const { error: delErr } = await supabase.auth.admin.deleteUser(authUserId);

  let deleted = !delErr;
  if (delErr) {
    const { data: probe, error: probeErr } =
      await supabase.auth.admin.getUserById(authUserId);
    // Absence is evidence the destructive objective was achieved - safe here
    // because the guard already bound this id to a real mint event. Any other
    // error status is genuinely unknown and fails closed.
    deleted = isAuthNotFound(probeErr) || (!probeErr && !probe?.user?.id);
  }

  // --- 3. Record the outcome ----------------------------------------------
  const { data: recorded, error: recErr } = await supabase.rpc(
    "platform_record_provisioning_orphan_cleanup",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_deleted: deleted,
    },
  );

  if (recErr) {
    // The destructive step may already have happened. Never report a plain
    // success, and never retry the delete blindly - say exactly what is known
    // so a retry (which probes absent and records) can converge.
    res.status(200).json({
      authUserId,
      accountDeleted: deleted,
      auditRecorded: false,
      warning: "AUTH_CLEANUP_AUDIT_WRITE_FAILED",
    });
    return;
  }

  const r = rpcRow<{ already_completed?: unknown }>(recorded);

  res.status(200).json({
    authUserId,
    accountDeleted: deleted,
    auditRecorded: true,
    alreadyCompleted: r?.already_completed === true,
  });
}

/**
 * Stage 9: module catalog + every workspace with its current entitlements.
 * Read-only; the RPC re-resolves the Platform Owner singleton itself.
 */
/**
 * Each workspace's Election Owner phone number, keyed by workspace id.
 *
 * Read from `election_owners` - the Owner's own row, which is where a phone
 * number actually lives. Deliberately NOT the approval's copy: an approval is
 * a separate record of what was requested once, it does not exist at all for a
 * workspace created through the historical-backfill path, and this console has
 * already been bitten once by treating a copy as if it were the source.
 *
 * A direct service-role read, the same way `api/election-day/session.ts` reads
 * a workspace name: `election_owners` has RLS on with zero policies, so only
 * the service role sees it, and no new grant or function is involved. Additive
 * and non-fatal - a failure here costs the phone column, never the list.
 */
async function readOwnerPhones(
  supabase: ReturnType<typeof getServiceClient>,
): Promise<Map<string, string>> {
  const phones = new Map<string, string>();
  try {
    const { data, error } = await supabase
      .from("election_owners")
      .select("workspace_id, phone");
    if (error || !Array.isArray(data)) return phones;
    for (const row of data as { workspace_id?: unknown; phone?: unknown }[]) {
      const id = str(row.workspace_id);
      const phone = str(row.phone);
      // One workspace may hold several Owner rows; the first with a number
      // wins rather than an arbitrary later blank overwriting it.
      if (id && phone && !phones.has(id)) phones.set(id, phone);
    }
  } catch {
    /* the list is worth more than the column */
  }
  return phones;
}

async function handleWorkspaceModulesList(
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("platform_list_workspace_modules", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  const body = (data ?? { catalog: [], workspaces: [] }) as {
    catalog?: unknown;
    workspaces?: unknown;
  };
  if (Array.isArray(body.workspaces) && body.workspaces.length > 0) {
    const phones = await readOwnerPhones(supabase);
    body.workspaces = body.workspaces.map((w) => {
      const row = w as Record<string, unknown>;
      const phone = phones.get(str(row.workspace_id));
      return phone ? { ...row, owner_phone: phone } : row;
    });
  }
  res.status(200).json(body);
}

/**
 * THE ELECTION OWNER'S OWN ACCOUNT, as the Platform console may act on it.
 *
 * The Owner record is `election_owners` - one row per workspace, enforced by a
 * UNIQUE constraint on `workspace_id`. Everything below re-resolves that row
 * from a workspace id the caller supplies and the server then validates; the
 * client never sends, and never receives, the Owner's `auth_user_id`.
 *
 * DELIBERATELY NOT HERE: name, e-mail and phone are read-only. Nothing in this
 * database updates `election_owners` - no RPC, no trigger - and no handler in
 * this project writes any table directly, only reads. Editing them needs a new
 * SECURITY DEFINER function, which is a migration.
 */
async function readWorkspaceOwner(
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
): Promise<{
  authUserId: string;
  name: string;
  email: string;
  phone: string | null;
} | null> {
  const { data, error } = await supabase
    .from("election_owners")
    .select("auth_user_id, name, email, phone")
    .eq("workspace_id", workspaceId)
    .limit(1);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as Record<string, unknown>;
  const authUserId = str(row.auth_user_id);
  if (!authUserId) return null;
  return {
    authUserId,
    name: str(row.name),
    email: str(row.email),
    phone: str(row.phone) || null,
  };
}

/** Resolves the Owner for a caller-supplied workspace id, answering the
 * request itself when there is no such workspace or no Owner on it. */
async function resolveOwnerForRequest(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<{
  supabase: ReturnType<typeof getServiceClient>;
  workspaceId: string;
  owner: { authUserId: string; name: string; email: string; phone: string | null };
} | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);
  if (!UUID_PATTERN.test(workspaceId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return null;
  }
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return null;
  }
  const owner = await readWorkspaceOwner(supabase, workspaceId);
  if (!owner) {
    sendError(res, 404, "OWNER_NOT_FOUND");
    return null;
  }
  return { supabase, workspaceId, owner };
}

/** The Owner's persisted details plus the login username they sign in with.
 * Read-only; every value comes from the server, never from what the console
 * happens to be holding. */
async function handleOwnerAccount(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const workspaceId = str(parseQuery(req.url).workspaceId);
  if (!UUID_PATTERN.test(workspaceId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }
  const owner = await readWorkspaceOwner(supabase, workspaceId);
  if (!owner) {
    sendError(res, 404, "OWNER_NOT_FOUND");
    return;
  }
  res.status(200).json({
    name: owner.name,
    email: owner.email,
    phone: owner.phone,
    username: await readOwnUsername(owner.authUserId),
  });
}

/**
 * Records one Owner-account event that happened OUTSIDE this database - a
 * username moved in the identity directory, a password set through the auth
 * provider - so the two are not the only privileged actions in this console
 * that leave no trace.
 *
 * Written immediately AFTER the change succeeds, which is the closest thing to
 * same-transaction available when the change is not a database write. The
 * result is reported back as `audited` rather than swallowed: a caller that
 * changed something and could not record it should be able to tell.
 *
 * NEVER carries password material. `details` is fixed at the call site here,
 * the RPC forces {} for a password event, and the table CHECK-constrains it.
 */
async function recordOwnerAccountEvent(
  supabase: ReturnType<typeof getServiceClient>,
  platformOwnerAuthUserId: string,
  workspaceId: string,
  action: "username_changed" | "password_set",
  details: Record<string, string> = {},
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("platform_record_owner_account_event", {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_workspace_id: workspaceId,
      p_action: action,
      p_details: action === "password_set" ? {} : details,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Changes the Owner's login username.
 *
 * The directory has no rename: `auth_identity_assign` refuses a subject that
 * already holds a name (SUBJECT_ALREADY_ASSIGNED), so a change is release then
 * assign - two calls, and therefore not one transaction. The order is chosen so
 * the failure mode is recoverable rather than silent:
 *
 *   1. availability is checked FIRST, through the same suggestion function the
 *      approval flow uses, so the common refusal happens while the Owner still
 *      holds their current name and nothing has been touched;
 *   2. only then release + assign;
 *   3. if the assign still fails - a name claimed in between, say - the OLD
 *      name is put back before answering, so the Owner is never left unable to
 *      sign in because an edit half-applied.
 *
 * An atomic `auth_identity_rename` would remove step 3 entirely, but that is a
 * new database function, i.e. a migration.
 */
async function handleSetOwnerUsername(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const resolved = await resolveOwnerForRequest(req, res);
  if (!resolved) return;
  const { supabase, workspaceId, owner } = resolved;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const username = str(body.username).trim();
  if (username === "") {
    sendError(res, 400, "INVALID_USERNAME");
    return;
  }

  const current = await readOwnUsername(owner.authUserId);
  // Same name (ignoring case and padding) is a no-op, not an error - a form
  // submitted unchanged must not cost the Owner their username.
  if (current && current.toLowerCase() === username.toLowerCase()) {
    res.status(200).json({ ok: true, username: current });
    return;
  }

  if (await usernameUnavailable(supabase, res, "election_owner", username)) return;

  const { error: releaseErr } = await supabase.rpc("auth_identity_release", {
    p_auth_user_id: owner.authUserId,
    p_actor_id: null,
  });
  if (releaseErr) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const { error: assignErr } = await supabase.rpc("auth_identity_assign", {
    p_realm: "election_owner",
    p_username: username,
    p_auth_user_id: owner.authUserId,
    p_actor_id: null,
    p_workspace_id: null,
  });
  if (assignErr) {
    // Put the previous name back rather than leaving the Owner nameless.
    if (current) {
      await supabase.rpc("auth_identity_assign", {
        p_realm: "election_owner",
        p_username: current,
        p_auth_user_id: owner.authUserId,
        p_actor_id: null,
        p_workspace_id: null,
      });
    }
    const { status, code } = usernameErrorCode(assignErr.message ?? "");
    sendError(res, status, code);
    return;
  }
  // Both names are public identifiers, and which name an account answered to
  // is exactly what this record is for.
  const audited = await recordOwnerAccountEvent(
    supabase,
    platformOwnerAuthUserId,
    workspaceId,
    "username_changed",
    { from: current ?? "", to: username },
  );
  res.status(200).json({ ok: true, username, audited });
}

/**
 * Sets a NEW password on the Owner's Auth account.
 *
 * Never reads, returns or logs an existing password - none is retrievable:
 * GoTrue stores a hash, and this only writes a replacement through the same
 * Admin API this handler already uses to create and delete Owner accounts.
 *
 * The minimum length restates the Owner's OWN set-password screen
 * (`OwnerSetPasswordScreen.tsx`, 8 characters, no composition rules) because
 * `api/` imports nothing from `src/`; the provider stays authoritative and its
 * refusal is mapped rather than second-guessed.
 */
const OWNER_PASSWORD_MIN_LENGTH = 8;

async function handleSetOwnerPassword(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const resolved = await resolveOwnerForRequest(req, res);
  if (!resolved) return;
  const { supabase, workspaceId, owner } = resolved;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < OWNER_PASSWORD_MIN_LENGTH) {
    sendError(res, 400, "WEAK_PASSWORD");
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(owner.authUserId, {
    password,
  });
  if (error) {
    const message = (error.message ?? "").toLowerCase();
    if (message.includes("password") || message.includes("weak")) {
      sendError(res, 400, "WEAK_PASSWORD");
      return;
    }
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  // THAT it happened, and nothing about what was set.
  const audited = await recordOwnerAccountEvent(
    supabase,
    platformOwnerAuthUserId,
    workspaceId,
    "password_set",
  );
  res.status(200).json({ ok: true, audited });
}

/**
 * Edits the Owner's own profile - name, e-mail and phone, and nothing else.
 *
 * Every rule lives in `platform_update_election_owner`: it locks the row,
 * normalizes, validates, writes exactly three columns and audits the change in
 * the same transaction. This end normalizes the phone to the canonical form
 * the rest of the project stores (see `normalizedIsraeliPhone`) so the console
 * and the database agree on what was typed, and lets the RPC be the authority
 * on everything else.
 */
async function handleSetOwnerProfile(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);
  if (!UUID_PATTERN.test(workspaceId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const name = str(body.name).trim();
  const email = str(body.email).trim();
  const rawPhone = str(body.phone).trim();
  if (!name || !looksLikeEmail(email)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  // An empty phone is "none recorded", which is a legitimate state; anything
  // else has to be a real Israeli number.
  const phone = rawPhone === "" ? null : normalizedIsraeliPhone(rawPhone);
  if (rawPhone !== "" && !phone) {
    sendError(res, 400, "INVALID_PHONE");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_update_election_owner", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_workspace_id: workspaceId,
    p_name: name,
    p_email: email,
    p_phone: phone,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  res.status(200).json(data ?? { name, email, phone, changed: [] });
}

/**
 * Deletes one election system permanently.
 *
 * Everything that matters happens in ONE database transaction inside
 * `platform_delete_election_workspace`: the Platform Owner is re-resolved, the
 * typed name is compared against the workspace's own, the Budget delete guard
 * runs (a workspace holding Budget data without a fresh verified export is
 * refused and stays exactly as it was), the cascade is verified to have left
 * nothing behind, and the immutable audit row is written. This handler adds
 * exactly one thing the database deliberately does not do.
 *
 * THE AUTH ACCOUNT. The Owner's auth.users row is a SHARED identity - the same
 * account can hold another principal - so the database never deletes it. It
 * reports `orphanedAuthUserId` only when, after the cascade, nothing in the
 * system still held that account, and the purge goes through the same
 * confirmed-delete path as every other compensating delete here. An
 * unconfirmed purge does NOT fail the request: the workspace is already gone
 * and that is not reversible. It is reported instead, so the operator knows
 * there is an account left to clean up rather than being told a lie either way.
 */
async function handleDeleteWorkspace(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);
  const confirmName = str(body.confirmName);
  if (!UUID_PATTERN.test(workspaceId) || confirmName.trim() === "") {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data, error } = await supabase.rpc("platform_delete_election_workspace", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_workspace_id: workspaceId,
    p_confirm_name: confirmName,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }

  const row = rpcRow<Record<string, unknown>>(data) ?? {};
  const name = str(row.name) || confirmName.trim();
  const orphan = str(row.orphanedAuthUserId);

  if (!orphan) {
    // The account is still held by another principal, or the workspace had no
    // Owner at all. Nothing to purge, and nothing was released.
    res.status(200).json({ workspaceId, name, authUserPurged: false });
    return;
  }

  if (await deleteAuthUserConfirmed(supabase, orphan)) {
    res.status(200).json({ workspaceId, name, authUserPurged: true });
    return;
  }
  res.status(200).json({
    workspaceId,
    name,
    authUserPurged: false,
    error: "AUTH_CLEANUP_INCOMPLETE",
    orphanedAuthUserId: orphan,
  });
}

/** The Platform Owner's own password floor, restated here because `api/`
 * imports nothing from `src/` - see platform-owner.constants.ts, which is the
 * definition the console validates against. Deliberately NOT lowered with the
 * Multi-Entity first-password rules: this is the most privileged identity in
 * the system. */
const PLATFORM_OWNER_PASSWORD_MIN_LENGTH = 12;

/**
 * The platform activity log - read-only, and only what was actually recorded.
 *
 * Every audit table in this project is RLS-on with zero policies and no grant
 * to any role, so this goes through the one SECURITY DEFINER read that exists
 * for it. Nothing is derived or back-filled here or in the function: an action
 * that was never audited does not appear.
 */
async function handleActivityList(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const rawLimit = Number(str(parseQuery(req.url).limit));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }
  const { data, error } = await supabase.rpc("platform_list_activity", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_limit: limit,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  res.status(200).json({ events: data ?? [] });
}

/**
 * The Platform Owner changes their OWN password.
 *
 * Done entirely on the server so the audit cannot lie: the current password is
 * verified HERE, the new one is set HERE, and only then is the event recorded.
 * A client that merely claims to have changed its password cannot produce a
 * record of one.
 *
 * Verification reuses the auth broker's own pattern - a throwaway anon client
 * signs in with the supplied current password and is immediately signed out
 * with `scope: "local"`, because every owner realm shares `auth.users` and a
 * global sign-out here would revoke the operator's real sessions.
 *
 * NEITHER PASSWORD IS STORED OR LOGGED. They exist only as arguments: the old
 * one is compared by the auth provider and discarded, the new one is handed to
 * the provider and discarded, and the audit row that follows carries `{}`.
 */
async function handleChangeOwnPassword(
  req: MinimalRequest,
  res: MinimalResponse,
  verified: { authUserId: string; email: string },
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (currentPassword === "" || newPassword.length < PLATFORM_OWNER_PASSWORD_MIN_LENGTH) {
    sendError(res, 400, "WEAK_PASSWORD");
    return;
  }
  if (newPassword === currentPassword) {
    sendError(res, 400, "SAME_PASSWORD");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  let anon: ReturnType<typeof getAnonAuthClient>;
  try {
    supabase = getServiceClient();
    anon = getAnonAuthClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // Prove they know the password they are replacing. A live session is not
  // enough: a borrowed tab would otherwise be able to lock the owner out.
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email: verified.email,
    password: currentPassword,
  });
  const matched = !signInError && signIn?.user?.id === verified.authUserId;
  await anon.auth.signOut({ scope: "local" });
  if (!matched) {
    // 400, not 401: the CALLER's session is verified and fine - it is the
    // supplied password that is wrong. A 401 here would be read by the console
    // as a lost session and bounce the operator to the login screen instead of
    // telling them what they actually got wrong.
    sendError(res, 400, "INVALID_CURRENT_PASSWORD");
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(verified.authUserId, {
    password: newPassword,
  });
  if (error) {
    const message = (error.message ?? "").toLowerCase();
    sendError(
      res,
      message.includes("password") || message.includes("weak") ? 400 : 500,
      message.includes("password") || message.includes("weak")
        ? "WEAK_PASSWORD"
        : "SERVER_ERROR",
    );
    return;
  }

  // THAT it happened, and nothing about what was set. The recording function
  // forces empty details for this action, and the table constrains them.
  const { error: auditErr } = await supabase.rpc("platform_record_owner_account_event", {
    p_platform_owner_auth_user_id: verified.authUserId,
    p_workspace_id: null,
    p_action: "self_password_set",
    p_details: {},
  });
  res.status(200).json({ ok: true, audited: !auditErr });
}

/**
 * Stage 9: replaces one workspace's module entitlements with an explicit,
 * non-empty set. The RPC validates every key against the catalog, locks the
 * workspace row, and the change applies to the very next worker request.
 */
async function handleSetWorkspaceModules(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);
  if (!UUID_PATTERN.test(workspaceId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const modules = parseModules(body.modules);
  if (!modules) {
    sendError(res, 400, "INVALID_MODULES");
    return;
  }
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("platform_set_workspace_modules", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_workspace_id: workspaceId,
    p_modules: modules,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  res.status(200).json(data ?? { workspace_id: workspaceId, modules });
}

/**
 * Gate 4: switches one module's GLOBAL availability (the platform-wide kill
 * switch) to exactly the requested state. The RPC re-resolves the Platform
 * Owner, refuses a module whose availability is fixed, row-locks the catalog
 * entry, audits a real change in the same transaction and never touches a
 * workspace entitlement. An identical retry answers 200 with changed=false.
 */
async function handleSetModuleAvailability(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const moduleKey = typeof body.moduleKey === "string" ? body.moduleKey : "";
  // A strict boolean: never coerce "true" / 1 into a platform-wide change.
  if (!MODULE_KEY_PATTERN.test(moduleKey) || typeof body.available !== "boolean") {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("platform_set_module_availability", {
    p_platform_owner_auth_user_id: platformOwnerAuthUserId,
    p_module_key: moduleKey,
    p_available: body.available,
  });
  if (error) {
    const { status, code } = mapRpcError(error.message ?? "");
    sendError(res, status, code);
    return;
  }
  const r = rpcRow<{
    previous_available?: unknown;
    available?: unknown;
    changed?: unknown;
    entitled_workspaces?: unknown;
  }>(data);
  if (!r || typeof r.available !== "boolean") {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  res.status(200).json({
    moduleKey,
    previousAvailable: r.previous_available === true,
    available: r.available,
    changed: r.changed === true,
    entitledWorkspaces:
      typeof r.entitled_workspaces === "number" ? r.entitled_workspaces : 0,
  });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  // Auth-origin partition - evaluated before ANY other logic here, exactly
  // like the Stage 5 partition below. Presence of `auth_op` hands the whole
  // request to the broker module, which applies its own deployment gate
  // (_surfaceGate) and its own verifier; the two never share a decision.
  if (isAuthBrokerRequest(req.url)) {
    await handleAuthBrokerRequest(req, res);
    return;
  }

  // Stage 5 partition - evaluated before ANY Platform Owner logic. See header.
  if (isMultiEntityRequest(req.url)) {
    await handleMultiEntityRequest(req, res);
    return;
  }

  const method = req.method ?? "GET";

  if (method !== "GET" && method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // The GET op name is resolved before auth only to reject an unknown op early;
  // no work is done on it until the caller is verified below.
  const getOp = method === "GET" ? str(parseQuery(req.url).op) : "";
  if (method === "GET" && getOp && !GET_OPS.has(getOp)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Origin is validated on the state-changing method only, before any body
  // parsing or auth work - matching the order every other handler uses.
  let postOp = "";
  if (method === "POST") {
    const origin = headerValue(req.headers.origin);
    if (!origin || !allowedPlatformOrigins().has(origin)) {
      sendError(res, 403, "FORBIDDEN_ORIGIN");
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    postOp = str(body.op);

    // Object.hasOwn, never a bare index: `postOp` is attacker-controlled, and a
    // plain object literal resolves inherited members too. Without this, an op
    // of "constructor" / "__proto__" / "toString" returns a truthy prototype
    // value, passes a `!opKeys` truthiness guard, and then makes the spread
    // below throw an uncaught TypeError - a 500 where a 400 belongs, reachable
    // before the auth check. The pre-Stage-4A code was safe only because it
    // used a Set; this restores that property to the per-op table.
    const opKeys = Object.hasOwn(POST_OP_KEYS, postOp) ? POST_OP_KEYS[postOp] : undefined;
    if (!opKeys) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }

    // Per-op key allow-list: "op" plus only this op's own fields.
    const allowed = new Set<string>(["op", ...opKeys]);
    const unknownKey = Object.keys(body).find((k) => !allowed.has(k));
    if (unknownKey) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
  }

  const rawToken = extractPlatformBearerToken(req);
  if (!rawToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const verified = await verifyPlatformOwnerJwt(rawToken);
  if (!verified) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  if (method === "GET") {
    if (getOp === "multi_entity_state") {
      await handleMultiEntityState(res, verified.authUserId);
      return;
    }
    if (getOp === "owner_access") {
      await handleOwnerAccessList(res, verified.authUserId);
      return;
    }
    if (getOp === "workspace_modules") {
      await handleWorkspaceModulesList(res, verified.authUserId);
      return;
    }
    if (getOp === "owner_account") {
      await handleOwnerAccount(req, res);
      return;
    }
    if (getOp === "activity") {
      await handleActivityList(req, res, verified.authUserId);
      return;
    }
    // Default GET payload is deliberately unchanged - the Platform Owner client
    // shape-guards on exactly these two keys.
    res.status(200).json({
      platformOwnerId: verified.platformOwnerId,
      email: verified.email,
      // Null until the Platform Owner has claimed an application username;
      // the console uses this to show the assignment flow exactly once.
      username: await readOwnUsername(verified.authUserId),
    });
    return;
  }

  switch (postOp) {
    case "set_own_username":
      await handleSetOwnUsername(req, res, verified.authUserId);
      return;
    case "create_owner_access":
      await handleCreateOwnerAccess(req, res, verified.authUserId);
      return;
    case "reissue_owner_access":
      await handleReissueOwnerAccess(req, res, verified.authUserId);
      return;
    case "set_workspace_modules":
      await handleSetWorkspaceModules(req, res, verified.authUserId);
      return;
    case "set_owner_username":
      await handleSetOwnerUsername(req, res, verified.authUserId);
      return;
    case "set_owner_password":
      await handleSetOwnerPassword(req, res, verified.authUserId);
      return;
    case "set_owner_profile":
      await handleSetOwnerProfile(req, res, verified.authUserId);
      return;
    case "change_own_password":
      await handleChangeOwnPassword(req, res, verified);
      return;
    case "delete_workspace":
      await handleDeleteWorkspace(req, res, verified.authUserId);
      return;
    case "set_module_availability":
      await handleSetModuleAvailability(req, res, verified.authUserId);
      return;
    case "provision_multi_entity_owner":
      await handleProvisionMultiEntityOwner(req, res, verified.authUserId);
      return;
    case "assign_workspace":
      await handleWorkspaceAssignment(
        req,
        res,
        verified.authUserId,
        "platform_assign_workspace_v2",
      );
      return;
    case "unassign_workspace":
      await handleWorkspaceAssignment(
        req,
        res,
        verified.authUserId,
        "platform_unassign_workspace_v2",
      );
      return;
    case "remove_multi_entity_owner":
      await handleRemoveMultiEntityOwner(req, res, verified.authUserId);
      return;
    case "reissue_multi_entity_password_link":
      await handleReissueMultiEntityPasswordLink(req, res, verified.authUserId);
      return;
    case "purge_replaced_auth_user":
      await handlePurgeReplacedAuthUser(req, res, verified.authUserId);
      return;
    case "purge_provisioning_orphan":
      await handlePurgeProvisioningOrphan(req, res, verified.authUserId);
      return;
    default:
      // Unreachable: POST_OP_KEYS lookup above already rejected unknown ops.
      sendError(res, 400, "INVALID_REQUEST");
      return;
  }
}
