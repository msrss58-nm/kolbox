import { getServiceClient } from "../election-day/_ownerAuth.js";
import {
  extractMultiEntityBearerToken,
  verifyMultiEntityOwnerJwt,
  type MultiEntityDenyReason,
} from "./_multiEntityAuth.js";

// Platform Stage 5 - the MULTI-ENTITY OWNER request handler. Leading
// underscore: not a Vercel Function (12/12 Hobby ceiling - a 13th file is
// impossible). Reached ONLY through api/platform/session.ts's `me_op`
// partition, which hands the whole request here BEFORE any Platform Owner
// code runs - the two principals never share an authorization decision.
//
// Public paths (vercel.json rewrites):
//   GET /api/multi-entity/session   -> ?me_op=session
//   GET /api/multi-entity/workspace -> ?me_op=workspace&workspaceId=<uuid>
//
// READ-ONLY. There is no Stage 5 mutation. Responses carry authorization
// METADATA only - who the verified seat holder is, and which workspaces are
// currently assigned (id, name, electionEndAt, assignedAt). Never login_code,
// never voter/campaign data (Stage 6).
//
// FRESHNESS: every request re-verifies the JWT and re-derives the seat and
// the assignment scope from committed rows. Nothing is cached and nothing is
// read from JWT claims, so an unassignment or seat replacement takes effect on
// the very next request.
//
// No Origin check - GET only, matching every existing session endpoint
// (browsers do not reliably send Origin on a same-origin simple GET); the path
// has no state-changing side effect.

interface MultiEntityRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface MultiEntityResponse {
  status: (code: number) => MultiEntityResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => unknown;
}

const PARTITION_KEY = "me_op";
const ME_OPS = new Set<string>(["session", "workspace"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryOf(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const idx = url.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : url.slice(idx + 1));
}

/** The partition predicate api/platform/session.ts evaluates first. Presence
 * of the key alone decides - a malformed value still belongs to THIS handler
 * (and is rejected here), never to the Platform Owner path. */
export function isMultiEntityRequest(url: string | undefined): boolean {
  return queryOf(url).has(PARTITION_KEY);
}

function sendError(res: MultiEntityResponse, status: number, code: string): void {
  // Fixed, generic codes only - never a raw Postgres or GoTrue message.
  res.status(status).json({ error: code });
}

/** One secret-free line per refusal: a category only - no token, no id, no
 * email, no business data. */
function logDenied(reason: MultiEntityDenyReason | "not_assigned"): void {
  console.warn(JSON.stringify({ evt: "multi_entity_denied", reason }));
}

interface WorkspaceMetadata {
  workspaceId: string;
  name: string;
  electionEndAt: string;
  assignedAt: string;
}

/** Strict row mapping: anything not exactly the approved shape is a server
 * fault, never passed through. Builds a NEW object so no extra column the RPC
 * might ever return can leak into the response. */
function toWorkspace(row: unknown): WorkspaceMetadata | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (
    typeof r.workspace_id !== "string" ||
    typeof r.name !== "string" ||
    typeof r.election_end_at !== "string" ||
    typeof r.assigned_at !== "string"
  ) {
    return null;
  }
  return {
    workspaceId: r.workspace_id,
    name: r.name,
    electionEndAt: r.election_end_at,
    assignedAt: r.assigned_at,
  };
}

function rpcMessage(error: { message?: string } | null): string {
  return (error?.message ?? "").toUpperCase();
}

export async function handleMultiEntityRequest(
  req: MultiEntityRequest,
  res: MultiEntityResponse,
): Promise<void> {
  // Carries the verified identity and assignment scope - never cacheable,
  // including on error responses.
  res.setHeader("Cache-Control", "no-store");

  if ((req.method ?? "GET") !== "GET") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  // --- Pre-auth request validation (reveals nothing about any identity) ----
  const query = queryOf(req.url);
  const ops = query.getAll(PARTITION_KEY);
  // Ambiguity is refused outright: a request may not address both principals
  // (`op` + `me_op`) or name the Multi-Entity op twice.
  if (ops.length !== 1 || query.has("op") || !ME_OPS.has(ops[0])) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  const op = ops[0];

  let workspaceId = "";
  if (op === "workspace") {
    const ids = query.getAll("workspaceId");
    workspaceId = ids.length === 1 ? ids[0].trim() : "";
    if (!UUID_PATTERN.test(workspaceId)) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
  } else if (query.has("workspaceId")) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // --- Authentication + principal (aal2, current exclusive seat) -----------
  const rawToken = extractMultiEntityBearerToken(req);
  if (!rawToken) {
    logDenied("no_token");
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const verification = await verifyMultiEntityOwnerJwt(rawToken);
  if (!verification.ok) {
    logDenied(verification.reason);
    if (verification.reason === "config") {
      sendError(res, 500, "SERVER_CONFIG_MISSING");
    } else if (verification.reason === "rpc_error") {
      sendError(res, 500, "SERVER_ERROR");
    } else {
      sendError(res, 401, "UNAUTHORIZED");
    }
    return;
  }
  const owner = verification.owner;

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return;
  }

  // --- Entity scope, re-derived from committed rows ------------------------
  if (op === "session") {
    // The list RPC re-resolves the seat itself, so a replacement committed
    // between the verifier and this call still refuses (401), never leaks.
    const { data, error } = await supabase.rpc("multi_entity_list_assigned_workspaces", {
      p_auth_user_id: owner.authUserId,
    });
    if (error) {
      if (rpcMessage(error).includes("UNAUTHORIZED")) {
        logDenied("not_seat");
        sendError(res, 401, "UNAUTHORIZED");
      } else {
        sendError(res, 500, "SERVER_ERROR");
      }
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    const workspaces = rows.map(toWorkspace);
    if (workspaces.some((w) => w === null)) {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    res.status(200).json({
      authUserId: owner.authUserId,
      email: owner.email,
      name: owner.name,
      workspaces,
    });
    return;
  }

  // op === "workspace": the client-supplied id is UNTRUSTED - authorized
  // solely by the DB gate, in the same snapshot as the read.
  const { data, error } = await supabase.rpc("multi_entity_get_assigned_workspace", {
    p_auth_user_id: owner.authUserId,
    p_workspace_id: workspaceId,
  });
  if (error) {
    const message = rpcMessage(error);
    if (message.includes("WORKSPACE_NOT_ASSIGNED")) {
      logDenied("not_assigned");
      sendError(res, 403, "FORBIDDEN");
    } else if (message.includes("UNAUTHORIZED")) {
      logDenied("not_seat");
      sendError(res, 401, "UNAUTHORIZED");
    } else {
      sendError(res, 500, "SERVER_ERROR");
    }
    return;
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length !== 1) {
    // Unreachable in practice (the gate raises first); fail closed with the
    // same answer an unassigned workspace gets.
    logDenied("not_assigned");
    sendError(res, 403, "FORBIDDEN");
    return;
  }
  const workspace = toWorkspace(rows[0]);
  if (!workspace) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  res.status(200).json(workspace);
}
