import { createHash, randomBytes } from "node:crypto";
import { extractBearerToken, getServiceClient, verifyOwnerJwt } from "./_ownerAuth.js";

// Multi-Tenant Phase 4B: generic Election Day Owner-JWT trusted action
// router. Renamed from owner-coordinator-allocation.ts (Phase 3C) - the
// original 4 coordinator-allocation ops are preserved byte-for-byte below;
// this file now also carries the 29 Phase 4B _owner_v3 actions, none
// requiring a step-up proof. Not wired into any live frontend route yet (no
// Owner Election Day UI exists) - matches every other Owner path in this
// project. A SEPARATE file from actions.ts (the PermissionUser-session
// path) - an Owner JWT is verified via auth.getUser(jwt) here and nothing
// else, never a PermissionUser session cookie, and vice versa in the sibling
// file. Zero-net Vercel Hobby Function count: rename only, no new file.

interface OpDescriptor {
  method: "GET" | "POST";
  rpc: string;
  requiresProof: boolean;
  /**
   * The RPC still takes a one-time action proof, but the SERVER mints it for
   * this op instead of demanding the Owner re-type their password.
   *
   * The proof's mechanism is untouched - it is still action-bound, still
   * single-use, still consumed inside the same RPC transaction. What changes
   * is what it proves: it stops being a step-up ("the human at the keyboard
   * is the Owner") and becomes an internal transaction token. Authorization
   * for the op therefore rests on the verified Owner JWT plus the RPC's own
   * live workspace re-resolution, which are unchanged.
   *
   * Recorded plainly because it IS a reduction: whoever holds a live Owner
   * session can now perform this op without knowing the Owner's password.
   * Deliberate and requested, and deliberately NOT applied to delete or
   * password-reset, which keep their step-up.
   */
  mintedProofAction?: string;
  requiredKeys: string[];
  buildParams: (
    body: Record<string, unknown>,
    query: Record<string, unknown>,
  ) => Record<string, unknown> | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // --- Stage 3B: workspace provisioning --------------------------------
  // provision_workspace deliberately carries requiresProof:false. Every other
  // proofed op re-authenticates a privileged action inside an ALREADY
  // provisioned workspace; this one is what creates the workspace, and the
  // Owner's authority for it comes from the pending-access row the Platform
  // Owner created, re-read and locked inside the RPC. A step-up proof is not
  // available here anyway: election_day_owner_reauth resolves the caller
  // through election_owners, the row this op exists to create.
  provision_workspace: {
    method: "POST",
    rpc: "election_day_provision_workspace",
    requiresProof: false,
    requiredKeys: ["workspaceName", "electionEndAt"],
    buildParams: (b) => {
      const name = str(b.workspaceName).trim();
      const endAt = str(b.electionEndAt).trim();
      if (!name || !endAt) return null;
      // Reject anything Date cannot parse, so a malformed string becomes a
      // 400 here rather than a Postgres cast error at the RPC boundary.
      if (Number.isNaN(Date.parse(endAt))) return null;
      return { p_workspace_name: name, p_election_end_at: endAt };
    },
  },
  // --- Stage 9: Owner administration (user management + entitlements) ---
  // Replaces Stage 3B's one-shot bootstrap_first_user: the Owner manages
  // workspace users directly, at any time, including a workspace with zero
  // users. Each mutation RPC binds its own action literal to a one-time Owner
  // proof and re-resolves the Owner's workspace live.
  list_permission_users: {
    method: "GET",
    rpc: "election_day_list_permission_users_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  workspace_modules: {
    method: "GET",
    rpc: "election_day_list_workspace_modules_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  create_permission_user: {
    method: "POST",
    // v4 = v3 plus the globally-unique login username, claimed in the same
    // transaction. `username` is optional: omitted, the server defaults it to
    // the name the Owner typed (first name + last name).
    rpc: "election_day_create_permission_user_owner_v4",
    // No step-up: a signed-in Owner creating a user is not asked for their own
    // password again. The RPC's proof is minted server-side (see
    // mintedProofAction) so its one-time, action-bound contract is unchanged
    // and no migration is needed.
    requiresProof: false,
    mintedProofAction: "create_permission_user",
    requiredKeys: ["name", "password", "roleId"],
    buildParams: (b) => {
      const name = str(b.name).trim();
      const password = str(b.password);
      const roleId = str(b.roleId);
      const username = str(b.username).trim();
      if (!name || !password || !UUID_PATTERN.test(roleId)) return null;
      return {
        p_name: name,
        p_password: password,
        p_role_id: roleId,
        p_username: username === "" ? null : username,
      };
    },
  },
  delete_permission_user: {
    method: "POST",
    rpc: "election_day_delete_permission_user_owner_v3",
    requiresProof: true,
    requiredKeys: ["targetUserId"],
    buildParams: (b) => {
      const targetUserId = str(b.targetUserId);
      return UUID_PATTERN.test(targetUserId) ? { p_target_user_id: targetUserId } : null;
    },
  },
  reset_permission_user_password: {
    method: "POST",
    rpc: "election_day_reset_permission_user_password_owner_v3",
    requiresProof: true,
    requiredKeys: ["targetUserId", "newPassword"],
    buildParams: (b) => {
      const targetUserId = str(b.targetUserId);
      const newPassword = str(b.newPassword);
      if (!UUID_PATTERN.test(targetUserId) || !newPassword) return null;
      return { p_target_user_id: targetUserId, p_new_password: newPassword };
    },
  },
  manage_coordinators: {
    method: "POST",
    rpc: "election_day_manage_coordinators_owner_v3",
    requiresProof: true,
    requiredKeys: ["actions"],
    buildParams: (b) => (arr(b.actions) ? { p_actions: arr(b.actions) } : null),
  },
  apply_initial_allocation: {
    method: "POST",
    rpc: "election_day_apply_initial_allocation_owner_v3",
    requiresProof: true,
    requiredKeys: ["assignments"],
    buildParams: (b) =>
      arr(b.assignments) ? { p_assignments: arr(b.assignments) } : null,
  },
  rebalance_assignments: {
    method: "POST",
    rpc: "election_day_rebalance_assignments_owner_v3",
    requiresProof: true,
    requiredKeys: ["sources", "destinations"],
    buildParams: (b) =>
      arr(b.sources) && arr(b.destinations)
        ? { p_sources: arr(b.sources), p_destinations: arr(b.destinations) }
        : null,
  },
  end_coordinator_activity: {
    method: "POST",
    rpc: "election_day_end_coordinator_activity_owner_v3",
    requiresProof: true,
    requiredKeys: ["coordinatorId", "mode"],
    buildParams: (b) =>
      str(b.coordinatorId) && str(b.mode)
        ? {
            p_coordinator_id: str(b.coordinatorId),
            p_mode: str(b.mode),
            p_target_coordinator_id:
              str(b.mode) === "transfer" ? strOrNull(b.targetCoordinatorId) : null,
          }
        : null,
  },

  set_ride_arranged: {
    method: "POST",
    rpc: "election_day_set_ride_arranged_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) =>
      str(b.id) ? { p_id: str(b.id), p_arranged: bool(b.arranged) } : null,
  },
  set_ride_requested: {
    method: "POST",
    rpc: "election_day_set_ride_requested_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) =>
      str(b.id) ? { p_id: str(b.id), p_requested: bool(b.requested) } : null,
  },
  set_ride_completed: {
    method: "POST",
    rpc: "election_day_set_ride_completed_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) =>
      str(b.id) ? { p_id: str(b.id), p_completed: bool(b.completed) } : null,
  },
  set_notes: {
    method: "POST",
    rpc: "election_day_set_notes_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_notes: str(b.notes) } : null),
  },
  set_phone: {
    method: "POST",
    rpc: "election_day_set_phone_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_phone: str(b.phone) } : null),
  },
  set_reminder: {
    method: "POST",
    rpc: "election_day_set_reminder_owner_v3",
    requiresProof: false,
    requiredKeys: ["id", "reminderAt"],
    buildParams: (b) =>
      str(b.id) && str(b.reminderAt)
        ? { p_id: str(b.id), p_reminder_at: str(b.reminderAt) }
        : null,
  },
  close_reminder: {
    method: "POST",
    rpc: "election_day_close_reminder_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  cancel_reminder: {
    method: "POST",
    rpc: "election_day_cancel_reminder_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  set_voted: {
    method: "POST",
    rpc: "election_day_set_voted_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id), p_voted: bool(b.voted) } : null),
  },
  set_non_voting_reason: {
    method: "POST",
    rpc: "election_day_set_non_voting_reason_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) =>
      str(b.id) ? { p_id: str(b.id), p_reason_id: strOrNull(b.reasonId) } : null,
  },
  close_call_as_no_answer: {
    method: "POST",
    rpc: "election_day_close_call_as_no_answer_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  increment_call_attempts: {
    method: "POST",
    rpc: "election_day_increment_call_attempts_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  record_no_answer: {
    method: "POST",
    rpc: "election_day_record_no_answer_owner_v3",
    requiresProof: false,
    requiredKeys: ["id", "callId"],
    buildParams: (b) =>
      str(b.id) && str(b.callId) ? { p_id: str(b.id), p_call_id: str(b.callId) } : null,
  },
  record_call_answered: {
    method: "POST",
    rpc: "election_day_record_call_answered_owner_v3",
    requiresProof: false,
    requiredKeys: ["id", "callId"],
    buildParams: (b) =>
      str(b.id) && str(b.callId) ? { p_id: str(b.id), p_call_id: str(b.callId) } : null,
  },
  extend_no_answer_streak_threshold: {
    method: "POST",
    rpc: "election_day_extend_no_answer_streak_threshold_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },

  list_voters: {
    method: "GET",
    rpc: "election_day_list_voters_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  list_reminder_events: {
    method: "GET",
    rpc: "election_day_list_reminder_events_owner_v3",
    requiresProof: false,
    requiredKeys: ["contactId"],
    buildParams: (_b, q) =>
      str(q.contactId) ? { p_contact_id: str(q.contactId) } : null,
  },
  list_ride_status_events: {
    method: "GET",
    rpc: "election_day_list_ride_status_events_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  list_ride_coordinators: {
    method: "GET",
    rpc: "election_day_list_ride_coordinators_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  get_settings: {
    method: "GET",
    rpc: "election_day_get_settings_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },
  list_non_voting_reasons: {
    method: "GET",
    rpc: "election_day_list_non_voting_reasons_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: () => ({}),
  },

  add_ride_coordinator: {
    method: "POST",
    rpc: "election_day_add_ride_coordinator_owner_v3",
    requiresProof: false,
    requiredKeys: ["name"],
    buildParams: (b) =>
      str(b.name) ? { p_name: str(b.name), p_phone: str(b.phone) } : null,
  },
  delete_ride_coordinator: {
    method: "POST",
    rpc: "election_day_delete_ride_coordinator_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  set_settings: {
    method: "POST",
    rpc: "election_day_set_settings_owner_v3",
    requiresProof: false,
    requiredKeys: [],
    buildParams: (b) => ({ p_deadline: strOrNull(b.deadline) }),
  },
  // requiresFollowUp is required (not optional), same reasoning as
  // actions.ts's own create/update entries - explicit p_requires_follow_up
  // forces PostgREST to resolve the 4-arg _owner_v3 overload, not the
  // pre-existing 3-arg one.
  create_non_voting_reason: {
    method: "POST",
    rpc: "election_day_create_non_voting_reason_owner_v3",
    requiresProof: false,
    requiredKeys: ["name", "requiresFollowUp"],
    buildParams: (b) =>
      str(b.name)
        ? {
            p_name: str(b.name),
            p_description: str(b.description),
            p_requires_follow_up: bool(b.requiresFollowUp),
          }
        : null,
  },
  update_non_voting_reason: {
    method: "POST",
    rpc: "election_day_update_non_voting_reason_owner_v3",
    requiresProof: false,
    requiredKeys: ["id", "name", "requiresFollowUp"],
    buildParams: (b) =>
      str(b.id) && str(b.name)
        ? {
            p_id: str(b.id),
            p_name: str(b.name),
            p_description: str(b.description),
            p_requires_follow_up: bool(b.requiresFollowUp),
          }
        : null,
  },
  set_non_voting_reason_active: {
    method: "POST",
    rpc: "election_day_set_non_voting_reason_active_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) =>
      str(b.id) ? { p_id: str(b.id), p_is_active: bool(b.isActive) } : null,
  },
  delete_non_voting_reason: {
    method: "POST",
    rpc: "election_day_delete_non_voting_reason_owner_v3",
    requiresProof: false,
    requiredKeys: ["id"],
    buildParams: (b) => (str(b.id) ? { p_id: str(b.id) } : null),
  },
  reorder_non_voting_reasons: {
    method: "POST",
    rpc: "election_day_reorder_non_voting_reasons_owner_v3",
    requiresProof: false,
    requiredKeys: ["orderedIds"],
    buildParams: (b) => (arr(b.orderedIds) ? { p_ordered_ids: arr(b.orderedIds) } : null),
  },
};

interface MinimalRequest {
  method?: string;
  url?: string;
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

// Stage 9: ops that belong to Owner ADMINISTRATION (or to provisioning), not
// to the Election Day module. Every other op is an Election Day data op and
// is refused while the workspace is not entitled to Election Day - checked
// here, server-side, before its RPC runs. Those RPCs are service_role-only,
// so this handler is the only way any caller can reach them.
/**
 * THE ONLY PLACE THAT PROPOSES A LOGIN USERNAME: base -> base1 -> base2 -> ...
 *
 * Used by BOTH the pre-check op and the USERNAME_TAKEN answer, so the name
 * offered before the password step and the name offered after a lost race can
 * never disagree. It is a SUGGESTION only - the partial unique index on
 * auth_identities remains the sole enforcement, and a suggestion that goes
 * stale between the check and the create is caught there, not here.
 *
 * Built on auth_identity_suggest_username rather than replacing it: that
 * function returns the base when the base is free, and otherwise the first
 * free base2/base3/... The one thing it does not offer is base1, so the base1
 * slot is probed explicitly with the same function (asking whether base1 is
 * returned unchanged, i.e. is itself free). At most two round trips, no
 * second definition of normalization, and no schema change.
 */
async function suggestWorkerUsername(
  supabase: ReturnType<typeof getServiceClient>,
  base: string,
): Promise<{ available: boolean; suggestion: string | null }> {
  const canonical = base.trim().normalize("NFC");
  if (canonical === "") return { available: false, suggestion: null };
  const suggest = (p_base: string) =>
    supabase.rpc("auth_identity_suggest_username", { p_realm: "worker", p_base });
  const first = await suggest(canonical);
  // An error here is NOT "available": exhausted (NO_USERNAME_AVAILABLE) and a
  // transport failure both have to fall through to "pick another name", and
  // the create itself stays the authority either way.
  if (first.error || typeof first.data !== "string") {
    return { available: false, suggestion: null };
  }
  if (first.data === canonical) return { available: true, suggestion: canonical };
  const one = `${canonical}1`;
  const probe = await suggest(one);
  if (!probe.error && probe.data === one) return { available: false, suggestion: one };
  return { available: false, suggestion: first.data };
}

const NON_MODULE_OPS = new Set<string>([
  "provision_workspace",
  "list_permission_users",
  "workspace_modules",
  "create_permission_user",
  "delete_permission_user",
  "reset_permission_user_password",
]);

type ModuleGate = "enabled" | "disabled" | "unauthorized" | "error";

async function electionDayModuleGate(
  supabase: ReturnType<typeof getServiceClient>,
  authUserId: string,
): Promise<ModuleGate> {
  const { data, error } = await supabase.rpc("election_day_owner_has_module", {
    p_auth_user_id: authUserId,
    p_module_key: "election_day",
  });
  if (error) return error.message === "UNAUTHORIZED" ? "unauthorized" : "error";
  return data === true ? "enabled" : "disabled";
}

/** Sends the refusal for a non-"enabled" gate. Returns true when it did. */
function refuseUnlessEnabled(res: MinimalResponse, gate: ModuleGate): boolean {
  if (gate === "enabled") return false;
  if (gate === "unauthorized") sendError(res, 401, "UNAUTHORIZED");
  else if (gate === "disabled") sendError(res, 403, "MODULE_NOT_ENABLED");
  else sendError(res, 500, "SERVER_ERROR");
  return true;
}

function mapRpcError(error: { message?: string; code?: string } | undefined): {
  status: number;
  code: string;
} {
  const message = error?.message ?? "";
  // Stage 9: the Owner create path hits UNIQUE(workspace_id, name) as a real
  // Postgres unique_violation (never P0001) - matched narrowly on SQLSTATE +
  // constraint, exactly like permission-users.ts did for the worker path.
  if (
    error?.code === "23505" &&
    message.includes("election_day_permission_users_workspace_id_name_key")
  ) {
    return { status: 409, code: "DUPLICATE_NAME" };
  }
  switch (message) {
    case "UNAUTHORIZED":
      return { status: 401, code: "UNAUTHORIZED" };
    case "USER_NOT_FOUND":
      return { status: 404, code: "USER_NOT_FOUND" };
    case "CANNOT_RESET_MANAGER":
      return { status: 409, code: "CANNOT_RESET_MANAGER" };
    case "USERNAME_TAKEN":
      return { status: 409, code: "USERNAME_TAKEN" };
    case "INVALID_USERNAME":
      return { status: 400, code: "INVALID_USERNAME" };
    case "NO_USERNAME_AVAILABLE":
      return { status: 409, code: "NO_USERNAME_AVAILABLE" };
    case "INVALID_PASSWORD":
      return { status: 400, code: "INVALID_PASSWORD" };
    case "VOTER_NOT_FOUND":
    case "REASON_NOT_FOUND":
    case "COORDINATOR_NOT_FOUND":
    case "TARGET_NOT_FOUND":
    case "ROLE_NOT_FOUND":
    case "PENDING_ACCESS_NOT_FOUND":
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
    case "MISSING_WORKSPACE_NAME":
    case "MISSING_ELECTION_END_AT":
    case "WORKSPACE_NAME_TOO_LONG":
    case "NAME_REQUIRED":
    case "PASSWORD_REQUIRED":
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
    case "PENDING_ACCESS_EXPIRED":
    case "PENDING_ACCESS_ALREADY_CONSUMED":
    case "BOOTSTRAP_ALREADY_COMPLETED":
    case "APPROVAL_MODULES_MISSING": // Stage 9: module-less approval fails closed
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

  // op=session - folded in from the former api/election-day/owner-session.ts
  // (deleted to free one Vercel Hobby Function slot); the public URL
  // /api/election-day/owner-session is preserved by a vercel.json rewrite to
  // owner-actions?op=session, so the frontend contract is unchanged. Behavior
  // is identical to the old file: Election Owner JWT only (verified above,
  // before any op dispatch), the same election_day_resolve_owner_context RPC,
  // the same {ownerId, workspaceId} body, the same 401/500 semantics.
  if (opName === "session") {
    const { data, error } = await supabase.rpc("election_day_resolve_owner_context", {
      p_auth_user_id: verified.authUserId,
    });

    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      owner_id: string;
      workspace_id: string;
    };

    res.status(200).json({ ownerId: row.owner_id, workspaceId: row.workspace_id });
    return;
  }

  // op=provisioning_state - Stage 3B. Special-cased next to op=session for the
  // same structural reason and the opposite requirement: session resolves an
  // election_owners row and 401s without one, which is exactly the state an
  // approved-but-not-yet-provisioned Owner is in. This op answers "what should
  // this authenticated person see next?" and returns provisioned / pending /
  // expired / invalid without asserting any authority of its own. The JWT is
  // still verified above, before any dispatch.
  if (opName === "provisioning_state") {
    const { data, error } = await supabase.rpc(
      "election_day_resolve_owner_provisioning_state",
      { p_auth_user_id: verified.authUserId },
    );

    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
    res.status(200).json({
      state: row.state,
      ownerId: row.owner_id ?? null,
      workspaceId: row.workspace_id ?? null,
      workspaceName: row.workspace_name ?? null,
      electionEndAt: row.election_end_at ?? null,
      loginCode: row.login_code ?? null,
      pendingName: row.pending_name ?? null,
      pendingEmail: row.pending_email ?? null,
      pendingExpiresAt: row.pending_expires_at ?? null,
      hasPermissionUsers: row.has_permission_users === true,
    });
    return;
  }

  if (!NON_MODULE_OPS.has(opName)) {
    const gate = await electionDayModuleGate(supabase, verified.authUserId);
    if (refuseUnlessEnabled(res, gate)) return;
  }

  if (opName === "list_coordinators") {
    const { data, error } = await supabase.rpc(
      "election_day_list_coordinators_owner_v3",
      {
        p_auth_user_id: verified.authUserId,
      },
    );
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
    p_auth_user_id: verified.authUserId,
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

  // The /api/election-day/owner-session rewrite lands here with ?op=session
  // on EVERY method, not just GET. The deleted owner-session.ts answered a
  // non-GET with 405 METHOD_NOT_ALLOWED; without this guard a POST to that
  // public URL would fall through to the body-based op dispatch below and
  // answer 400 INVALID_REQUEST instead, silently changing the endpoint's
  // published contract. Checked before anything else so the 405 is not
  // masked by the Origin check.
  if (str(parseQuery(req.url).op) === "session") {
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

  // ---------------------------------------------------------------------
  // suggest_permission_user_username - the pre-check, before the password
  // step. Reads only; creates nothing, claims nothing, and is NOT part of
  // the RPC-descriptor machinery because it answers from the shared helper
  // rather than from one RPC.
  //
  // Deliberately NOT module-gated: Owner user administration is available in
  // a workspace entitled to nothing (see CLAUDE.md), exactly like the create
  // and list ops beside it.
  //
  // It tells an authenticated Election Owner whether a login username is
  // free. That is the same fact the create call already discloses through
  // USERNAME_TAKEN, so it opens no new disclosure - it just moves it before
  // the password instead of after it.
  // ---------------------------------------------------------------------
  if (opName === "suggest_permission_user_username") {
    if (Object.keys(body).some((k) => k !== "op" && k !== "username")) {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const requested = str(body.username).trim();
    if (requested === "") {
      sendError(res, 400, "INVALID_REQUEST");
      return;
    }
    const token = extractBearerToken(req);
    if (!token) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    const owner = await verifyOwnerJwt(token);
    if (!owner) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    let client: ReturnType<typeof getServiceClient>;
    try {
      client = getServiceClient();
    } catch {
      sendError(res, 500, "SERVER_CONFIG_MISSING");
      return;
    }
    // Only a real Election Owner may ask. verifyOwnerJwt proves the account;
    // this proves the principal, the same resolution every op below relies on.
    const resolved = await client.rpc("election_day_resolve_owner_context", {
      p_auth_user_id: owner.authUserId,
    });
    if (
      resolved.error ||
      !resolved.data ||
      (Array.isArray(resolved.data) && resolved.data.length === 0)
    ) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    const { available, suggestion } = await suggestWorkerUsername(client, requested);
    res.status(200).json({ requested, available, suggestion });
    return;
  }

  const descriptor = OPS[opName];
  if (!descriptor || descriptor.method !== "POST") {
    sendError(res, 400, "INVALID_REQUEST");
    return;
  }

  const allowedBodyKeys = new Set<string>([
    "op",
    ...(descriptor.requiresProof ? ["reauthProof"] : []),
    ...descriptor.requiredKeys,
    // Optional on create_permission_user: when absent the server defaults the
    // login username to the name the Owner typed.
    "username",
    "arranged",
    "requested",
    "completed",
    "notes",
    "phone",
    "voted",
    "reasonId",
    "callId",
    "isActive",
    "description",
    "targetCoordinatorId",
    "deadline",
  ]);
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

  if (!NON_MODULE_OPS.has(opName)) {
    const gate = await electionDayModuleGate(supabase, verified.authUserId);
    if (refuseUnlessEnabled(res, gate)) return;
  }

  const rpcParams: Record<string, unknown> = {
    p_auth_user_id: verified.authUserId,
    ...params,
  };
  if (descriptor.requiresProof) {
    rpcParams.p_reauth_proof_hash = toPgBytea(sha256Hex(reauthProof));
  } else if (descriptor.mintedProofAction) {
    // Minted HERE, for this one call, and never returned to anyone: the raw
    // value exists only in this local variable. election_day_owner_reauth
    // verifies no password - it resolves the Owner from the id and issues an
    // action-bound row - so the password check that used to sit in front of
    // it (in owner-reauth.ts) is what is being removed, not the proof itself.
    // A failure to mint means the caller is not a resolvable Owner: refuse.
    const rawProof = randomBytes(32).toString("hex");
    const proofHash = toPgBytea(sha256Hex(rawProof));
    const minted = await supabase.rpc("election_day_owner_reauth", {
      p_auth_user_id: verified.authUserId,
      p_action: descriptor.mintedProofAction,
      p_proof_hash: proofHash,
    });
    if (minted.error) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }
    rpcParams.p_reauth_proof_hash = proofHash;
  }

  const rpcResult = await supabase.rpc(descriptor.rpc, rpcParams);

  if (rpcResult.error) {
    const { status, code } = mapRpcError(rpcResult.error);
    // A taken login username is an ordinary product outcome, not a failure to
    // report generically: answer with the next free name so the Owner can
    // accept it in one click instead of guessing.
    if (code === "USERNAME_TAKEN" && opName === "create_permission_user") {
      const base = str(body.username).trim() || str(body.name).trim();
      const { suggestion } = await suggestWorkerUsername(supabase, base);
      res.status(409).json({ error: "USERNAME_TAKEN", requested: base, suggestion });
      return;
    }
    sendError(res, status, code);
    return;
  }

  const data = rpcResult.data;
  res.status(200).json(Array.isArray(data) ? data : (data ?? { ok: true }));
}
