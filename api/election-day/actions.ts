import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

// Multi-Tenant Phase 4B: generic Election Day PermissionUser-session trusted
// action router. Renamed from coordinator-allocation.ts (Phase 3C) - the
// original 4 coordinator-allocation ops are preserved byte-for-byte below
// (same RPCs, same required reauth proof, same error mapping); this file now
// also carries the 29 Phase 4B voter/settings/ride-coordinator/non-voting-
// reason trusted actions, none of which require a password step-up proof
// (approved decision - routine actions). vercel.json rewrites the original
// public URL (/api/election-day/coordinator-allocation) to this file, so the
// one live frontend caller (electionDayTrustedCoordinatorAllocationClient.ts)
// needed zero changes for this rename.
//
// Browser -> __Host-kb_ed_session HttpOnly cookie [+ a reauth proof, ONLY for
// the 4 legacy coordinator-allocation ops] -> this function hashes the
// session cookie (and, where required, the proof) in Node -> calls the
// matching election_day_<op>_v3 RPC. Actor/role/workspace are derived
// entirely server-side inside those RPCs from the session hash - this
// endpoint never accepts or forwards a client-supplied actorId/workspaceId/
// roleId/permissions.
//
// Zero-net Vercel Hobby Function count: this rename + extension adds no new
// deployable file (still exactly 1 function for this whole domain, as
// before) - see owner-actions.ts for the Owner-principal mirror.

interface OpDescriptor {
  method: "GET" | "POST";
  rpc: string;
  requiresProof: boolean;
  requiredKeys: string[];
  buildParams: (body: Record<string, unknown>, query: Record<string, unknown>) => Record<string, unknown> | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}
function arr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

const OPS: Record<string, OpDescriptor> = {
  // ---- Phase 3C Coordinator/Allocation (unchanged - reauth-proof-gated) ----
  manage_coordinators: {
    method: "POST",
    rpc: "election_day_manage_coordinators_v3",
    requiresProof: true,
    requiredKeys: ["actions"],
    buildParams: (b) => (arr(b.actions) ? { p_actions: arr(b.actions) } : null),
  },
  apply_initial_allocation: {
    method: "POST",
    rpc: "election_day_apply_initial_allocation_v3",
    requiresProof: true,
    requiredKeys: ["assignments"],
    buildParams: (b) => (arr(b.assignments) ? { p_assignments: arr(b.assignments) } : null),
  },
  rebalance_assignments: {
    method: "POST",
    rpc: "election_day_rebalance_assignments_v3",
    requiresProof: true,
    requiredKeys: ["sources", "destinations"],
    buildParams: (b) =>
      arr(b.sources) && arr(b.destinations)
        ? { p_sources: arr(b.sources), p_destinations: arr(b.destinations) }
        : null,
  },
  end_coordinator_activity: {
    method: "POST",
    rpc: "election_day_end_coordinator_activity_v3",
    requiresProof: true,
    requiredKeys: ["coordinatorId", "mode"],
    buildParams: (b) =>
      str(b.coordinatorId) && str(b.mode)
        ? {
            p_coordinator_id: str(b.coordinatorId),
            p_mode: str(b.mode),
            p_target_coordinator_id: str(b.mode) === "transfer" ? strOrNull(b.targetCoordinatorId) : null,
          }
        : null,
  },

  // ---- Phase 4B: voter mutations (no step-up) ----
  set_ride_arranged: {
    method: "POST", rpc: "election_day_set_ride_arranged_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_arranged: bool(b.arranged) } : null),
  },
  set_ride_requested: {
    method: "POST", rpc: "election_day_set_ride_requested_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_requested: bool(b.requested) } : null),
  },
  set_ride_completed: {
    method: "POST", rpc: "election_day_set_ride_completed_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_completed: bool(b.completed) } : null),
  },
  set_notes: {
    method: "POST", rpc: "election_day_set_notes_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_notes: str(b.notes) } : null),
  },
  set_phone: {
    method: "POST", rpc: "election_day_set_phone_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_phone: str(b.phone) } : null),
  },
  set_reminder: {
    method: "POST", rpc: "election_day_set_reminder_v3", requiresProof: false,
    requiredKeys: ["id", "reminderAt"],
    buildParams: (b) => (str(b.id) && str(b.reminderAt) ? { p_id: str(b.id), p_reminder_at: str(b.reminderAt) } : null),
  },
  close_reminder: {
    method: "POST", rpc: "election_day_close_reminder_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  cancel_reminder: {
    method: "POST", rpc: "election_day_cancel_reminder_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  set_voted: {
    method: "POST", rpc: "election_day_set_voted_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_voted: bool(b.voted) } : null),
  },
  set_non_voting_reason: {
    method: "POST", rpc: "election_day_set_non_voting_reason_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_reason_id: strOrNull(b.reasonId) } : null),
  },
  close_call_as_no_answer: {
    method: "POST", rpc: "election_day_close_call_as_no_answer_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  increment_call_attempts: {
    method: "POST", rpc: "election_day_increment_call_attempts_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  record_no_answer: {
    method: "POST", rpc: "election_day_record_no_answer_v3", requiresProof: false,
    requiredKeys: ["id", "callId"],
    buildParams: (b) => (str(b.id) && str(b.callId) ? { p_id: str(b.id), p_call_id: str(b.callId) } : null),
  },
  record_call_answered: {
    method: "POST", rpc: "election_day_record_call_answered_v3", requiresProof: false,
    requiredKeys: ["id", "callId"],
    buildParams: (b) => (str(b.id) && str(b.callId) ? { p_id: str(b.id), p_call_id: str(b.callId) } : null),
  },
  extend_no_answer_streak_threshold: {
    method: "POST", rpc: "election_day_extend_no_answer_streak_threshold_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },

  // ---- Phase 4B: reads ----
  list_voters: {
    method: "GET", rpc: "election_day_list_voters_v3", requiresProof: false,
    requiredKeys: [], buildParams: () => ({}),
  },
  list_reminder_events: {
    method: "GET", rpc: "election_day_list_reminder_events_v3", requiresProof: false,
    requiredKeys: ["contactId"], buildParams: (_b, q) => (str(q.contactId) ? { p_contact_id: str(q.contactId) } : null),
  },
  list_ride_status_events: {
    method: "GET", rpc: "election_day_list_ride_status_events_v3", requiresProof: false,
    requiredKeys: [], buildParams: () => ({}),
  },
  list_ride_coordinators: {
    method: "GET", rpc: "election_day_list_ride_coordinators_v3", requiresProof: false,
    requiredKeys: [], buildParams: () => ({}),
  },
  get_settings: {
    method: "GET", rpc: "election_day_get_settings_v3", requiresProof: false,
    requiredKeys: [], buildParams: () => ({}),
  },
  list_non_voting_reasons: {
    method: "GET", rpc: "election_day_list_non_voting_reasons_v3", requiresProof: false,
    requiredKeys: [], buildParams: () => ({}),
  },

  // ---- Phase 4B: ride coordinators / settings / non-voting-reasons writes ----
  add_ride_coordinator: {
    method: "POST", rpc: "election_day_add_ride_coordinator_v3", requiresProof: false,
    requiredKeys: ["name"], buildParams: (b) => (str(b.name) ? { p_name: str(b.name), p_phone: str(b.phone) } : null),
  },
  delete_ride_coordinator: {
    method: "POST", rpc: "election_day_delete_ride_coordinator_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  set_settings: {
    method: "POST", rpc: "election_day_set_settings_v3", requiresProof: false,
    requiredKeys: [], buildParams: (b) => ({ p_deadline: strOrNull(b.deadline) }),
  },
  // requiresFollowUp is a required key (not the optional/nullable-field
  // fixed list "isActive"/"reasonId"/"deadline" live in) - it must always be
  // an explicit boolean the client sends, never inferred/defaulted here.
  // Passing p_requires_follow_up by name is also what forces PostgREST to
  // resolve the 4-arg election_day_..._v3 overload (added in
  // 20260831010000) rather than the pre-existing 3-arg one.
  create_non_voting_reason: {
    method: "POST", rpc: "election_day_create_non_voting_reason_v3", requiresProof: false,
    requiredKeys: ["name", "requiresFollowUp"],
    buildParams: (b) => (str(b.name) ? { p_name: str(b.name), p_description: str(b.description), p_requires_follow_up: bool(b.requiresFollowUp) } : null),
  },
  update_non_voting_reason: {
    method: "POST", rpc: "election_day_update_non_voting_reason_v3", requiresProof: false,
    requiredKeys: ["id", "name", "requiresFollowUp"],
    buildParams: (b) => (str(b.id) && str(b.name) ? { p_id: str(b.id), p_name: str(b.name), p_description: str(b.description), p_requires_follow_up: bool(b.requiresFollowUp) } : null),
  },
  set_non_voting_reason_active: {
    method: "POST", rpc: "election_day_set_non_voting_reason_active_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_is_active: bool(b.isActive) } : null),
  },
  delete_non_voting_reason: {
    method: "POST", rpc: "election_day_delete_non_voting_reason_v3", requiresProof: false,
    requiredKeys: ["id"], buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  reorder_non_voting_reasons: {
    method: "POST", rpc: "election_day_reorder_non_voting_reasons_v3", requiresProof: false,
    requiredKeys: ["orderedIds"], buildParams: (b) => (arr(b.orderedIds) ? { p_ordered_ids: arr(b.orderedIds) } : null),
  },
};

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
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
  res.status(status).json({ error: code });
}

function mapRpcError(error: { message?: string } | undefined): { status: number; code: string } {
  const message = error?.message ?? "";
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "FORBIDDEN":
      return { status: 403, code: "FORBIDDEN" };
    case "VOTER_NOT_FOUND":
    case "REASON_NOT_FOUND":
    case "COORDINATOR_NOT_FOUND":
    case "TARGET_NOT_FOUND":
      return { status: 404, code: message };
    case "NO_ANSWER_REASON_NOT_CONFIGURED":
    case "REASON_IN_USE":
    case "REASON_NAME_REQUIRED":
    case "REORDER_ID_MISMATCH":
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
    case "ACTOR_WORKSPACE_REQUIRED":
      return { status: 409, code: message };
    default:
      return { status: 500, code: "SERVER_ERROR" };
  }
}

function parseQuery(url: string | undefined): Record<string, unknown> {
  if (!url) return {};
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function handleGet(req: MinimalRequest, res: MinimalResponse): Promise<void> {
  const query = parseQuery(req.url);
  const opName = str(query.op) || "list_coordinators";

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

  // list_coordinators is the original, unnamed default GET (no ?op= query on
  // the live public URL today) - kept as the implicit default so the one
  // existing live caller (fetchCoordinatorsTrusted, which calls plain GET
  // with no query string) needs zero changes.
  if (opName === "list_coordinators") {
    const { data, error } = await supabase.rpc("election_day_list_coordinators_v3", {
      p_session_hash: sessionHashBytea,
    });
    if (error) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    res.status(200).json(Array.isArray(data) ? data : []);
    return;
  }

  const descriptor = OPS[opName];
  if (!descriptor || descriptor.method !== "GET") {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const params = descriptor.buildParams({}, query);
  if (params === null) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const { data, error } = await supabase.rpc(descriptor.rpc, {
    p_session_hash: sessionHashBytea,
    ...params,
  });

  if (error) {
    const { status, code } = mapRpcError(error);
    sendError(res, status, code);
    return;
  }

  res.status(200).json(data ?? null);
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
  const opName = str(body.op);
  const descriptor = OPS[opName];
  if (!descriptor || descriptor.method !== "POST") {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const allowedBodyKeys = new Set<string>(["op", ...(descriptor.requiresProof ? ["reauthProof"] : []), ...descriptor.requiredKeys, "arranged", "requested", "completed", "notes", "phone", "voted", "reasonId", "callId", "isActive", "description", "targetCoordinatorId", "deadline"]);
  const unknownKey = Object.keys(body).find((k) => !allowedBodyKeys.has(k));
  if (unknownKey) {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  for (const key of descriptor.requiredKeys) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
  }

  let reauthProof = "";
  if (descriptor.requiresProof) {
    reauthProof = str(body.reauthProof);
    if (!reauthProof) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
  }

  const params = descriptor.buildParams(body, {});
  if (params === null) {
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
  const rpcParams: Record<string, unknown> = { p_session_hash: sessionHashBytea, ...params };
  if (descriptor.requiresProof) {
    rpcParams.p_reauth_proof_hash = toPgBytea(sha256Hex(reauthProof));
  }

  const rpcResult = await supabase.rpc(descriptor.rpc, rpcParams);

  if (rpcResult.error) {
    const { status, code } = mapRpcError(rpcResult.error);
    sendError(res, status, code);
    return;
  }

  const data = rpcResult.data;
  res.status(200).json(Array.isArray(data) ? data : (data ?? { ok: true }));
}
