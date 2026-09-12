import { useCallback, useEffect, useState } from "react";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { platformWorkspaceModulesError } from "./platform-owner.constants";
import {
  fetchWorkspaceModules,
  setWorkspaceModules,
  type WorkspaceModulesState,
} from "./platformOwnerClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";

/**
 * Stage 9 state for workspace module entitlements, and the catalog the
 * approval form offers.
 *
 * Same two rules as useOwnerAccess: no optimistic writes (every save awaits
 * the server and is followed by an authoritative refetch), and a 401 is never
 * rendered as a message - it re-resolves the Platform Owner session and lets
 * PlatformOwnerAuthGuard decide.
 */
export function useWorkspaceModules() {
  const [data, setData] = useState<WorkspaceModulesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(
    null,
  );

  const token = useCallback(async () => {
    const { data: s } = await platformOwnerAuthClient.auth.getSession();
    return s.session?.access_token ?? null;
  }, []);

  const onUnauthorized = useCallback(() => {
    void usePlatformOwnerSession.getState().refreshStatus();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setReadError(null);
    const t = await token();
    if (!t) {
      setLoading(false);
      onUnauthorized();
      return;
    }
    const res = await fetchWorkspaceModules(t);
    if (res.status === "unauthorized") {
      setLoading(false);
      onUnauthorized();
      return;
    }
    if (res.status === "error") {
      setReadError(platformWorkspaceModulesError(res.code));
      setLoading(false);
      return;
    }
    setData(res.data);
    setLoading(false);
  }, [token, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Resolves true only when the server confirmed the new set. */
  const save = useCallback(
    async (workspaceId: string, modules: string[]): Promise<boolean> => {
      if (savingId) return false; // double-submit guard
      setSaveError(null);
      setSavingId(workspaceId);
      let ok = false;
      try {
        const t = await token();
        if (!t) {
          onUnauthorized();
          return false;
        }
        const res = await setWorkspaceModules(t, workspaceId, modules);
        if (res.status === "unauthorized") {
          onUnauthorized();
          return false;
        }
        if (res.status === "error") {
          setSaveError({
            id: workspaceId,
            message: platformWorkspaceModulesError(res.code),
          });
        } else {
          ok = true;
        }
      } finally {
        setSavingId(null);
      }
      await load();
      return ok;
    },
    [savingId, token, onUnauthorized, load],
  );

  return {
    catalog: data?.catalog ?? [],
    workspaces: data?.workspaces ?? [],
    loading,
    readError,
    reload: load,
    savingId,
    errorFor: (id: string) => (saveError?.id === id ? saveError.message : null),
    save,
  };
}
