import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { extractBearerToken, verifyOwnerJwt } from "./_ownerAuth.js";

// Phase 3 Import/Clear Voter File - PermissionUser session path. POST only.
// Browser -> __Host-kb_ed_session HttpOnly cookie + a previously-issued
// action-bound proof from POST /api/election-day/reauth (action=
// "import_voters") -> this function hashes both in Node -> calls
// election_day_import_voters_v3 (20260829050000). Actor/role/workspace are
// derived entirely server-side inside that RPC from the session hash - this
// endpoint never accepts or forwards a client-supplied actorId/workspaceId/
// roleId. Mirrors api/election-day/coordinator-allocation.ts's own shape
// (fail-closed body-key allowlist, generic error-code mapper) and
// api/election-day/reauth.ts's own session-cookie/hashing conventions
// exactly.
//
// Wired into the live frontend since the Phase 3 Import/Clear frontend
// cutover (useImportVotersTrusted.ts -> electionDayTrustedVoterFileClient.ts
// -> this endpoint). The legacy election_day_import_voters_v2 RPC and its
// only caller (SupabaseElectionDayApi.importElectionDayVoters) were both
// removed entirely in the Phase 3 Contract migration.
//
// Budget Stage 3: this file ALSO serves POST /api/election-day/clear-voters
// (formerly its own file, api/election-day/clear-voters.ts), freeing one of
// the 12 Vercel Hobby function slots for the dedicated Budget endpoint. The
// public clear URL is kept by a SERVER-SIDE vercel.json rewrite (never a
// browser-visible redirect) to this path with `__vf_op=clear`. The clear
// branch below is the former clear-voters.ts handler, unchanged: same method,
// origin, body-key, cookie, proof and error contract, same RPC. The marker
// only ROUTES - it grants nothing: the clear branch runs the full clear
// authorization (session + a proof bound to the "clear_voters" action +
// electionDay.clearData), so a caller who sends the marker to this path
// directly gets exactly what the public clear URL gives, and an import body
// can never reach the clear RPC (or vice versa) because each branch keeps its
// own exact body allowlist and its own action-bound proof.

const ALLOWED_BODY_KEYS = new Set<string>(["reauthProof", "voters"]);
const CLEAR_ALLOWED_BODY_KEYS = new Set<string>(["reauthProof"]);
const VOTER_FILE_OP_PARAM = "__vf_op";

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
/** `?principal=owner` selects the Election Owner path, exactly as
 * api/budget/actions.ts already does. Absent/anything else = the worker
 * path, byte-identical to before. */
const PRINCIPAL_PARAM = "principal";

function isOwnerPrincipal(url: string | undefined): boolean {
  return (
    new URL(url ?? "/", "http://localhost").searchParams.get(PRINCIPAL_PARAM) === "owner"
  );
}

type ResolvedPrincipal =
  | { kind: "worker"; sessionToken: string }
  | { kind: "owner"; authUserId: string }
  | { kind: "unauthorized" };

/**
 * One authorization step for both voter-file routes. The worker branch is the
 * original check, unchanged. The Owner branch verifies the Owner JWT and
 * hands back the auth user id the Owner RPCs take - those RPCs
 * (election_day_import_voters_owner_v3 / election_day_clear_voters_owner_v3)
 * re-resolve the Owner's workspace themselves and delegate to the SAME shared
 * core the PermissionUser wrappers use, so no scope is derived here.
 */
async function resolvePrincipal(req: MinimalRequest): Promise<ResolvedPrincipal> {
  if (isOwnerPrincipal(req.url)) {
    const raw = extractBearerToken(req);
    const verified = raw ? await verifyOwnerJwt(raw) : null;
    return verified
      ? { kind: "owner", authUserId: verified.authUserId }
      : { kind: "unauthorized" };
  }
  const sessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  return sessionToken ? { kind: "worker", sessionToken } : { kind: "unauthorized" };
}
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

interface MinimalRequest {
  method?: string;
  url?: string;
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

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Fixed, generic codes only - never a raw Postgres exception/stack.
  res.status(status).json({ error: code });
}

function mapRpcError(error: { message?: string } | undefined): {
  status: number;
  code: string;
} {
  const message = error?.message ?? "";
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "ACTOR_WORKSPACE_REQUIRED":
    case "ALLOCATION_ACTIVITY_STARTED":
      return { status: 409, code: message };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

/** The former clear-voters.ts error mapper, unchanged. */
function mapClearRpcError(error: { message?: string } | undefined): {
  status: number;
  code: string;
} {
  const message = error?.message ?? "";
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "ACTOR_WORKSPACE_REQUIRED":
      return { status: 409, code: message };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

/** True only for the rewrite of /api/election-day/clear-voters. */
function isClearRoute(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, "http://localhost").searchParams.getAll(VOTER_FILE_OP_PARAM).includes("clear");
  } catch {
    return false;
  }
}

/** POST /api/election-day/clear-voters - the former clear-voters.ts handler. */
async function handleClear(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !CLEAR_ALLOWED_BODY_KEYS.has(k));
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";
  if (!reauthProof) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const principal = await resolvePrincipal(req);
  if (principal.kind === "unauthorized") {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }
  const ownerPrincipal = principal.kind === "owner";
  const ownerAuthUserId = principal.kind === "owner" ? principal.authUserId : "";
  const rawSessionToken = principal.kind === "worker" ? principal.sessionToken : "";

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));

  const { error } = ownerPrincipal
    ? await supabase.rpc("election_day_clear_voters_owner_v3", {
        p_auth_user_id: ownerAuthUserId,
        p_reauth_proof_hash: proofHashBytea,
      })
    : await supabase.rpc("election_day_clear_voters_v3", {
        p_session_hash: toPgBytea(sha256Hex(rawSessionToken)),
        p_reauth_proof_hash: proofHashBytea,
      });

  if (error) {
    const { status, code } = mapClearRpcError(error);
    sendError(res, status, code);
    return;
  }

  res.status(200).json({ ok: true });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  if (isClearRoute(req.url)) {
    await handleClear(req, res);
    return;
  }

  const method = req.method ?? "GET";

  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_BODY_KEYS.has(k));
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";
  const voters = Array.isArray(body.voters) ? body.voters : null;

  if (!reauthProof || !voters) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const principal = await resolvePrincipal(req);
  if (principal.kind === "unauthorized") {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }
  const ownerPrincipal = principal.kind === "owner";
  const ownerAuthUserId = principal.kind === "owner" ? principal.authUserId : "";
  const rawSessionToken = principal.kind === "worker" ? principal.sessionToken : "";

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));

  const { data, error } = ownerPrincipal
    ? await supabase.rpc("election_day_import_voters_owner_v3", {
        p_auth_user_id: ownerAuthUserId,
        p_reauth_proof_hash: proofHashBytea,
        p_voters: voters,
      })
    : await supabase.rpc("election_day_import_voters_v3", {
        p_session_hash: toPgBytea(sha256Hex(rawSessionToken)),
        p_reauth_proof_hash: proofHashBytea,
        p_voters: voters,
      });

  if (error) {
    const { status, code } = mapRpcError(error);
    sendError(res, status, code);
    return;
  }

  res.status(200).json({ count: data ?? 0 });
}
