import { hasPermission } from "./hasPermission";
import { resolveEffectiveRole } from "./resolveEffectiveRole";
import type { DatabaseRole, EffectiveRole, Permission } from "./types";

export interface PermissionsResult {
  role: EffectiveRole | null;
  can: (permission: Permission) => boolean;
}

/**
 * The pure, dependency-free core of the permission engine's "current
 * session" view: takes the session's raw `DatabaseRole` (or `null` when
 * there is no session at all) and returns the resolved `EffectiveRole`
 * plus a permission check.
 *
 * No session → `role: null` and `can()` false for every permission - there
 * is no manager (or any other) fallback. `resolveEffectiveRole` is never
 * called with `null`; the "no session" case is handled entirely here, one
 * level above it.
 *
 * Deliberately has no import on React, zustand, or
 * `electionDaySession`/the `api` singleton (unlike `usePermissions.ts`,
 * which pulls those in transitively through `electionDaySession` →
 * `services/api` → the Supabase client) - so it can be exercised directly
 * by `scripts/smoke-permissions.ts` in plain Node, with no bundler
 * env-shimming required.
 */
export function computePermissions(sessionRole: DatabaseRole | null): PermissionsResult {
  const role = sessionRole !== null ? resolveEffectiveRole(sessionRole) : null;
  return {
    role,
    can: (permission: Permission) => role !== null && hasPermission(role, permission),
  };
}
