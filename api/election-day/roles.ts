import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Phase 3C Roles - trusted, workspace-scoped role-catalog read endpoint.
// Browser -> HttpOnly session cookie -> this function hashes it in Node ->
// service_role-only RPC resolves the session and derives workspace_id
// SERVER-SIDE -> returns only that workspace's roles. Mirrors permission-
// users.ts's own GET handling (and its "reads don't require reauth"
// convention) exactly - minimal duck-typed request/response, no
// @vercel/node dependency, no actorId/workspaceId ever accepted from the
// client. GET (read) only in this task - no mutation handler exists here
// yet; role mutations remain on the legacy election_day_*_role_v2 path,
// untouched by this file.

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
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

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Fixed, generic codes only - never a raw Postgres exception/stack.
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

// No Origin check on GET - same reasoning as session.ts's/permission-
// users.ts's own GET handling: browsers do not reliably send an Origin
// header on a same-origin simple GET, so enforcing it here would break
// legitimate same-origin reads, not just reject forged cross-site ones.
async function handleGet(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const supabase = requireServiceClient(res);
  if (!supabase) return;

  const { data, error } = await supabase.rpc("election_day_list_roles_v3", {
    p_session_hash: toPgBytea(sha256Hex(rawSessionToken)),
  });

  if (error) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  // Row shape preserved exactly as the legacy election_day_list_roles()
  // RPC's own output (snake_case id/name/description/permissions/scope_type/
  // scope_value) - the frontend's existing RawRoleRow/normalizeRoleRecord
  // validation (src/permissions/roleRecordMapper.ts) consumes this response
  // body directly, unchanged, so only the transport changes, never the
  // row contract.
  const rows = (Array.isArray(data) ? data : []) as Array<{
    id: unknown;
    name: unknown;
    description: unknown;
    permissions: unknown;
    scope_type: unknown;
    scope_value: unknown;
  }>;

  res.status(200).json(rows);
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "GET") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  await handleGet(req, res);
}
