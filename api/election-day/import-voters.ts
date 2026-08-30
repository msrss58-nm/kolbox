import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

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

const ALLOWED_BODY_KEYS = new Set<string>(["reauthProof", "voters"]);

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

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

  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
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

  const sessionHashBytea = toPgBytea(sha256Hex(rawSessionToken));
  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));

  const { data, error } = await supabase.rpc("election_day_import_voters_v3", {
    p_session_hash: sessionHashBytea,
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
