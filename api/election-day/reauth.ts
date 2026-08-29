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
// Server-side action allowlist - see this repo's Phase 3B/3C planning
// records (CURRENT_STATUS.md) for why this must only ever contain actions
// with a real v3 consumer: election_day_verify_reauth_proof_v3 (reusable-
// within-TTL) and election_day_verify_and_consume_reauth_proof_v3
// (one-time-consumed, Phase 3C) are the only functions that actually enforce
// one-proof-one-action binding. The LEGACY election_day_verify_reauth_proof
// ignores the `action` column entirely (it only accepts rows with action IS
// NULL, since Phase 3C's isolation fix - see that migration) - so a proof
// minted here is already correctly excluded from the legacy path. It is,
// however, also correctly excluded from a DIFFERENT v3 action's own
// verifier, since every v3 verifier's own p_action match rejects a
// mismatched action. Widen this list only in lockstep with each new _v3 RPC
// that actually consumes the corresponding action.
//
// Phase 3C Users (EXPAND, not yet wired to the frontend): added
// delete_permission_user and reset_permission_user_password for the new
// election_day_delete_permission_user_v3 / election_day_reset_permission_
// user_password_v3 RPCs (one-time-consumed via election_day_verify_and_
// consume_reauth_proof_v3 - see that migration's header for exact
// semantics). No frontend code calls this endpoint with either action yet -
// the dedicated trusted hooks exist but are not wired into useElectionDay.ts.
//
// Phase 3C Coordinator/Allocation Dual-Principal V3 (EXPAND, not yet wired
// to the frontend): added manage_coordinators/apply_initial_allocation/
// rebalance_assignments/end_coordinator_activity for the new election_day_
// <op>_v3 RPCs (20260829030000, originally one-time-consumed via election_
// day_verify_and_consume_reauth_proof_v3). No frontend code calls this
// endpoint with any of these four actions yet.
//
// Phase 3C Coordinator/Allocation Reauth Compatibility Patch
// (20260829040000): the 4 action names above are now superseded by one
// feature-scoped action, coordinator_allocation - all 4 Coordinator/
// Allocation _v3 wrappers were repointed to the REUSABLE-WITHIN-TTL
// election_day_verify_reauth_proof_v3 (Phase 3A precedent, same verifier
// election_day_create_permission_user_v3 already uses) bound to this one
// action, so a single minted proof verifies against all 4 mutations for its
// 5-minute TTL - see that migration's header for the full root-cause/design
// record. The 4 granular names are deliberately left in this allowlist,
// unremoved, for rollback compatibility (approved decision) - they are
// harmless dead entries now: no _v3 RPC checks for them anymore, so a proof
// minted with one of those literals can never successfully verify against
// anything. They may be retired later, after a verified frontend cutover.
const ALLOWED_REAUTH_ACTIONS = new Set<string>([
  "create_permission_user",
  "delete_permission_user",
  "reset_permission_user_password",
  "manage_coordinators",
  "apply_initial_allocation",
  "rebalance_assignments",
  "end_coordinator_activity",
  "coordinator_allocation",
]);

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
