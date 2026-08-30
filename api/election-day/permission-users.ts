import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Phase 3B/3C PermissionUser roster endpoints - GET (list), POST (create,
// default), and two POST sub-actions reached only via vercel.json rewrites
// from their own public URLs (/permission-users-delete,
// /permission-users-reset-password) - see the Hobby-plan Serverless
// Function consolidation note below. Browser -> HttpOnly session cookie (+
// a previously-issued action-bound reauth proof for create/delete/reset) ->
// this function hashes both credentials in Node -> service_role-only RPC
// verifies session(+proof) and derives actor/workspace SERVER-SIDE ->
// Postgres enforces same-workspace role membership/target. No @vercel/node
// dependency, request-order hardening, generic fixed error codes only.
//
// Hobby-plan Function consolidation: this file used to be 3 separate
// deployable Vercel Functions (permission-users.ts, permission-users-
// delete.ts, permission-users-reset-password.ts). Merged into one function
// to stay within the Vercel Hobby plan's Serverless Function count limit -
// the public URLs are unchanged (vercel.json rewrites
// /permission-users-delete and /permission-users-reset-password to this
// file with a `__pu_action` query marker this file reads to dispatch to
// the right handler; the default create path is unmarked, matching its
// original, un-rewritten URL exactly). Each handler below is otherwise the
// unmodified body of its original file - same order of checks, same body-
// key allowlist, same RPC, same error mapping, same response shape.
//
// GET (roster read) is live (`fetchTrustedPermissionUsersRoster` in
// useElectionDay.ts). POST create is live (`useCreatePermissionUserTrusted`).
// POST delete/reset-password are NOT called by any live frontend code yet -
// see electionDayTrustedUsersClient.ts / useDeletePermissionUserTrusted.ts /
// useResetPermissionUserPasswordTrusted.ts.

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function requireServiceClient(
  res: MinimalResponse,
): ReturnType<typeof getServiceClient> | null {
  try {
    return getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return null;
  }
}

// Reads the `__pu_action` query marker vercel.json's rewrites inject for
// the two aliased public URLs - parsed directly from req.url (always
// present on any Node HTTP request, not a Vercel-specific enhancement) so
// this never depends on a runtime-provided req.query object.
function getQueryParam(req: MinimalRequest, name: string): string | null {
  const rawUrl = req.url ?? "";
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get(name);
}

const ALLOWED_CREATE_BODY_KEYS = new Set<string>([
  "name",
  "password",
  "roleId",
  "reauthProof",
]);

// Maps election_day_create_permission_user_v3's own raised exception
// messages to a fixed, safe HTTP status/code pair. Never forwards the raw
// Postgres message for anything unrecognized - falls back to a generic
// SERVER_ERROR so an unexpected DB-side change can never leak detail here.
//
// Phase 3C: election_day_permission_users.name carries a real, global
// `unique` constraint (`election_day_permission_users_name_key`) - the v3
// RPC's own INSERT has no exception handler around it, so a duplicate name
// previously fell through to the generic 500 SERVER_ERROR below (an
// ordinary business error, not a server fault). Fixed by matching this ONE
// specific constraint violation, narrowly, before the generic switch below:
// PostgREST passes through the real Postgres SQLSTATE for a genuine DB-level
// error (never P0001, which is what a plain `raise exception '<text>'` -
// every other case below - actually produces), so `error.code === "23505"`
// is a reliable, library-level signal, not a project-specific guess -
// empirically confirmed against a local disposable instance calling this
// exact RPC twice with the same name (real error object logged:
// `{code:"23505", message:'duplicate key value violates unique constraint
// "election_day_permission_users_name_key"', details:"Key (name)=(...)
// already exists.", hint:null}`). Both the code AND the specific constraint
// name are required to match - deliberately narrower than the generic
// `message.includes("duplicate key")` pattern used elsewhere in this
// codebase (mapRoleRpcErrorMessage/mapNonVotingReasonRpcErrorMessage), so
// this can never misfire on an unrelated unique-violation this RPC might
// someday raise. Never exposes the constraint name or any workspace detail
// to the browser - only the generic 409 DUPLICATE_NAME code, mapped to a
// single generic "name unavailable" message client-side.
function mapCreateRpcError(error: { message?: string; code?: string } | undefined): {
  status: number;
  code: string;
} {
  if (
    error?.code === "23505" &&
    typeof error.message === "string" &&
    error.message.includes("election_day_permission_users_name_key")
  ) {
    return { status: 409, code: "DUPLICATE_NAME" };
  }
  switch (error?.message) {
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

// Phase 3C Users EXPAND: session-derived, workspace-scoped roster read.
// Mirrors session.ts's own GET handling - no Origin check (browsers do not
// reliably send Origin on a same-origin simple GET, so enforcing it here
// would break legitimate same-origin reads, not just reject forged
// cross-site ones), just the session cookie requirement. No reauth proof -
// a read carries no step-up requirement, matching election_day_list_
// permission_users_v3's own "reads don't require reauth" convention.
async function handleGet(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const rawSessionToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (!rawSessionToken) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const supabase = requireServiceClient(res);
  if (!supabase) return;

  const { data, error } = await supabase.rpc("election_day_list_permission_users_v3", {
    p_session_hash: toPgBytea(sha256Hex(rawSessionToken)),
  });

  if (error) {
    sendError(res, 401, "UNAUTHORIZED");
    return;
  }

  const rows = (Array.isArray(data) ? data : []) as Array<{
    id: string;
    name: string;
    role_id: string;
  }>;

  res
    .status(200)
    .json(rows.map((row) => ({ id: row.id, name: row.name, roleId: row.role_id })));
}

async function handleCreate(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  // 1. Method validation - create/list only in this phase.
  const method = req.method ?? "GET";
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
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_CREATE_BODY_KEYS.has(k));
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
  // otherwise - see mapCreateRpcError above).
  const { data, error } = await supabase.rpc("election_day_create_permission_user_v3", {
    p_session_hash: sessionHashBytea,
    p_reauth_proof_hash: proofHashBytea,
    p_name: name,
    p_password: password,
    p_role_id: roleId,
  });

  if (error) {
    const { status, code } = mapCreateRpcError(error);
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

const ALLOWED_DELETE_BODY_KEYS = new Set<string>(["targetUserId", "reauthProof"]);

// Maps election_day_delete_permission_user_v3's own raised exception
// messages to a fixed, safe HTTP status/code pair. Never forwards the raw
// Postgres message for anything unrecognized.
function mapDeleteRpcError(error: { message?: string } | undefined): {
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

async function handleDelete(req: MinimalRequest, res: MinimalResponse): Promise<void> {
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
  // accepted from the body at all, same reasoning as the create path's own
  // body validation.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_DELETE_BODY_KEYS.has(k));
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
    const { status, code } = mapDeleteRpcError(error);
    sendError(res, status, code);
    return;
  }

  res.status(200).json({ ok: true });
}

const ALLOWED_RESET_PASSWORD_BODY_KEYS = new Set<string>([
  "targetUserId",
  "newPassword",
  "reauthProof",
]);

// Maps election_day_reset_permission_user_password_v3's own raised
// exception messages to a fixed, safe HTTP status/code pair. Never forwards
// the raw Postgres message for anything unrecognized.
function mapResetPasswordRpcError(error: { message?: string } | undefined): {
  status: number;
  code: string;
} {
  switch (error?.message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "USER_NOT_FOUND":
      return { status: 404, code: "USER_NOT_FOUND" };
    case "INVALID_PASSWORD":
      return { status: 400, code: "INVALID_PASSWORD" };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

async function handleResetPassword(
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
  const unknownKey = Object.keys(body).find(
    (k) => !ALLOWED_RESET_PASSWORD_BODY_KEYS.has(k),
  );
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const targetUserId = typeof body.targetUserId === "string" ? body.targetUserId : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const reauthProof = typeof body.reauthProof === "string" ? body.reauthProof : "";

  if (!targetUserId || !newPassword || !reauthProof) {
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

  const { data, error } = await supabase.rpc(
    "election_day_reset_permission_user_password_v3",
    {
      p_session_hash: sessionHashBytea,
      p_reauth_proof_hash: proofHashBytea,
      p_target_user_id: targetUserId,
      p_new_password: newPassword,
    },
  );

  if (error) {
    const { status, code } = mapResetPasswordRpcError(error);
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
  };

  res.status(200).json({ id: row.id, name: row.name, roleId: row.role_id });
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  // The action marker (present only via the two aliased rewrite URLs) is
  // checked BEFORE any GET handling - the original permission-users-
  // delete.ts/permission-users-reset-password.ts files rejected every
  // non-POST method (including GET) with 405, and had no roster-list
  // behavior at all. Checking GET first here would silently reroute a GET
  // on either alias to the roster list (401, not 405) - a real method-
  // handling regression versus each original file, caught via a live
  // Production HTTP check against the actual rewrite before this fix.
  const action = getQueryParam(req, "__pu_action");
  if (action === "delete") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED");
      return;
    }
    await handleDelete(req, res);
    return;
  }
  if (action === "reset-password") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED");
      return;
    }
    await handleResetPassword(req, res);
    return;
  }

  // No action marker - this is the original, un-rewritten permission-users
  // URL: GET = roster list, POST = create, anything else = 405, exactly as
  // before this consolidation.
  if (method === "GET") {
    await handleGet(req, res);
    return;
  }
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }
  await handleCreate(req, res);
}
