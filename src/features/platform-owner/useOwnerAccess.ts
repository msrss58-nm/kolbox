import { useCallback, useEffect, useState } from "react";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import { platformOwnerAccessError } from "./platform-owner.constants";
import {
  fetchOwnerAccess,
  reissueOwnerAccess,
  type OwnerAccessApproval,
} from "./platformOwnerClient";

/** A re-issued one-time link, held in COMPONENT MEMORY ONLY for as long as its
 * panel is shown - never persisted, cached, logged or put in the URL. */
export interface IssuedOwnerLink {
  pendingId: string;
  name: string;
  link: string | null;
  renewed: boolean;
}

/**
 * Stage 8B state for the Election Owner approvals list.
 *
 * Same two rules as useMultiEntityManagement: no optimistic writes (every
 * re-issue awaits the server and is followed by an authoritative refetch), and
 * a 401 is never rendered as a message - it re-resolves the Platform Owner
 * session and lets PlatformOwnerAuthGuard decide.
 */
export function useOwnerAccess() {
  const [approvals, setApprovals] = useState<OwnerAccessApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [issued, setIssued] = useState<IssuedOwnerLink | null>(null);

  const token = useCallback(async () => {
    const { data } = await platformOwnerAuthClient.auth.getSession();
    return data.session?.access_token ?? null;
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
    const res = await fetchOwnerAccess(t);
    if (res.status === "unauthorized") {
      setLoading(false);
      onUnauthorized();
      return;
    }
    if (res.status === "error") {
      setReadError(platformOwnerAccessError(res.code));
      setLoading(false);
      return;
    }
    setApprovals(res.data);
    setLoading(false);
  }, [token, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const reissue = useCallback(
    async (approval: OwnerAccessApproval) => {
      if (busyId) return; // double-submit guard
      setActionError(null);
      setIssued(null);
      setBusyId(approval.pendingId);
      try {
        const t = await token();
        if (!t) {
          onUnauthorized();
          return;
        }
        const res = await reissueOwnerAccess(t, approval.pendingId);
        if (res.status === "unauthorized") {
          onUnauthorized();
          return;
        }
        if (res.status === "error") {
          setActionError({
            id: approval.pendingId,
            message: platformOwnerAccessError(res.code),
          });
        } else {
          setIssued({
            pendingId: approval.pendingId,
            name: approval.name,
            link: res.data.activationLink,
            renewed: res.data.renewed,
          });
        }
      } finally {
        setBusyId(null);
      }
      // Authoritative refetch after success AND after a refusal: a refusal
      // usually means the row's state moved on (consumed, renewed elsewhere).
      await load();
    },
    [busyId, token, onUnauthorized, load],
  );

  return {
    approvals,
    loading,
    readError,
    reload: load,
    busyId,
    anyBusy: busyId !== null,
    errorFor: (id: string) => (actionError?.id === id ? actionError.message : null),
    issued,
    dismissIssued: () => setIssued(null),
    reissue,
  };
}
