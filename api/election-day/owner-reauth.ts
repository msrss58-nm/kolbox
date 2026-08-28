import { createHash, randomBytes } from "node:crypto";
import {
  extractBearerToken,
  getAnonAuthClient,
  getServiceClient,
  verifyOwnerJwt,
} from "./_ownerAuth";

// Phase 3C Roles Mutations - Owner password step-up + action-bound proof
// issuance. Browser holds a real Supabase Auth session (its own JWT) ->
// sends it as Authorization: Bearer -> this function verifies it via
// auth.getUser(jwt) (real cryptographic check, never decoded-and-trusted)
// -> re-verifies the submitted password via an ISOLATED, non-persistent
// Supabase Auth client's signInWithPassword (never the browser's own
// session) -> requires the returned Auth user id to match the JWT-verified
// id exactly -> mints a short-lived, action-bound proof via election_day_
// owner_reauth (its hash only ever reaches Postgres) -> returns the raw
// proof ONCE, in this response body only.
//
// Mirrors api/election-day/reauth.ts's own conventions closely (minimal
// duck-typed request/response, no @vercel/node dependency, fail-closed
// body-key allowlist, generic fixed error codes only) - the one structural
// difference is the identity source: reauth.ts derives its actor from a
// PermissionUser session cookie; this endpoint derives its actor from a
// verified Supabase Owner JWT instead.

const ALLOWED_OWNER_ACTIONS = new Set<string>([
  "create_role",
  "update_role",
  "delete_role",
  "clone_role",
]);

const ALLOWED_BODY_KEYS = new Set<string>(["password", "action"]);

const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

// Separate bucket namespace from every other reauth/login bucket in this
// project ("name:<name>" / "ip:<ip>" for login, "reauth:actor:<id>" /
// "reauth:ip:<ip>" for the PermissionUser reauth endpoint) so Owner
// step-up attempts never share, starve, or are starved by an unrelated
// counter. Bucketed by the SERVER-VERIFIED auth_user_id, never a
// client-supplied identity.
const MAX_OWNER_ATTEMPTS_PER_WINDOW = 10;
const MAX_IP_ATTEMPTS_PER_WINDOW = 100;

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  json: (body: unknown) => void;
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

function clientIp(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers["x-forwarded-for"]);
  if (!raw) return null;
  return raw.split(",")[0]?.trim() || null;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  res.status(status).json({ error: code });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  // 1. Method.
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  // 2. Origin - state-changing POST.
  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  // 3-4. Body - fail-closed allowlist, only password + action.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_BODY_KEYS.has(k));
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

  // 5. Server-side action allowlist, before any DB/Auth work.
  if (!ALLOWED_OWNER_ACTIONS.has(action)) {
    sendError(res, 400, "INVALID_ACTION");
    return;
  }

  // 6. Verify the Owner's JWT - real cryptographic check, never
  // decoded-and-trusted. This is the ONLY source of auth_user_id/email for
  // the rest of this request.
  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const verified = await verifyOwnerJwt(rawToken);
  if (!verified) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // 7. Rate limiting - only now that we have a server-verified identity to
  // bucket against (never counted for a forged Origin, malformed body,
  // unsupported action, or invalid/unverifiable JWT).
  const ownerBucket = `owner-reauth:actor:${verified.authUserId}`;
  const ip = clientIp(req);
  const [ownerAttemptResult, ipAttemptResult] = await Promise.all([
    supabase.rpc("election_day_register_login_attempt", { p_bucket_key: ownerBucket }),
    ip
      ? supabase.rpc("election_day_register_login_attempt", {
          p_bucket_key: `owner-reauth:ip:${ip}`,
        })
      : Promise.resolve({ data: 0, error: null }),
  ]);

  if (ownerAttemptResult.error || ipAttemptResult.error) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const ownerAttempts = (ownerAttemptResult.data ?? 0) as number;
  const ipAttempts = (ipAttemptResult.data ?? 0) as number;
  if (
    ownerAttempts > MAX_OWNER_ATTEMPTS_PER_WINDOW ||
    ipAttempts > MAX_IP_ATTEMPTS_PER_WINDOW
  ) {
    sendError(res, 429, "RATE_LIMITED");
    return;
  }

  // 8. Password step-up via an ISOLATED, non-persistent Supabase Auth
  // client - never the browser's own session, never persisted server-side.
  // The email comes exclusively from the JWT-verified user, never from
  // request input.
  let anonClient: ReturnType<typeof getAnonAuthClient>;
  try {
    anonClient = getAnonAuthClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const { data: signInData, error: signInError } =
    await anonClient.auth.signInWithPassword({
      email: verified.email,
      password,
    });

  // 9. The re-authenticated user must be the SAME verified identity - a
  // correct password for a DIFFERENT Auth account can never satisfy this
  // Owner's own step-up.
  if (signInError || !signInData?.user || signInData.user.id !== verified.authUserId) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  // 10-11. Raw proof generated here, in Node - never sent to Postgres. Only
  // its sha256 hash (as a bytea literal) is ever passed to election_day_
  // owner_reauth.
  const rawProof = randomBytes(32).toString("hex");
  const proofHashBytea = toPgBytea(sha256Hex(rawProof));

  const { data: reauthData, error: reauthError } = await supabase.rpc(
    "election_day_owner_reauth",
    {
      p_auth_user_id: verified.authUserId,
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

  // 12. The raw proof is returned ONLY here, in the successful JSON body -
  // never logged, never persisted anywhere but this one response.
  res.status(200).json({ reauthProof: rawProof });
}
