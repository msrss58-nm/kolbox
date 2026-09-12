/**
 * Platform Stage 5: pure fetch wrapper around the Multi-Entity Owner session
 * endpoint (`GET /api/multi-entity/session`). Same conventions as
 * `platformOwnerClient.ts` - a small discriminated union, no HTTP status
 * leaking past this module, no React/zustand dependency, and the access token
 * supplied explicitly by the caller.
 *
 * The SERVER is the authority. It verifies the JWT (getUser -> getClaims
 * aal2 -> the exclusive seat) and derives the assigned-workspace list from
 * committed rows on every call. A `200` here is the ONLY thing that may unlock
 * the Multi-Entity surface; nothing client-side is ever sufficient.
 */

const MULTI_ENTITY_SESSION_ENDPOINT = "/api/multi-entity/session";

/** Authorization metadata only - never login_code, never business data. */
export interface MultiEntityWorkspace {
  workspaceId: string;
  name: string;
  electionEndAt: string;
  assignedAt: string;
}

export interface MultiEntityOwnerContext {
  authUserId: string;
  email: string;
  name: string;
  workspaces: MultiEntityWorkspace[];
}

export type MultiEntityOwnerSessionResult =
  | { status: "ok"; context: MultiEntityOwnerContext }
  /** 401 - not the current Multi-Entity Owner, not aal2, or a bad/revoked token. */
  | { status: "unauthorized" }
  /** Transport failure, 405, 500, or an unparseable/malformed body. */
  | { status: "error" };

function isWorkspace(value: unknown): value is MultiEntityWorkspace {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspaceId === "string" &&
    typeof v.name === "string" &&
    typeof v.electionEndAt === "string" &&
    typeof v.assignedAt === "string"
  );
}

function toContext(value: unknown): MultiEntityOwnerContext | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.authUserId !== "string" ||
    typeof v.email !== "string" ||
    typeof v.name !== "string" ||
    !Array.isArray(v.workspaces) ||
    !v.workspaces.every(isWorkspace)
  ) {
    return null;
  }
  // Rebuilt field by field so nothing unexpected is ever carried into state.
  return {
    authUserId: v.authUserId,
    email: v.email,
    name: v.name,
    workspaces: v.workspaces.map((w: MultiEntityWorkspace) => ({
      workspaceId: w.workspaceId,
      name: w.name,
      electionEndAt: w.electionEndAt,
      assignedAt: w.assignedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Platform Stage 7: the Stage 6 AGGREGATE endpoints - the dashboard's only
// data source. The server decides which workspaces exist, which release
// numbers (`reported`) and which withhold them (`suppressed` - fewer than 10
// contacts, `ended` - the election is over). This module never invents,
// defaults or back-fills a number: a withheld row is carried as
// `metrics: null`, and any row that is not EXACTLY the Stage 6 shape turns
// the whole response into an error rather than a partially trusted render.
// ---------------------------------------------------------------------------

const MULTI_ENTITY_AGGREGATES_ENDPOINT = "/api/multi-entity/aggregates";
const MULTI_ENTITY_WORKSPACE_AGGREGATES_ENDPOINT =
  "/api/multi-entity/workspace-aggregates";

// Stage 9: "unavailable" - the workspace is not entitled to Election Day; the
// server releases no Election Day number for it.
export type MultiEntityReportStatus = "reported" | "suppressed" | "ended" | "unavailable";

export interface MultiEntityAggregateMetrics {
  contactsTotal: number;
  voted: number;
  followUpClosed: number;
  followUpRemaining: number;
  rideNeeded: number;
  rideArranged: number;
  rideCompleted: number;
}

export const MULTI_ENTITY_METRIC_KEYS = [
  "contactsTotal",
  "voted",
  "followUpClosed",
  "followUpRemaining",
  "rideNeeded",
  "rideArranged",
  "rideCompleted",
] as const satisfies readonly (keyof MultiEntityAggregateMetrics)[];

export interface MultiEntityWorkspaceAggregate extends MultiEntityWorkspace {
  status: MultiEntityReportStatus;
  /** Present ONLY for `reported`; `null` means withheld - never zero. */
  metrics: MultiEntityAggregateMetrics | null;
}

export interface MultiEntityAggregateTotals {
  workspaceCount: number;
  reportedWorkspaceCount: number;
  suppressedWorkspaceCount: number;
  endedWorkspaceCount: number;
  unavailableWorkspaceCount: number;
  /** Summed by the server from `reported` rows only. */
  metrics: MultiEntityAggregateMetrics;
}

export interface MultiEntityAggregates {
  workspaces: MultiEntityWorkspaceAggregate[];
  totals: MultiEntityAggregateTotals;
}

export type MultiEntityAggregatesResult =
  | { status: "ok"; aggregates: MultiEntityAggregates }
  | { status: "unauthorized" }
  | { status: "error" };

export type MultiEntityWorkspaceAggregateResult =
  | { status: "ok"; workspace: MultiEntityWorkspaceAggregate }
  | { status: "unauthorized" }
  /** 403 (unassigned or nonexistent - identical by design) or 400. */
  | { status: "not_assigned" }
  | { status: "error" };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function toMetrics(value: unknown): MultiEntityAggregateMetrics | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!MULTI_ENTITY_METRIC_KEYS.every((key) => isCount(v[key]))) return null;
  const m: MultiEntityAggregateMetrics = {
    contactsTotal: v.contactsTotal as number,
    voted: v.voted as number,
    followUpClosed: v.followUpClosed as number,
    followUpRemaining: v.followUpRemaining as number,
    rideNeeded: v.rideNeeded as number,
    rideArranged: v.rideArranged as number,
    rideCompleted: v.rideCompleted as number,
  };
  if (
    m.voted + m.followUpClosed + m.followUpRemaining !== m.contactsTotal ||
    m.rideNeeded + m.rideArranged + m.rideCompleted > m.contactsTotal
  ) {
    return null;
  }
  return m;
}

function toWorkspaceAggregate(value: unknown): MultiEntityWorkspaceAggregate | null {
  if (!isWorkspace(value)) return null;
  const v = value as unknown as Record<string, unknown>;
  const status = v.status;
  if (
    status !== "reported" &&
    status !== "suppressed" &&
    status !== "ended" &&
    status !== "unavailable"
  ) {
    return null;
  }
  let metrics: MultiEntityAggregateMetrics | null = null;
  if (status === "reported") {
    metrics = toMetrics(v.metrics);
    if (!metrics) return null;
  } else if (v.metrics !== null) {
    // A withheld row carrying anything but null is refused outright.
    return null;
  }
  return {
    workspaceId: value.workspaceId,
    name: value.name,
    electionEndAt: value.electionEndAt,
    assignedAt: value.assignedAt,
    status,
    metrics,
  };
}

function toAggregates(value: unknown): MultiEntityAggregates | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.workspaces) || !v.totals || typeof v.totals !== "object")
    return null;
  const workspaces = v.workspaces.map(toWorkspaceAggregate);
  if (workspaces.some((w) => w === null)) return null;
  const rows = workspaces as MultiEntityWorkspaceAggregate[];
  const t = v.totals as Record<string, unknown>;
  const metrics = toMetrics(t.metrics);
  if (
    !metrics ||
    !isCount(t.workspaceCount) ||
    !isCount(t.reportedWorkspaceCount) ||
    !isCount(t.suppressedWorkspaceCount) ||
    !isCount(t.endedWorkspaceCount) ||
    !isCount(t.unavailableWorkspaceCount)
  ) {
    return null;
  }
  // The totals must describe exactly these rows - otherwise nothing renders.
  const countOf = (status: MultiEntityReportStatus) =>
    rows.filter((w) => w.status === status).length;
  if (
    t.workspaceCount !== rows.length ||
    t.reportedWorkspaceCount !== countOf("reported") ||
    t.suppressedWorkspaceCount !== countOf("suppressed") ||
    t.endedWorkspaceCount !== countOf("ended") ||
    t.unavailableWorkspaceCount !== countOf("unavailable")
  ) {
    return null;
  }
  return {
    workspaces: rows,
    totals: {
      workspaceCount: t.workspaceCount,
      reportedWorkspaceCount: t.reportedWorkspaceCount,
      suppressedWorkspaceCount: t.suppressedWorkspaceCount,
      endedWorkspaceCount: t.endedWorkspaceCount,
      unavailableWorkspaceCount: t.unavailableWorkspaceCount,
      metrics,
    },
  };
}

async function getJson(
  url: string,
  accessToken: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    let body: unknown = null;
    if (res.status === 200) {
      try {
        body = await res.json();
      } catch {
        return null;
      }
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

export async function fetchMultiEntityAggregates(
  accessToken: string,
): Promise<MultiEntityAggregatesResult> {
  const res = await getJson(MULTI_ENTITY_AGGREGATES_ENDPOINT, accessToken);
  if (!res) return { status: "error" };
  if (res.status === 200) {
    const aggregates = toAggregates(res.body);
    return aggregates ? { status: "ok", aggregates } : { status: "error" };
  }
  if (res.status === 401) return { status: "unauthorized" };
  return { status: "error" };
}

export async function fetchMultiEntityWorkspaceAggregate(
  accessToken: string,
  workspaceId: string,
): Promise<MultiEntityWorkspaceAggregateResult> {
  const url = `${MULTI_ENTITY_WORKSPACE_AGGREGATES_ENDPOINT}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const res = await getJson(url, accessToken);
  if (!res) return { status: "error" };
  if (res.status === 200) {
    const workspace = toWorkspaceAggregate(res.body);
    return workspace ? { status: "ok", workspace } : { status: "error" };
  }
  if (res.status === 401) return { status: "unauthorized" };
  if (res.status === 403 || res.status === 400) return { status: "not_assigned" };
  return { status: "error" };
}

export async function fetchMultiEntityOwnerSession(
  accessToken: string,
): Promise<MultiEntityOwnerSessionResult> {
  try {
    const res = await fetch(MULTI_ENTITY_SESSION_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const context = toContext(body);
      return context ? { status: "ok", context } : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
