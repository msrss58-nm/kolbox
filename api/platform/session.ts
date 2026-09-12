import {
  extractPlatformBearerToken,
  verifyPlatformOwnerJwt,
} from "../election-day/_platformAuth.js";
import { getServiceClient } from "../election-day/_ownerAuth.js";
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
  // Present on Vercel's response object; used only by the Stage 5 Multi-Entity
  // partition (Cache-Control: no-store). The Platform path never calls it.
  setHeader: (name: string, value: string) => unknown;
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
const POST_OP_KEYS: Record<string, readonly string[]> = {
  create_owner_access: ["name", "email", "phone", "expiresInDays"],
  provision_multi_entity_owner: ["name", "email", "phone"],
  assign_workspace: ["workspaceId"],
  unassign_workspace: ["workspaceId"],
  purge_replaced_auth_user: ["previousAuthUserId"],
  purge_provisioning_orphan: ["authUserId"],
  reissue_owner_access: ["pendingId"],
};

const GET_OPS = new Set<string>(["multi_entity_state", "owner_access"]);

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
  if (m.includes("MISSING_OWNER_NAME") || m.includes("MISSING_OWNER_EMAIL")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  if (m.includes("INVALID_EXPIRY_WINDOW")) {
    return { status: 400, code: "INVALID_REQUEST" };
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
  if (m.includes("MULTI_ENTITY_OWNER_NOT_PROVISIONED")) {
    return { status: 409, code: "MULTI_ENTITY_OWNER_NOT_PROVISIONED" };
  }
  if (m.includes("WORKSPACE_NOT_FOUND")) {
    return { status: 404, code: "WORKSPACE_NOT_FOUND" };
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
async function handleCreateOwnerAccess(
  req: MinimalRequest,
  res: MinimalResponse,
  platformOwnerAuthUserId: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const name = str(body.name);
  const email = str(body.email).toLowerCase();
  const phone = str(body.phone);
  const expiresInDaysRaw = body.expiresInDays;

  if (!name || !email || !looksLikeEmail(email)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (name.length > 200 || phone.length > 40) {
    sendError(res, 400, "INVALID_REQUEST");
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

  // --- 2. Pending access row ----------------------------------------------
  const { data: pending, error: rpcErr } = await supabase.rpc(
    "platform_create_pending_owner_access",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_name: name,
      p_email: email,
      p_phone: phone || null,
      p_expires_in_days: expiresInDays,
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

  res.status(200).json(data ?? { seat: null, workspaces: [] });
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

  if (!name || !email || !looksLikeEmail(email)) {
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

  // --- 2. Seat -------------------------------------------------------------
  const { data: seat, error: rpcErr } = await supabase.rpc(
    "platform_provision_multi_entity_owner",
    {
      p_platform_owner_auth_user_id: platformOwnerAuthUserId,
      p_auth_user_id: authUserId,
      p_name: name,
      p_email: email,
      p_phone: phone || null,
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
  const redirectTo = `${multiEntityBaseUrl}${MULTI_ENTITY_SET_PASSWORD_PATH}`;
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });

  const hashedToken = link?.properties?.hashed_token;
  const activationLink =
    !linkErr && typeof hashedToken === "string" && hashedToken
      ? `${redirectTo}?${new URLSearchParams({ token_hash: hashedToken, type: "recovery" }).toString()}`
      : null;

  // requiresDestructiveApproval is surfaced explicitly rather than quietly
  // leaving an orphaned Auth account behind: the console must show this as an
  // outstanding operator action.
  res.status(201).json({
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
  rpc: "platform_assign_workspace" | "platform_unassign_workspace",
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = str(body.workspaceId);

  if (!workspaceId || !UUID_PATTERN.test(workspaceId)) {
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

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
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
    // Default GET payload is deliberately unchanged - the Platform Owner client
    // shape-guards on exactly these two keys.
    res
      .status(200)
      .json({ platformOwnerId: verified.platformOwnerId, email: verified.email });
    return;
  }

  switch (postOp) {
    case "create_owner_access":
      await handleCreateOwnerAccess(req, res, verified.authUserId);
      return;
    case "reissue_owner_access":
      await handleReissueOwnerAccess(req, res, verified.authUserId);
      return;
    case "provision_multi_entity_owner":
      await handleProvisionMultiEntityOwner(req, res, verified.authUserId);
      return;
    case "assign_workspace":
      await handleWorkspaceAssignment(
        req,
        res,
        verified.authUserId,
        "platform_assign_workspace",
      );
      return;
    case "unassign_workspace":
      await handleWorkspaceAssignment(
        req,
        res,
        verified.authUserId,
        "platform_unassign_workspace",
      );
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
