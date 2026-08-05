import { hasPermission } from "./hasPermission";
import type { RoleCatalogStatus } from "./roleCatalogController";
import { resolveSessionRole } from "./resolveSessionRole";
import type { DatabaseRole, Permission, RoleRecord } from "./types";

export interface PermissionsResult {
  /** The resolved role, or `null` in every case other than "catalog loaded
   * AND the session's role text matched a row in it" - loading, error, no
   * session, and an unmatched legacy role text all collapse to `null` here.
   * Never a fallback to any particular role. */
  role: RoleRecord | null;
  catalogStatus: RoleCatalogStatus;
  can: (permission: Permission) => boolean;
}

/**
 * The pure, dependency-free core of the permission engine's "current
 * session" view: takes the session's raw `DatabaseRole` (or `null` when
 * there is no session at all), the role catalog's fetch status, and the
 * catalog itself, and returns the resolved `RoleRecord` plus a permission
 * check.
 *
 * Fail-closed by construction: `role` only ever resolves to a non-null
 * value when `catalogStatus === "loaded"` AND `sessionRole` matches a row
 * in `roles` - `"idle"`/`"loading"`/`"error"`, no session, and an
 * unrecognized `sessionRole` all produce `role: null` and therefore
 * `can()` false for every permission. There is no manager (or any other)
 * fallback in any of these cases.
 *
 * Deliberately has no import on React, zustand, or
 * `electionDaySession`/the `api` singleton/Supabase (unlike
 * `usePermissions.ts`, which pulls those in transitively) - so it can be
 * exercised directly by `scripts/smoke-permissions.ts` in plain Node, with
 * no bundler env-shimming required.
 */
export function computePermissions(
  sessionRole: DatabaseRole | null,
  catalogStatus: RoleCatalogStatus,
  roles: readonly RoleRecord[],
): PermissionsResult {
  const role =
    sessionRole !== null && catalogStatus === "loaded"
      ? resolveSessionRole(sessionRole, roles)
      : null;
  return {
    role,
    catalogStatus,
    can: (permission: Permission) => role !== null && hasPermission(role, permission),
  };
}
