import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

// Phase 3B Step 1 - action-bound step-up re-authentication endpoint. Browser
// -> HttpOnly session cookie -> this function -> hash session token in Node
// -> service_role-only RPC resolves the VERIFIED actor/workspace -> bcrypt
// re-verifies the actor's own password -> issues a short-lived, action-bound
// proof (its hash only ever reaches Postgres). Mirrors api/election-day/
// session.ts's own conventions (minimal duck-typed request/response, no
// @vercel/node dependency, request-order hardening, generic fixed error
// codes only).
//
// Server-side action allowlist for this phase is intentionally exactly one
// entry - see this repo's Phase 3B planning record (CURRENT_STATUS.md) for
// why: election_day_verify_reauth_proof_v3 (the function that actually
// enforces one-proof-one-action binding) is only ever called today from
// inside election_day_create_permission_user_v3's own body. The LEGACY
// election_day_verify_reauth_proof ignores the `action` column entirely, so
// a proof minted here for any action without a real v3 consumer would be
// just as usable against an unrelated legacy _v2 mutation as the real proof
// for that mutation - allowlisting more than the one action with a genuine
// v3 consumer would advertise a narrowing property that does not actually
// hold yet. Widen this list only in lockstep with each new _v3 RPC.
const ALLOWED_REAUTH_ACTIONS = new Set<string>(["create_permission_user"]);

// Fail-closed body-key allowlist - see the body-validation step below for why.
const ALLOWED_REAUTH_BODY_KEYS = new Set<string>(["password", "action"]);

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

// Separate bucket namespace from session.ts's own login-attempt buckets
// ("name:<name>" / "ip:<ip>") so reauth attempts never share, starve, or are
// starved by login's counters. Reauth already requires holding a currently
// valid session - a materially higher bar than a bare login attempt - so
// bucketing by the SERVER-VERIFIED actor_id (never a client-supplied name)
// is the correct scope, not a client-asserted identity.
const MAX_ACTOR_ATTEMPTS_PER_WINDOW = 10;
const MAX_IP_ATTEMPTS_PER_WINDOW = 100;

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  cookies?: Record<string, string>;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
}

function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) {
    throw new Error("SERVER_CONFIG_MISSING");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toPgBytea(hexDigest: string): string {
  return "\\x" + hexDigest;
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>([
    process.env.SESSION_ALLOWED_ORIGIN ?? DEFAULT_PRODUCTION_ORIGIN,
  ]);
  if (process.env.VERCEL_ENV !== "production") {
    origins.add("http://localhost:5173");
  }
  return origins;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// IP is accounting-only input to the rate-limit bucket - never an identity
// or workspace authority anywhere in this file or in any RPC it calls.
// Same trusted-proxy assumption as session.ts's own clientIp - Vercel's edge
// sets x-forwarded-for itself, and no different proxy-trust model is
// introduced here.
function clientIp(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers["x-forwarded-for"]);
  if (!raw) return null;
  return raw.split(",")[0]?.trim() || null;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Generic, fixed error codes only - never a raw Postgres exception/stack,
  // never a message distinguishing which internal check failed (wrong
  // password vs. unresolved session vs. missing permission all collapse to
  // the same UNAUTHORIZED from this endpoint's point of view).
  res.status(status).json({ error: code });
}

function requireServiceClient(
  res: MinimalResponse,
): ReturnType<typeof createClient> | null {
  try {
    return getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return null;
  }
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  // 1. Reject unsupported method before anything else.
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  // 2. Validate trusted Origin - state-changing POST, same policy as
  // session.ts's own POST/DELETE handling.
  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  // 3-4. Parse/validate body - accept ONLY password + action, both
  // non-blank strings. Fail-closed: any OTHER key present on the body is
  // rejected outright rather than silently ignored - a security-shaped
  // field like actorId/workspaceId/sessionToken has no effect on this
  // handler's logic today (actor/workspace are always derived from the
  // verified session below), but a request that sends one anyway is either
  // a confused or a probing client, and this project's stated preference
  // is to reject that explicitly rather than accept it as a silent no-op.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_REAUTH_BODY_KEYS.has(k));
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const password = typeof body.password === "string" ? body.password : "";
  const action = typeof body.action === "string" ? body.action : "";

  if (!password || !action) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // 5-6. Server-side action allowlist, rejected before any DB work.
  if (!ALLOWED_REAUTH_ACTIONS.has(action)) {
    sendError(res, 400, "INVALID_ACTION");
    return;
  }

  // 7. Require the session cookie before any DB work.
  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  // 8. Hash the raw session token in Node - Postgres never sees it raw.
  const sessionHashBytea = toPgBytea(sha256Hex(rawSessionToken));

  // 9. Construct the privileged service client only now that every
  // no-DB-needed check has passed.
  const supabase = requireServiceClient(res);
  if (!supabase) return;

  // 10. Resolve the session server-side - this is the ONLY source of
  // actor_id/workspace_id/role_id for the rest of this request. The browser
  // never supplies any of these as trusted input.
  const { data: sessionData, error: sessionError } = await supabase.rpc(
    "election_day_resolve_session",
    { p_session_hash: sessionHashBytea },
  );

  if (
    sessionError ||
    !sessionData ||
    (Array.isArray(sessionData) && sessionData.length === 0)
  ) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const sessionRow = (Array.isArray(sessionData) ? sessionData[0] : sessionData) as {
    actor_id: string;
  };
  const actorId = sessionRow.actor_id;

  // 11. Rate limiting - only now, since only a VALID resolved session
  // reaches this point (never counted for a forged Origin, malformed body,
  // unsupported action, missing cookie, or invalid/unresolved session).
  const actorBucket = `reauth:actor:${actorId}`;
  const ip = clientIp(req);
  const [actorAttemptResult, ipAttemptResult] = await Promise.all([
    supabase.rpc("election_day_register_login_attempt", { p_bucket_key: actorBucket }),
    ip
      ? supabase.rpc("election_day_register_login_attempt", {
          p_bucket_key: `reauth:ip:${ip}`,
        })
      : Promise.resolve({ data: 0, error: null }),
  ]);

  if (actorAttemptResult.error || ipAttemptResult.error) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const actorAttempts = (actorAttemptResult.data ?? 0) as number;
  const ipAttempts = (ipAttemptResult.data ?? 0) as number;
  if (
    actorAttempts > MAX_ACTOR_ATTEMPTS_PER_WINDOW ||
    ipAttempts > MAX_IP_ATTEMPTS_PER_WINDOW
  ) {
    sendError(res, 429, "RATE_LIMITED");
    return;
  }

  // 12-13. Raw proof generated here, in Node - never sent to Postgres. Only
  // its sha256 hash (as a bytea literal) is ever passed to election_day_
  // reauth_v3, mirroring session.ts's own raw-token/hash split exactly.
  const rawProof = randomBytes(32).toString("hex");
  const proofHashBytea = toPgBytea(sha256Hex(rawProof));

  // 14. election_day_reauth_v3 re-derives actor/workspace from the session
  // hash itself (never from a client-supplied id) and bcrypt-verifies the
  // submitted password before issuing the action-bound proof.
  const { data: reauthData, error: reauthError } = await supabase.rpc(
    "election_day_reauth_v3",
    {
      p_session_hash: sessionHashBytea,
      p_password: password,
      p_action: action,
      p_proof_hash: proofHashBytea,
    },
  );

  if (
    reauthError ||
    !reauthData ||
    (Array.isArray(reauthData) && reauthData.length === 0)
  ) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  // 15. The raw proof is returned ONLY here, in the successful JSON body -
  // it is never logged, never persisted anywhere but this one response.
  res.status(200).json({ reauthProof: rawProof });
}
