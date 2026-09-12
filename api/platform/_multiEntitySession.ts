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
//   GET /api/multi-entity/session              -> ?me_op=session
//   GET /api/multi-entity/workspace            -> ?me_op=workspace&workspaceId=<uuid>
//   GET /api/multi-entity/aggregates           -> ?me_op=aggregates            (Stage 6)
//   GET /api/multi-entity/workspace-aggregates -> ?me_op=workspace_aggregates&workspaceId=<uuid> (Stage 6)
//
// READ-ONLY. There is no Multi-Entity mutation. Stage 5 responses carry
// authorization METADATA only (id, name, electionEndAt, assignedAt). Stage 6
// adds AGGREGATE COUNTS only - never a row, a person, free text or login_code.
// Which counts exist, and when they are withheld (ended workspace, fewer than
// 10 contacts), is decided in the database (migration 20260913000000); this
// handler only maps the approved shape strictly and never fills in a number
// the database withheld.
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
const ME_OPS = new Set<string>([
  "session",
  "workspace",
  "aggregates",
  "workspace_aggregates",
]);
/** The ops that address ONE workspace - the only ones that take (and require)
 * a `workspaceId`. */
const WORKSPACE_ID_OPS = new Set<string>(["workspace", "workspace_aggregates"]);
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

// ---- Stage 6 aggregates -----------------------------------------------------

// Stage 9: "unavailable" - the workspace is not entitled to Election Day, so
// the database released no Election Day number for it (like ended/suppressed).
type ReportStatus = "reported" | "suppressed" | "ended" | "unavailable";
const REPORT_STATUSES = new Set<string>([
  "reported",
  "suppressed",
  "ended",
  "unavailable",
]);

interface AggregateMetrics {
  contactsTotal: number;
  voted: number;
  followUpClosed: number;
  followUpRemaining: number;
  rideNeeded: number;
  rideArranged: number;
  rideCompleted: number;
}

interface WorkspaceAggregate extends WorkspaceMetadata {
  status: ReportStatus;
  /** Present ONLY for `reported`; `null` whenever the database withheld the
   * counts (ended workspace, or fewer than the minimum reportable contacts). */
  metrics: AggregateMetrics | null;
}

const METRIC_COLUMNS = [
  ["contacts_total", "contactsTotal"],
  ["voted", "voted"],
  ["follow_up_closed", "followUpClosed"],
  ["follow_up_remaining", "followUpRemaining"],
  ["ride_needed", "rideNeeded"],
  ["ride_arranged", "rideArranged"],
  ["ride_completed", "rideCompleted"],
] as const satisfies readonly (readonly [string, keyof AggregateMetrics])[];

const zeroMetrics = (): AggregateMetrics => ({
  contactsTotal: 0,
  voted: 0,
  followUpClosed: 0,
  followUpRemaining: 0,
  rideNeeded: 0,
  rideArranged: 0,
  rideCompleted: 0,
});

/** Strict aggregate mapping. A `reported` row must carry seven non-negative
 * integers that satisfy the contract's partitions (voted + closed + remaining
 * = total; the three ride buckets never exceed total); any other status must
 * carry NO number at all. Anything else is a server fault - never a partially
 * trusted row. */
function toAggregate(row: unknown): WorkspaceAggregate | null {
  const meta = toWorkspace(row);
  if (!meta) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.report_status !== "string" || !REPORT_STATUSES.has(r.report_status))
    return null;
  const status = r.report_status as ReportStatus;

  if (status !== "reported") {
    if (METRIC_COLUMNS.some(([col]) => r[col] !== null)) return null;
    return { ...meta, status, metrics: null };
  }

  const metrics = zeroMetrics();
  for (const [col, key] of METRIC_COLUMNS) {
    const value = r[col];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
    metrics[key] = value;
  }
  if (
    metrics.voted + metrics.followUpClosed + metrics.followUpRemaining !==
      metrics.contactsTotal ||
    metrics.rideNeeded + metrics.rideArranged + metrics.rideCompleted >
      metrics.contactsTotal
  ) {
    return null;
  }
  return { ...meta, status, metrics };
}

/** Cross-workspace totals, built ONLY from released (`reported`) rows - a
 * withheld workspace contributes to the counts of workspaces, never to a
 * metric, so totals can never be differenced against per-workspace rows to
 * recover it. */
function summarize(workspaces: readonly WorkspaceAggregate[]) {
  const metrics = zeroMetrics();
  let reported = 0;
  let suppressed = 0;
  let ended = 0;
  let unavailable = 0;
  for (const w of workspaces) {
    if (w.status === "reported" && w.metrics) {
      reported++;
      for (const [, key] of METRIC_COLUMNS) metrics[key] += w.metrics[key];
    } else if (w.status === "suppressed") {
      suppressed++;
    } else if (w.status === "unavailable") {
      unavailable++;
    } else {
      ended++;
    }
  }
  return {
    workspaceCount: workspaces.length,
    reportedWorkspaceCount: reported,
    suppressedWorkspaceCount: suppressed,
    endedWorkspaceCount: ended,
    unavailableWorkspaceCount: unavailable,
    metrics,
  };
}

function rpcMessage(error: { message?: string } | null): string {
  return (error?.message ?? "").toUpperCase();
}

/** Refusal mapping for the seat-scoped list RPCs (no client-supplied id). */
function sendListRpcError(res: MultiEntityResponse, error: { message?: string }): void {
  if (rpcMessage(error).includes("UNAUTHORIZED")) {
    logDenied("not_seat");
    sendError(res, 401, "UNAUTHORIZED");
  } else {
    sendError(res, 500, "SERVER_ERROR");
  }
}

/** Refusal mapping for the one-workspace RPCs: unassigned and nonexistent are
 * the same 403 (the DB gate raises the same error for both). */
function sendWorkspaceRpcError(
  res: MultiEntityResponse,
  error: { message?: string },
): void {
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
}

function rowsOf(data: unknown): unknown[] {
  return Array.isArray(data) ? data : data ? [data] : [];
}

export async function handleMultiEntityRequest(
  req: MultiEntityRequest,
  res: MultiEntityResponse,
): Promise<void> {
  // Carries the verified identity, assignment scope and aggregates - never
  // cacheable, including on error responses.
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
  if (WORKSPACE_ID_OPS.has(op)) {
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
      sendListRpcError(res, error);
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

  if (op === "aggregates") {
    // The workspace set is derived INSIDE the RPC from the current assignment
    // rows (no client input can widen it); the per-workspace gate and every
    // count share that one call's snapshot.
    const { data, error } = await supabase.rpc("multi_entity_list_workspace_aggregates", {
      p_auth_user_id: owner.authUserId,
    });
    if (error) {
      sendListRpcError(res, error);
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    const workspaces = rows.map(toAggregate);
    if (workspaces.some((w) => w === null)) {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }
    const released = workspaces as WorkspaceAggregate[];
    res.status(200).json({ workspaces: released, totals: summarize(released) });
    return;
  }

  // One-workspace ops: the client-supplied id is UNTRUSTED - authorized solely
  // by the DB gate, in the same snapshot as the read.
  const rpcName =
    op === "workspace"
      ? "multi_entity_get_assigned_workspace"
      : "multi_entity_get_workspace_aggregate";
  const { data, error } = await supabase.rpc(rpcName, {
    p_auth_user_id: owner.authUserId,
    p_workspace_id: workspaceId,
  });
  if (error) {
    sendWorkspaceRpcError(res, error);
    return;
  }
  const rows = rowsOf(data);
  if (rows.length !== 1) {
    // Unreachable in practice (the gate raises first); fail closed with the
    // same answer an unassigned workspace gets.
    logDenied("not_assigned");
    sendError(res, 403, "FORBIDDEN");
    return;
  }
  const mapped = op === "workspace" ? toWorkspace(rows[0]) : toAggregate(rows[0]);
  if (!mapped) {
    sendError(res, 500, "SERVER_ERROR");
    return;
  }
  res.status(200).json(mapped);
}
