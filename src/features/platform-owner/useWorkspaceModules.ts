import { useCallback, useEffect, useState } from "react";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  platformModuleAvailabilityError,
  platformWorkspaceModulesError,
} from "./platform-owner.constants";
import {
  fetchWorkspaceModules,
  setModuleAvailability,
  setWorkspaceModules,
  type WorkspaceModulesState,
} from "./platformOwnerClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";

/**
 * Stage 9 state for workspace module entitlements, and the catalog the
 * approval form offers. Gate 4 adds the catalog's GLOBAL availability switch.
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
  const [availabilityKey, setAvailabilityKey] = useState<string | null>(null);
  const [availabilityError, setAvailabilityError] = useState<{
    key: string;
    message: string;
  } | null>(null);

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

  /** Gate 4: switches a module's GLOBAL availability to exactly `available`.
   * Resolves true only when the server confirmed it (an identical retry is a
   * confirmed no-op); the catalog is always refetched afterwards. */
  const setAvailability = useCallback(
    async (moduleKey: string, available: boolean): Promise<boolean> => {
      if (availabilityKey) return false; // double-submit guard
      setAvailabilityError(null);
      setAvailabilityKey(moduleKey);
      let ok = false;
      try {
        const t = await token();
        if (!t) {
          onUnauthorized();
          return false;
        }
        const res = await setModuleAvailability(t, moduleKey, available);
        if (res.status === "unauthorized") {
          onUnauthorized();
          return false;
        }
        if (res.status === "error") {
          setAvailabilityError({
            key: moduleKey,
            message: platformModuleAvailabilityError(res.code),
          });
        } else {
          ok = true;
        }
      } finally {
        setAvailabilityKey(null);
      }
      await load();
      return ok;
    },
    [availabilityKey, token, onUnauthorized, load],
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
    availabilityKey,
    availabilityErrorFor: (key: string) =>
      availabilityError?.key === key ? availabilityError.message : null,
    setAvailability,
  };
}
