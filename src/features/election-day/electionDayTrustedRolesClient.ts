/**
 * Phase 3C Roles: pure fetch wrapper around the trusted, session-derived
 * role-catalog READ (`api/election-day/roles.ts`'s GET handler,
 * `election_day_list_roles_v3`). Wired directly into both live callers of
 * the role catalog - `useRoleManagement.ts`'s `fetchRoles` (the "תפקידים"
 * management screen) and `roleCatalogStore.ts` (the live permission
 * engine's own catalog resolution) - mirroring
 * `electionDayTrustedUsersClient.ts`'s `fetchTrustedPermissionUsersRoster`
 * pattern exactly. No React/Zustand dependency.
 *
 * Row validation is deliberately thin here (just "is this an array of
 * objects") - the REAL, security-relevant validation (permissions/scope_type
 * fail-closed handling) already lives in `normalizeRoleRecord`
 * (`src/permissions/roleRecordMapper.ts`), which both live callers already
 * run every row through, unchanged. This module only changes the transport
 * (a trusted, session-scoped Vercel endpoint instead of a direct anon-key
 * RPC call) - never the row contract, which stays byte-identical to the
 * legacy `election_day_list_roles()` RPC's own output shape
 * (id/name/description/permissions/scope_type/scope_value).
 *
 * Does NOT replace `ApiClient.listElectionDayRoles()` (the legacy, unscoped
 * catalog read) or `election_day_list_roles()` itself - both remain
 * present, untouched, and reachable (matching `ApiClient.listPermissionUsers()`'s
 * own precedent) until a separate, later, explicit retirement decision.
 */
import type { RawRoleRow } from "../../permissions/roleRecordMapper";

const ROLES_ENDPOINT = "/api/election-day/roles";

export type TrustedRolesResult =
  | { status: "ok"; rows: RawRoleRow[] }
  | { status: "unauthorized" }
  | { status: "error" };

function isRawRoleRowShape(value: unknown): value is RawRoleRow {
  return typeof value === "object" && value !== null;
}

/** Session-derived, workspace-scoped role-catalog read - no reauth proof
 * needed (a read carries no step-up requirement, matching the legacy
 * `election_day_list_roles()`'s own always-unauthenticated-step-up
 * behavior and `election_day_list_permission_users_v3`'s established
 * convention). */
export async function fetchTrustedRoles(): Promise<TrustedRolesResult> {
  try {
    const res = await fetch(ROLES_ENDPOINT, { method: "GET" });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return Array.isArray(body) && body.every(isRawRoleRowShape)
        ? { status: "ok", rows: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
