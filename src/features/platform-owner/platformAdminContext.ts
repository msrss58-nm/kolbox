import { useOutletContext } from "react-router";
import type { useOwnerAccess } from "./useOwnerAccess";
import type { useWorkspaceModules } from "./useWorkspaceModules";

/** What the Platform console shell shares with its sections - one instance of
 * each read, so the Owners, Workspaces and Modules sections all show the same
 * server state and an entitlement edit refreshes every view of it. */
export interface PlatformAdminContext {
  access: ReturnType<typeof useOwnerAccess>;
  workspaceModules: ReturnType<typeof useWorkspaceModules>;
}

export function usePlatformAdmin(): PlatformAdminContext {
  return useOutletContext<PlatformAdminContext>();
}
