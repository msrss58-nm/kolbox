import type {
  AllocationAssignment,
  ApplyInitialAllocationResult,
  CoordinatorAction,
  EndCoordinatorActivityMode,
  EndCoordinatorActivityResult,
  RebalanceAssignmentsResult,
} from "../../services/api";
import { ElectionDayReauthError } from "../../services/api";
import {
  mapCoordinatorAllocationRpcErrorMessage,
  toAllocationAssignmentPayload,
  toCoordinatorActionPayload,
} from "../../services/api/coordinatorAllocationMapping";
import type { Coordinator } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

/**
 * Coordinator/Allocation V3 Frontend Cutover: pure fetch wrappers around the
 * trusted, session-derived Coordinator/Allocation v3 flow
 * (`api/election-day/coordinator-allocation.ts`, `api/election-day/
 * reauth.ts` with `action:"coordinator_allocation"`) - mirrors
 * `electionDayTrustedUsersClient.ts`'s pattern (no React/Zustand
 * dependency), but deliberately THROWS on failure instead of returning a
 * discriminated result union - `useCoordinatorAllocation.ts`'s existing 4
 * mutation closures and `useAsyncAction`'s toast handling are already built
 * around a throw-based contract (`ElectionDayReauthError` for
 * UNAUTHORIZED/FORBIDDEN, a plain `Error` with an already-Hebrew `.message`
 * for everything else) - matching `supabaseElectionDayApi.ts`'s
 * `callReauthedRpc` contract exactly keeps the cutover in
 * `useCoordinatorAllocation.ts` to a pure call-site swap.
 *
 * Response mapping deliberately duplicates a small `toCoordinator`-shaped
 * function locally rather than importing one from `supabaseElectionDayApi.ts`
 * (which is out of scope to modify and, via `../supabase/client`,
 * transitively depends on `import.meta.env` - see
 * `coordinatorAllocationMapping.ts`'s own header comment for why a
 * dependency-free module can't import from that file). `workspace_id`
 * (present on the v3 GET/manage row shape but not on the legacy `_v2` one)
 * is deliberately read and discarded, never added to the `Coordinator`
 * domain type - approved response contract.
 */

const COORDINATOR_ALLOCATION_ENDPOINT = "/api/election-day/coordinator-allocation";
const REAUTH_ENDPOINT = "/api/election-day/reauth";
const REAUTH_ACTION = "coordinator_allocation";

const errors = ELECTION_DAY_TEXT.reauth.trustedUserErrors;

interface RawCoordinatorRow {
  id: string;
  display_name: string;
  status: string;
  linked_assignment_name: string | null;
  created_at: string;
  ended_at: string | null;
  phone: string | null;
  // workspace_id also present on the raw row - intentionally not read.
}

function isRawCoordinatorRow(value: unknown): value is RawCoordinatorRow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.display_name === "string" &&
    typeof v.status === "string" &&
    (v.linked_assignment_name === null || typeof v.linked_assignment_name === "string") &&
    typeof v.created_at === "string" &&
    (v.ended_at === null || typeof v.ended_at === "string") &&
    (v.phone === null || typeof v.phone === "string")
  );
}

/** Same coercion/fallback reasoning as `supabaseElectionDayApi.ts`'s own
 * `toCoordinator`: `status` is a plain `text` column, not a Postgres enum -
 * an unrecognized value falls back to `"active"`, the safer direction. */
function toCoordinatorFromRow(row: RawCoordinatorRow): Coordinator {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status === "ended" ? "ended" : "active",
    linkedAssignmentName: row.linked_assignment_name,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    phone: row.phone,
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorCodeFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as Record<string, unknown>).error;
  return typeof code === "string" ? code : undefined;
}

/** Mints a reusable, feature-scoped `coordinator_allocation` proof against
 * the current HttpOnly session - throws a plain `Error` (never
 * `ElectionDayReauthError`) on failure, mirroring `api.reauth()`'s existing
 * contract exactly so `useCoordinatorAllocationReauth.ts`'s `onConfirm` can
 * be structurally identical to the legacy `useElectionDayReauth.ts`'s own. */
export async function reauthForCoordinatorAllocation(password: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(REAUTH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action: REAUTH_ACTION }),
    });
  } catch {
    throw new Error(errors.generic);
  }
  if (res.status === 200) {
    const body = await readJson(res);
    const proof =
      body &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).reauthProof === "string"
        ? ((body as Record<string, unknown>).reauthProof as string)
        : null;
    if (!proof) throw new Error(errors.generic);
    return proof;
  }
  if (res.status === 401) {
    throw new Error(mapCoordinatorAllocationRpcErrorMessage("UNAUTHORIZED"));
  }
  if (res.status === 429) {
    throw new Error(errors.rateLimited);
  }
  // api/election-day/reauth.ts's only 403 case is {error:"FORBIDDEN_ORIGIN"}
  // (a forged/missing Origin header) - it never checks permission at
  // mint-time, so a 403 here can never mean "you lack this permission".
  // Falls through to the same generic, controlled error as any other
  // unexpected status - never represented as a role/permission denial.
  throw new Error(errors.generic);
}

/** Workspace-scoped coordinator roster read - no reauth proof needed (a
 * read has no step-up requirement, same convention as every other trusted
 * v3 read in this codebase). Throws a plain `Error` on any non-200 (401
 * here means "no valid session" - a different failure class from a
 * rejected coordinator_allocation proof - `useAsyncData`'s existing generic
 * error handling is sufficient, no typed error needed). */
export async function fetchCoordinatorsTrusted(): Promise<Coordinator[]> {
  let res: Response;
  try {
    res = await fetch(COORDINATOR_ALLOCATION_ENDPOINT, { method: "GET" });
  } catch {
    throw new Error(errors.generic);
  }
  if (res.status !== 200) {
    throw new Error(errors.generic);
  }
  const body = await readJson(res);
  if (!Array.isArray(body) || !body.every(isRawCoordinatorRow)) {
    throw new Error(errors.generic);
  }
  return body.map(toCoordinatorFromRow);
}

/** Shared POST helper for all 4 mutations - identical error-translation
 * contract to `supabaseElectionDayApi.ts`'s `callReauthedRpc`: 401 and a
 * body `error` of exactly `"FORBIDDEN"` become a typed
 * `ElectionDayReauthError`, every other error code goes through
 * `mapCoordinatorAllocationRpcErrorMessage` (reused verbatim - it matches
 * via `.includes(code)`, and the v3 JSON `error` field already IS the bare
 * code string), and a malformed/unexpected response fails closed with a
 * generic error - never a raw Postgres/server internal.
 *
 * `coordinator-allocation.ts`'s POST handler can return HTTP 403 for TWO
 * unrelated reasons that must never be conflated: a real
 * `electionDay.manageCoordinatorAllocation` permission denial
 * (`{error:"FORBIDDEN"}`, raised by the RPC itself) and a forged/missing
 * Origin header rejected before the RPC is ever called
 * (`{error:"FORBIDDEN_ORIGIN"}`, same shape `api/election-day/reauth.ts`'s
 * own Origin check uses). Only the former is a role/permission decision -
 * mapping on HTTP status alone would misrepresent an origin/security
 * rejection as "you lack permission for this action", a materially
 * different (and wrong) user-facing and programmatic signal. An unrecognized
 * 403 code fails closed the same as a 403 with no code at all - never
 * defaults to FORBIDDEN. */
async function postCoordinatorAllocation(
  op: string,
  extra: Record<string, unknown>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(COORDINATOR_ALLOCATION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...extra }),
    });
  } catch {
    throw new Error(errors.generic);
  }

  if (res.status === 200) {
    return await readJson(res);
  }

  const body = await readJson(res);
  const code = errorCodeFromBody(body);

  if (res.status === 401) {
    throw new ElectionDayReauthError(
      "UNAUTHORIZED",
      mapCoordinatorAllocationRpcErrorMessage("UNAUTHORIZED"),
    );
  }
  if (res.status === 403) {
    if (code === "FORBIDDEN") {
      throw new ElectionDayReauthError(
        "FORBIDDEN",
        mapCoordinatorAllocationRpcErrorMessage("FORBIDDEN"),
      );
    }
    // FORBIDDEN_ORIGIN or any other/unrecognized 403 code: a controlled
    // generic failure, never a role/permission-denial signal.
    throw new Error(errors.generic);
  }
  if (code) {
    throw new Error(mapCoordinatorAllocationRpcErrorMessage(code));
  }
  throw new Error(errors.generic);
}

export async function manageCoordinatorsTrusted(
  proof: string,
  actions: CoordinatorAction[],
): Promise<Coordinator[]> {
  const data = await postCoordinatorAllocation("manage_coordinators", {
    reauthProof: proof,
    actions: actions.map(toCoordinatorActionPayload),
  });
  if (!Array.isArray(data) || !data.every(isRawCoordinatorRow)) {
    throw new Error(errors.generic);
  }
  return data.map(toCoordinatorFromRow);
}

function isApplyInitialAllocationRow(value: unknown): value is {
  operation_id: string;
  allocated_count: number;
  remaining_unassigned_count: number;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.operation_id === "string" &&
    typeof v.allocated_count === "number" &&
    typeof v.remaining_unassigned_count === "number"
  );
}

export async function applyInitialAllocationTrusted(
  proof: string,
  assignments: AllocationAssignment[],
): Promise<ApplyInitialAllocationResult> {
  const data = await postCoordinatorAllocation("apply_initial_allocation", {
    reauthProof: proof,
    assignments: assignments.map(toAllocationAssignmentPayload),
  });
  // election_day_apply_initial_allocation_v3 is declared RETURNS TABLE(...) -
  // PostgREST/supabase-js always returns a TABLE-returning function's result
  // as an array (one element here), never a bare object, even via this
  // Node-side RPC call - confirmed against the real local endpoint, not
  // assumed from the SQL declaration alone.
  const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
  if (!isApplyInitialAllocationRow(row)) {
    throw new Error(errors.generic);
  }
  return {
    operationId: row.operation_id,
    allocatedCount: row.allocated_count,
    remainingUnassignedCount: row.remaining_unassigned_count,
  };
}

function isRebalanceRow(
  value: unknown,
): value is { operation_id: string; transferred_count: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.operation_id === "string" && typeof v.transferred_count === "number";
}

export async function rebalanceAssignmentsTrusted(
  proof: string,
  sources: AllocationAssignment[],
  destinations: AllocationAssignment[],
): Promise<RebalanceAssignmentsResult> {
  const data = await postCoordinatorAllocation("rebalance_assignments", {
    reauthProof: proof,
    sources: sources.map(toAllocationAssignmentPayload),
    destinations: destinations.map(toAllocationAssignmentPayload),
  });
  // Same RETURNS TABLE(...) array-wrapping as applyInitialAllocationTrusted
  // above - see that function's comment.
  const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
  if (!isRebalanceRow(row)) {
    throw new Error(errors.generic);
  }
  return { operationId: row.operation_id, transferredCount: row.transferred_count };
}

function isEndActivityRow(value: unknown): value is {
  operation_id: string;
  transferred_count: number;
  ended_coordinator_id: string;
  ended_coordinator_display_name: string;
} {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.operation_id === "string" &&
    typeof v.transferred_count === "number" &&
    typeof v.ended_coordinator_id === "string" &&
    typeof v.ended_coordinator_display_name === "string"
  );
}

export async function endCoordinatorActivityTrusted(
  proof: string,
  coordinatorId: string,
  mode: EndCoordinatorActivityMode,
  targetCoordinatorId: string | null,
): Promise<EndCoordinatorActivityResult> {
  const data = await postCoordinatorAllocation("end_coordinator_activity", {
    reauthProof: proof,
    coordinatorId,
    mode,
    targetCoordinatorId: mode === "transfer" ? targetCoordinatorId : null,
  });
  // Same RETURNS TABLE(...) array-wrapping as applyInitialAllocationTrusted
  // above - see that function's comment.
  const row = Array.isArray(data) && data.length === 1 ? data[0] : undefined;
  if (!isEndActivityRow(row)) {
    throw new Error(errors.generic);
  }
  return {
    operationId: row.operation_id,
    transferredCount: row.transferred_count,
    endedCoordinatorId: row.ended_coordinator_id,
    endedCoordinatorDisplayName: row.ended_coordinator_display_name,
  };
}
