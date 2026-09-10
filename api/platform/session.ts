import {
  extractPlatformBearerToken,
  verifyPlatformOwnerJwt,
} from "../election-day/_platformAuth.js";
import { getServiceClient } from "../election-day/_ownerAuth.js";

// Platform Stage 2 - PLATFORM OWNER session/context endpoint.
// Platform Stage 3B - plus the Platform Owner's one write operation.
//
// GET answers the single question: "does this Supabase JWT belong to the
// singleton platform owner?" On success it returns the bare
// {platformOwnerId, email} pair and NOTHING else - no voter data, no
// workspace data, no Election Day operational fields, and no Election Owner
// APIs are reachable through it.
//
// POST carries an `op` multiplex (currently one op: create_owner_access).
// Stage 3B needs the Platform Owner console to perform a real mutation, and
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
}

const DEFAULT_PLATFORM_ORIGIN = "https://kolbox-platform.vercel.app";

// The Election origin, used ONLY to build the Owner's activation link - the
// owner set-password route lives on the Election surface, not the Platform
// one. Deliberately a separate variable from SESSION_ALLOWED_ORIGIN (see the
// header) and from the Platform origin above.
const DEFAULT_ELECTION_APP_BASE_URL = "https://kolbox-gamma.vercel.app";
const LOCAL_APP_BASE_URL = "http://localhost:5173";
const OWNER_SET_PASSWORD_PATH = "/election-day/owner-set-password";

const ALLOWED_OPS = new Set<string>(["create_owner_access"]);
const ALLOWED_BODY_KEYS = new Set<string>([
  "op",
  "name",
  "email",
  "phone",
  "expiresInDays",
]);

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
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
  if (m.includes("MISSING_OWNER_NAME") || m.includes("MISSING_OWNER_EMAIL")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  if (m.includes("INVALID_EXPIRY_WINDOW")) {
    return { status: 400, code: "INVALID_REQUEST" };
  }
  return { status: 500, code: "SERVER_ERROR" };
}

/**
 * Approve a new Election Owner.
 *
 * Order matters and is not interchangeable:
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

  // --- 1. Auth user, no password ------------------------------------------
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (createErr || !created?.user?.id) {
    // An address that already has an account is an ambiguous state, not
    // something to silently adopt: the existing account may belong to a
    // Platform Owner, a campaign user, or an Owner of another workspace.
    // Fail closed and let a human resolve it.
    const msg = (createErr?.message ?? "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered")) {
      sendError(res, 409, "EMAIL_ALREADY_REGISTERED");
      return;
    }
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const authUserId = created.user.id;

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
    await supabase.auth.admin.deleteUser(authUserId);
    const { status, code } = mapRpcError(rpcErr.message ?? "");
    sendError(res, status, code);
    return;
  }

  const row = (Array.isArray(pending) ? pending[0] : pending) as
    | { pending_id?: unknown; expires_at?: unknown; already_existed?: unknown }
    | undefined;

  if (!row || typeof row.pending_id !== "string") {
    await supabase.auth.admin.deleteUser(authUserId);
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  // --- 4. One-time activation link ----------------------------------------
  const redirectTo = `${electionAppBaseUrl()}${OWNER_SET_PASSWORD_PATH}`;
  const { data: link, error: linkErr } = await supabase.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });

  const hashedToken = link?.properties?.hashed_token;
  // The pending row and the Auth user are both valid at this point, so a link
  // failure is NOT rolled back - the approval stands and the link can be
  // regenerated. The console is told so explicitly rather than being shown a
  // half-success it cannot interpret.
  const activationLink =
    !linkErr && typeof hashedToken === "string" && hashedToken
      ? `${redirectTo}?${new URLSearchParams({ token_hash: hashedToken, type: "recovery" }).toString()}`
      : null;

  res.status(201).json({
    pendingId: row.pending_id,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    alreadyExisted: row.already_existed === true,
    activationLink,
  });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "GET" && method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // Origin is validated on the state-changing method only, before any body
  // parsing or auth work - matching the order every other handler uses.
  if (method === "POST") {
    const origin = headerValue(req.headers.origin);
    if (!origin || !allowedPlatformOrigins().has(origin)) {
      sendError(res, 403, "FORBIDDEN_ORIGIN");
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknownKey = Object.keys(body).find((k) => !ALLOWED_BODY_KEYS.has(k));
    if (unknownKey) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    if (!ALLOWED_OPS.has(str(body.op))) {
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
    res
      .status(200)
      .json({ platformOwnerId: verified.platformOwnerId, email: verified.email });
    return;
  }

  await handleCreateOwnerAccess(req, res, verified.authUserId);
}
