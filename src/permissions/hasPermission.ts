import { PERMISSIONS_BY_ROLE } from "./permissionsMap";
import type { EffectiveRole, Permission } from "./types";

/** Pure permission check - no React, no logging, no side effects. Denial
 * reporting is a separate, explicit concern (`reportPermissionDenied`) so a
 * caller that only wants a boolean (e.g. deciding whether to render
 * something) never triggers a log line just by asking. */
export function hasPermission(role: EffectiveRole, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].has(permission);
}
