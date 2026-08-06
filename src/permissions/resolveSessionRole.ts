import type { RoleRecord } from "./types";

/**
 * The one and only place that turns a session's `roleId` into the
 * `RoleRecord` that actually governs its permissions/scope - looked up from
 * the live `election_day_roles` catalog by `id`, never by name and never by
 * legacy role text. Returns `null` if no row matches - a session whose
 * `roleId` has no corresponding catalog row (catalog still loading, a load
 * failure, or - should not happen given the Phase 0 FK/NOT NULL guarantee -
 * a stale/deleted role id) resolves to no role at all, which
 * `computePermissions`/`resolveVisibleContacts` then treat as "deny
 * everything" / "show nothing", never as an implicit fallback to any role.
 *
 * Dynamic Roles & Permissions Phase 2: every `PermissionUser` row (legacy or
 * dynamic) has always had a NOT NULL `role_id` since Phase 0 - a
 * dynamic-role user's legacy role text is always `null`, so matching by
 * legacy text (Phase 1's original approach) would either fail to resolve
 * such a session or, worse, mis-resolve it against the first
 * coincidentally-null-legacy-key row in the catalog. Matching by `roleId`
 * is a strictly more correct single resolution path for every account,
 * legacy or dynamic alike.
 */
export function resolveSessionRole(
  roleId: string,
  roles: readonly RoleRecord[],
): RoleRecord | null {
  return roles.find((r) => r.id === roleId) ?? null;
}
