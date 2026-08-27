import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Phase 3B Step 1 - trusted PermissionUser creation endpoint (create only;
// delete/reset-password remain on the legacy reauth-proof path as Phase 3C
// debt - see CURRENT_STATUS.md). Browser -> HttpOnly session cookie + a
// previously-issued action-bound reauth proof (from POST /api/election-day/
// reauth) -> this function hashes both credentials in Node -> service_role-
// only RPC verifies session+proof and derives actor/workspace SERVER-SIDE
// -> Postgres enforces same-workspace role membership. Mirrors session.ts's
// own conventions (minimal duck-typed request/response, no @vercel/node
// dependency, request-order hardening, generic fixed error codes only).

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

// Fail-closed body-key allowlist - see the body-validation step below for why.
const ALLOWED_PERMISSION_USER_BODY_KEYS = new Set<string>([
  "name",
  "password",
  "roleId",
  "reauthProof",
]);

// Syntactic UUID check only - never a substitute for the DB's own
// authoritative same-workspace role-membership check (election_day_
// create_permission_user_v3's own ROLE_NOT_FOUND handling, untouched by
// this). This exists only so a malformed value fails fast with a client
// error instead of surfacing as a generic 500 via a Postgres cast failure.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Fixed, generic codes only - never a raw Postgres exception/stack. The
  // underlying RPC already collapses its own failure modes (see the mapping
  // below); this function never adds a MORE specific message on top.
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

// Maps election_day_create_permission_user_v3's own raised exception
// messages to a fixed, safe HTTP status/code pair. Never forwards the raw
// Postgres message for anything unrecognized - falls back to a generic
// SERVER_ERROR so an unexpected DB-side change can never leak detail here.
function mapRpcError(message: string | undefined): { status: number; code: string } {
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "ROLE_NOT_FOUND":
      return { status: 400, code: "ROLE_NOT_FOUND" };
    case "name is required":
    case "password is required":
      return { status: 400, code: "INVALID_REQUEST" };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  // 1. Method validation - create only in this phase.
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  // 2. Origin validation before any DB work.
  const origin = headerValue(req.headers.origin);
  if (!origin || !allowedOrigins().has(origin)) {
    sendError(res, 403, "FORBIDDEN_ORIGIN");
    return;
  }

  // 3. Body validation - browser may supply ONLY legitimate business
  // inputs. actor_id/workspace_id are never accepted from the body at all -
  // they are resolved exclusively from the session+proof inside the RPC.
  // Fail-closed: any key outside the allowlist (actorId, workspaceId,
  // permissionUserId, sessionToken, or anything else) is rejected outright
  // rather than silently ignored - same reasoning as reauth.ts's own
  // body-key allowlist.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find(
    (k) => !ALLOWED_PERMISSION_USER_BODY_KEYS.has(k),
  );
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const name = typeof body.name === "string" ? body.name : "";
  const password = typeof body.password === "string" ? body.password : "";
  const roleId = typeof body.roleId === "string" ? body.roleId : "";
  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";

  if (!name || !password || !roleId || !reauthProof) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Syntactic UUID check, fast-failed before any DB work - never relies on
  // a Postgres cast failure to catch this. Does NOT replace the RPC's own
  // authoritative same-workspace role check below: a syntactically valid
  // but nonexistent/cross-workspace UUID still reaches election_day_
  // create_permission_user_v3 and is still rejected there as ROLE_NOT_FOUND.
  if (!UUID_PATTERN.test(roleId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // 4. Require the session cookie before any DB work.
  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  // 5-6. Hash both raw credentials in Node - Postgres never sees either raw
  // value, mirroring session.ts's/reauth.ts's own raw-token/hash split.
  const sessionHashBytea = toPgBytea(sha256Hex(rawSessionToken));
  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));

  const supabase = requireServiceClient(res);
  if (!supabase) return;

  // 7-8. election_day_create_permission_user_v3 verifies the session AND
  // the action-bound proof together (for the 'create_permission_user'
  // action specifically), derives actor/workspace SERVER-SIDE from that
  // verification, and writes the ACTING CALLER'S OWN workspace_id onto the
  // new row - never a client-supplied workspace_id. roleId here is a
  // requested business selection only; the RPC itself is authoritative on
  // whether that role belongs to the caller's own workspace (ROLE_NOT_FOUND
  // otherwise - see mapRpcError below).
  const { data, error } = await supabase.rpc("election_day_create_permission_user_v3", {
    p_session_hash: sessionHashBytea,
    p_reauth_proof_hash: proofHashBytea,
    p_name: name,
    p_password: password,
    p_role_id: roleId,
  });

  if (error) {
    const { status, code } = mapRpcError(error.message);
    sendError(res, status, code);
    return;
  }

  if (!data || (Array.isArray(data) && data.length === 0)) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    id: string;
    name: string;
    role_id: string;
    workspace_id: string;
  };

  res.status(201).json({
    id: row.id,
    name: row.name,
    roleId: row.role_id,
    workspaceId: row.workspace_id,
  });
}
