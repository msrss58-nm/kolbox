import { createHash } from "node:crypto";
import { extractBearerToken, getServiceClient, verifyOwnerJwt } from "./_ownerAuth.js";

// Phase 3C Coordinator/Allocation Dual-Principal V3 - Owner path. GET ->
// workspace-scoped coordinator roster (election_day_list_coordinators_
// owner_v3). POST -> manage_coordinators/apply_initial_allocation/
// rebalance_assignments/end_coordinator_activity, selected by body.op.
// Browser -> Supabase Owner JWT (Authorization: Bearer) [+, for POST, a
// previously-issued action-bound Owner proof from POST /api/election-day/
// owner-reauth] -> this function verifies the JWT via auth.getUser(jwt),
// hashes the raw proof in Node, then calls the matching election_day_<op>_
// owner_v3 RPC (20260829030000). Owner/workspace are derived entirely
// server-side inside those RPCs from the verified auth_user_id - this
// endpoint never accepts or forwards a client-supplied ownerId/workspaceId.
//
// A SEPARATE file from coordinator-allocation.ts (the PermissionUser-session
// path), matching this project's own established convention (owner-roles.ts
// vs roles.ts, owner-session.ts vs session.ts) - the two auth modes are never
// handled by one shared handler, so there is no fallback/confusion path
// between them: an Owner JWT is verified via auth.getUser(jwt) here and
// NOTHING ELSE, never a PermissionUser session cookie, and vice versa in the
// sibling file.
//
// NOT wired into the live frontend by this migration/EXPAND - no Owner
// Coordinator/Allocation UI route exists yet. Owner UI access is wired
// during a later, separate, explicit frontend cutover once this trusted
// backend is proven.

const ALLOWED_OPS = new Set<string>([
  "manage_coordinators",
  "apply_initial_allocation",
  "rebalance_assignments",
  "end_coordinator_activity",
]);

const ALLOWED_BODY_KEYS = new Set<string>([
  "op",
  "reauthProof",
  "actions",
  "assignments",
  "sources",
  "destinations",
  "coordinatorId",
  "mode",
  "targetCoordinatorId",
]);

const OP_TO_RPC: Record<string, string> = {
  manage_coordinators: "election_day_manage_coordinators_owner_v3",
  apply_initial_allocation: "election_day_apply_initial_allocation_owner_v3",
  rebalance_assignments: "election_day_rebalance_assignments_owner_v3",
  end_coordinator_activity: "election_day_end_coordinator_activity_owner_v3",
};

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
  const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";
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
    case "NO_ACTIONS":
    case "INVALID_ACTION":
    case "INVALID_COORDINATOR_NAME":
    case "INVALID_LINK":
    case "INVALID_COORDINATOR_PHONE":
    case "INVALID_ASSIGNMENT_SHAPE":
    case "NEGATIVE_QUANTITY":
    case "NON_POSITIVE_QUANTITY":
    case "DUPLICATE_COORDINATOR_IN_ASSIGNMENTS":
    case "DUPLICATE_COORDINATOR_IN_SOURCES":
    case "DUPLICATE_COORDINATOR_IN_DESTINATIONS":
    case "NO_MEANINGFUL_ASSIGNMENT":
    case "SOURCE_DESTINATION_OVERLAP":
    case "REBALANCE_SUM_MISMATCH":
    case "ALLOCATION_COUNT_MISMATCH":
    case "INVALID_MODE":
    case "INVALID_TARGET":
      return { status: 400, code: message };
    case "COORDINATOR_NOT_FOUND":
    case "TARGET_NOT_FOUND":
      return { status: 404, code: message };
    case "COORDINATOR_NAME_COLLISION":
    case "ASSIGNMENT_ALREADY_LINKED":
    case "DISPLAY_NAME_LOCKED":
    case "COORDINATOR_LOCKED":
    case "COORDINATOR_HAS_ASSIGNED_VOTERS":
    case "COORDINATOR_HAS_LOGIN_ACCOUNT":
    case "COORDINATOR_NOT_ACTIVE":
    case "TARGET_NOT_ACTIVE":
    case "NO_UNASSIGNED_VOTERS":
    case "REBALANCE_SOURCE_INSUFFICIENT":
    case "LAST_ACTIVE_COORDINATOR":
      return { status: 409, code: message };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

async function handleGet(req: MinimalRequest, res: MinimalResponse): Promise<void> {
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

  const { data, error } = await supabase.rpc("election_day_list_coordinators_owner_v3", {
    p_auth_user_id: verified.authUserId,
  });

  if (error) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  res.status(200).json(Array.isArray(data) ? data : []);
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET") {
    await handleGet(req, res);
    return;
  }

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

  const op = typeof body.op === "string" ? body.op : "";
  if (!ALLOWED_OPS.has(op)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";
  if (!reauthProof) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const actions = Array.isArray(body.actions) ? body.actions : null;
  const assignments = Array.isArray(body.assignments) ? body.assignments : null;
  const sources = Array.isArray(body.sources) ? body.sources : null;
  const destinations = Array.isArray(body.destinations) ? body.destinations : null;
  const coordinatorId = typeof body.coordinatorId === "string" ? body.coordinatorId : "";
  const mode = typeof body.mode === "string" ? body.mode : "";
  const targetCoordinatorId =
    typeof body.targetCoordinatorId === "string" ? body.targetCoordinatorId : null;

  if (op === "manage_coordinators" && !actions) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (op === "apply_initial_allocation" && !assignments) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (op === "rebalance_assignments" && (!sources || !destinations)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (op === "end_coordinator_activity" && (!coordinatorId || !mode)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  // Owner JWT verification - the ONLY source of auth_user_id for the rest
  // of this request. Never falls back to a PermissionUser session cookie of
  // any kind on failure.
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

  const proofHashBytea = toPgBytea(sha256Hex(reauthProof));
  const rpcName = OP_TO_RPC[op];

  let rpcResult: { data: unknown; error: { message?: string } | null };

  if (op === "manage_coordinators") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_actions: actions,
    });
  } else if (op === "apply_initial_allocation") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_assignments: assignments,
    });
  } else if (op === "rebalance_assignments") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_sources: sources,
      p_destinations: destinations,
    });
  } else {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_coordinator_id: coordinatorId,
      p_mode: mode,
      p_target_coordinator_id: mode === "transfer" ? targetCoordinatorId : null,
    });
  }

  if (rpcResult.error) {
    const { status, code } = mapRpcError(rpcResult.error);
    sendError(res, status, code);
    return;
  }

  const data = rpcResult.data;
  res.status(200).json(Array.isArray(data) ? data : (data ?? { ok: true }));
}
