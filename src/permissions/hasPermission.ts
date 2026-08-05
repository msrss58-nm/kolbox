import type { Permission, RoleRecord } from "./types";

/** Pure permission check - no React, no logging, no side effects. Denial
 * reporting is a separate, explicit concern (`reportPermissionDenied`) so a
 * caller that only wants a boolean (e.g. deciding whether to render
 * something) never triggers a log line just by asking. */
export function hasPermission(role: RoleRecord, permission: Permission): boolean {
  return role.permissions.includes(permission);
}
