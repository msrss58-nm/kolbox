import { createHash } from "node:crypto";
import { extractBearerToken, getServiceClient, verifyOwnerJwt } from "./_ownerAuth";

// Phase 3C Roles Mutations - Owner-only Role mutation endpoint (create /
// update / delete / clone, selected by body.op). Browser -> Supabase Owner
// JWT (Authorization: Bearer) + a previously-issued action-bound Owner proof
// (from POST /api/election-day/owner-reauth) -> this function verifies the
// JWT via auth.getUser(jwt), hashes the raw proof in Node, and calls the
// matching Owner-only, one-time-consumed-proof RPC (election_day_
// create_role_owner_v3 / _update_role_owner_v3 / _delete_role_owner_v3 /
// _clone_role_owner_v3 - see 20260828070000). Actor/workspace are derived
// entirely server-side inside those RPCs from the verified auth_user_id -
// this endpoint never accepts or forwards a client-supplied ownerId/
// workspaceId.
//
// NOT wired into any live frontend - this is backend-only proof work so the
// complete Owner trust chain can be exercised end-to-end locally. The
// legacy election_day_create_role_v2/_update_role_v2/_delete_role_v2/
// _clone_role_v2 remain the frontend's only reachable Role mutation path
// until a separate, later, explicitly-approved cutover.
//
// One file for all four mutations (rather than four near-identical files)
// - deliberate: the four RPCs share the exact same auth/proof-verification
// preamble, differ only in which RPC is called and which body fields are
// relevant, and every error path already funnels through one shared,
// generic error-code mapper.

const ALLOWED_OPS = new Set<string>(["create", "update", "delete", "clone"]);

const ALLOWED_BODY_KEYS = new Set<string>([
  "op",
  "reauthProof",
  "roleId",
  "name",
  "description",
  "permissions",
  "scopeType",
  "newName",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Each RPC below independently binds its own hardcoded action string
// ('create_role'/'update_role'/'delete_role'/'clone_role', matching
// owner-reauth.ts's ALLOWED_OWNER_ACTIONS allowlist) when it calls
// election_day_verify_and_consume_owner_proof - this endpoint never passes
// an action itself, only routes to the correct RPC by op.
const OP_TO_RPC: Record<string, string> = {
  create: "election_day_create_role_owner_v3",
  update: "election_day_update_role_owner_v3",
  delete: "election_day_delete_role_owner_v3",
  clone: "election_day_clone_role_owner_v3",
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
  // Fixed, generic codes only - never a raw Postgres exception/stack. In
  // particular, election_day_validate_role_input's dynamic
  // 'INVALID_PERMISSION: <permission>' message is deliberately collapsed to
  // the fixed code INVALID_PERMISSION below - the specific offending
  // permission string is not echoed back.
  res.status(status).json({ error: code });
}

function mapRpcError(error: { message?: string } | undefined): {
  status: number;
  code: string;
} {
  const message = error?.message ?? "";
  if (message.startsWith("INVALID_PERMISSION")) {
    return { status: 400, code: "INVALID_PERMISSION" };
  }
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "ROLE_NOT_FOUND":
      return { status: 404, code: "ROLE_NOT_FOUND" };
    case "ROLE_HAS_ASSIGNED_USERS":
      return { status: 409, code: "ROLE_HAS_ASSIGNED_USERS" };
    case "ROLE_NAME_REQUIRED":
      return { status: 400, code: "ROLE_NAME_REQUIRED" };
    case "INVALID_SCOPE_TYPE":
      return { status: 400, code: "INVALID_SCOPE_TYPE" };
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

  // op-specific required/optional fields. roleId is required for
  // update/delete/clone, never for create; name/description/permissions/
  // scopeType are only meaningful for create/update; newName only for
  // clone. Unused fields for a given op are simply ignored, not rejected -
  // the RPC itself is the source of truth for what each op actually needs.
  const roleId = typeof body.roleId === "string" ? body.roleId : "";
  if ((op === "update" || op === "delete" || op === "clone") && !roleId) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (roleId && !UUID_PATTERN.test(roleId)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const name = typeof body.name === "string" ? body.name : "";
  const description = typeof body.description === "string" ? body.description : "";
  const permissions = Array.isArray(body.permissions)
    ? body.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const scopeType = typeof body.scopeType === "string" ? body.scopeType : "";
  const newName = typeof body.newName === "string" ? body.newName : "";

  if ((op === "create" || op === "update") && (!name || !scopeType)) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }
  if (op === "clone" && !newName) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

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

  if (op === "create") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_name: name,
      p_description: description,
      p_permissions: permissions,
      p_scope_type: scopeType,
    });
  } else if (op === "update") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_role_id: roleId,
      p_name: name,
      p_description: description,
      p_permissions: permissions,
      p_scope_type: scopeType,
    });
  } else if (op === "delete") {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_role_id: roleId,
    });
  } else {
    rpcResult = await supabase.rpc(rpcName, {
      p_auth_user_id: verified.authUserId,
      p_reauth_proof_hash: proofHashBytea,
      p_role_id: roleId,
      p_new_name: newName,
    });
  }

  if (rpcResult.error) {
    const { status, code } = mapRpcError(rpcResult.error);
    sendError(res, status, code);
    return;
  }

  const row = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
  res.status(200).json(row ?? { ok: true });
}
