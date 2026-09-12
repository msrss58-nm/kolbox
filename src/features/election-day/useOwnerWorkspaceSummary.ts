import { useCallback } from "react";
import { useAsyncData } from "../../hooks/useAsyncData";
import {
  fetchOwnerProvisioningState,
  fetchOwnerWorkspaceModules,
  type OwnerWorkspaceModule,
} from "./electionDayOwnerClient";
import { useOwnerSession } from "./ownerSession";

export interface OwnerWorkspaceSummary {
  workspaceName: string | null;
  loginCode: string | null;
  modules: OwnerWorkspaceModule[];
}

/**
 * Platform Stage 9: what the Election Owner administration page shows about
 * the workspace itself - its name, its login code (so the Owner can hand it
 * to the users they create, at any time, not only right after provisioning)
 * and its module entitlements. Display only: every privileged operation
 * re-resolves the workspace and its entitlements server-side.
 */
export function useOwnerWorkspaceSummary() {
  const owner = useOwnerSession((s) => s.owner);
  const getAccessToken = useOwnerSession((s) => s.getAccessToken);

  const fetchSummary = useCallback(async (): Promise<OwnerWorkspaceSummary | null> => {
    if (!owner) return null;
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error("unauthorized");
    const [state, modules] = await Promise.all([
      fetchOwnerProvisioningState(accessToken),
      fetchOwnerWorkspaceModules(accessToken),
    ]);
    if (state.status !== "ok" || modules.status !== "ok") throw new Error("error");
    return {
      workspaceName: state.state.workspaceName,
      loginCode: state.state.loginCode,
      modules: modules.data,
    };
  }, [owner, getAccessToken]);

  const { data, error, reload } = useAsyncData(fetchSummary);
  return { summary: data, error, reload };
}
