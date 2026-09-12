import { useOutletContext } from "react-router";
import type { OwnerRoleManagementHook } from "./useOwnerRoleManagement";
import type { useOwnerUserManagement } from "./useOwnerUserManagement";
import type { useOwnerWorkspaceSummary } from "./useOwnerWorkspaceSummary";

/** What the Owner administration shell shares with its sections. Each hook is
 * called ONCE, in the shell, so switching sections never refetches and a
 * section never shows data another section has already moved past. */
export interface OwnerAdminContext {
  roleManagement: OwnerRoleManagementHook;
  userManagement: ReturnType<typeof useOwnerUserManagement>;
  workspace: ReturnType<typeof useOwnerWorkspaceSummary>;
  ownerEmail: string | null;
}

export function useOwnerAdmin(): OwnerAdminContext {
  return useOutletContext<OwnerAdminContext>();
}
