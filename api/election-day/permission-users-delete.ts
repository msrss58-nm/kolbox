import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Phase 3C Users EXPAND - trusted PermissionUser deletion endpoint. Browser
// -> HttpOnly session cookie + a previously-issued action-bound reauth proof
// (from POST /api/election-day/reauth, action "delete_permission_user") ->
// this function hashes both credentials in Node -> service_role-only RPC
// verifies session+proof (ONE-TIME CONSUMED - see election_day_verify_and_
// consume_reauth_proof_v3's own comment), derives actor/workspace SERVER-
// SIDE, and enforces same-workspace target + self-delete rejection. Mirrors
// permission-users.ts's own conventions exactly (minimal duck-typed request/
// response, no @vercel/node dependency, request-order hardening, generic
// fixed error codes only).
//
// NOT called by any live frontend code yet - the dedicated trusted hook
// (useDeletePermissionUserTrusted.ts) exists but is not wired into
// useElectionDay.ts. The legacy election_day_delete_permission_user_v2
// (containment-hardened in the same migration as this endpoint's RPC)
// remains the only reachable delete path today.

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

const ALLOWED_BODY_KEYS = new Set<string>(["targetUserId", "reauthProof"]);

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
  // Fixed, generic codes only - never a raw Postgres exception/stack, never
  // the constraint/workspace detail behind a USER_NOT_FOUND (which covers
  // both "doesn't exist" and "exists in a different workspace" - see the
  // RPC's own comment).
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

// Maps election_day_delete_permission_user_v3's own raised exception
// messages to a fixed, safe HTTP status/code pair. Never forwards the raw
// Postgres message for anything unrecognized.
function mapRpcError(error: { message?: string } | undefined): {
  status: number;
  code: string;
} {
  switch (error?.message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "CANNOT_DELETE_SELF":
      return { status: 400, code: "CANNOT_DELETE_SELF" };
    case "USER_NOT_FOUND":
      return { status: 404, code: "USER_NOT_FOUND" };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
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

  // Fail-closed body-key allowlist - actor_id/workspace_id are never
  // accepted from the body at all, same reasoning as permission-users.ts's
  // own create-endpoint body validation.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_BODY_KEYS.has(k));
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId : "";
  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";

  if (!targetUserId || !reauthProof) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  if (!UUID_PATTERN.test(targetUserId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const sessionHashBytea = toPgBytea(sha256Hex(rawSessionToken));
  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));

  const supabase = requireServiceClient(res);
  if (!supabase) return;

  const { error } = await supabase.rpc("election_day_delete_permission_user_v3", {
    p_session_hash: sessionHashBytea,
    p_reauth_proof_hash: proofHashBytea,
    p_target_user_id: targetUserId,
  });

  if (error) {
    const { status, code } = mapRpcError(error);
    sendError(res, status, code);
    return;
  }

  res.status(200).json({ ok: true });
}
