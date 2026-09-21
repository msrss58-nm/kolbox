import { ALL_PERMISSIONS } from "./permissionsMap";
import type { RoleRecord } from "./types";

/**
 * The Election Owner's identity inside the permission engine.
 *
 * The Owner is NOT a PermissionUser and never appears in the roster - that
 * invariant is unchanged. But when the Owner drives a module surface
 * (Election Day / Budget) the existing screens still ask the engine "may I?",
 * so the engine needs one recognised answer for them.
 *
 * The Owner is unconditionally superior to every worker role inside their own
 * workspace (they create and delete those roles), so the honest answer is
 * "everything, workspace-wide". This grants nothing on its own: it is a
 * PRESENTATION decision only. Every Owner request is independently
 * re-authorized server-side by `owner-actions.ts`, which re-resolves the
 * Owner's workspace live and gates each module op on the workspace
 * entitlement - exactly as it already did for the Owner admin screens.
 *
 * Deliberately a distinct sentinel id that can never collide with a real
 * `election_day_roles.id` (a uuid), so a catalog row can never impersonate it
 * and this record can never be edited or deleted from the role editor.
 */
export const OWNER_SESSION_ROLE_ID = "kolbox:election-owner";

export const OWNER_SESSION_ROLE: RoleRecord = {
  id: OWNER_SESSION_ROLE_ID,
  name: "בעל המערכת",
  description: "",
  permissions: ALL_PERMISSIONS,
  scopeType: "all",
  scopeValue: null,
  isManager: true,
};

export function isOwnerSessionRoleId(roleId: string | null): boolean {
  return roleId === OWNER_SESSION_ROLE_ID;
}
