import type { DatabaseRole, RoleRecord } from "./types";

/**
 * The one and only place that turns a session's raw `DatabaseRole` text
 * into the `RoleRecord` that actually governs its permissions/scope -
 * looked up from the live `election_day_roles` catalog (Dynamic Roles &
 * Permissions, Phase 1) by `legacyRoleKey`, never by name and never by a
 * hardcoded id. Returns `null` if no row matches - a session whose role
 * text has no corresponding catalog row (catalog still loading, a load
 * failure, or - should not happen given the Phase 0 FK/backfill guarantee -
 * a legacy key with no seed row) resolves to no role at all, which
 * `computePermissions`/`resolveVisibleContacts` then treat as "deny
 * everything" / "show nothing", never as an implicit fallback to any role.
 */
export function resolveSessionRole(
  role: DatabaseRole,
  roles: readonly RoleRecord[],
): RoleRecord | null {
  return roles.find((r) => r.legacyRoleKey === role) ?? null;
}
