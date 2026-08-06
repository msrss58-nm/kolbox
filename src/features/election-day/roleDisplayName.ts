import type { RoleRecord } from "../../permissions/types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

/** Dynamic Roles & Permissions Phase 2: a `PermissionUser`'s displayed role
 * name always comes from the live catalog by `roleId` - never from the
 * legacy `role` text (`null` for a dynamic-role user), so the roster table
 * reads correctly for both legacy and dynamic accounts alike. */
export function roleDisplayName(roleId: string, roles: readonly RoleRecord[]): string {
  return (
    roles.find((r) => r.id === roleId)?.name ??
    ELECTION_DAY_TEXT.permissionsManager.unknownRole
  );
}
