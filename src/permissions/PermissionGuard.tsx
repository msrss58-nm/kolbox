import type { ReactNode } from "react";
import { usePermissions } from "./usePermissions";
import type { Permission } from "./types";

/**
 * Shows `children` when the current session holds `permission`, otherwise
 * `fallback` (default: nothing). UI-only - never the sole enforcement for
 * a mutation; Stage 3 gates the actual `useElectionDay` API calls too, so a
 * hidden button here isn't the only thing standing between a role and an
 * action it shouldn't be able to take.
 *
 * Not yet used anywhere (Stage 1 - see task-plan.md).
 */
export function PermissionGuard({
  permission,
  children,
  fallback = null,
}: {
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can } = usePermissions();
  return can(permission) ? <>{children}</> : <>{fallback}</>;
}
