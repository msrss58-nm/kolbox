import { useCallback, useEffect, useState } from "react";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import {
  PLATFORM_OWNER_TEXT,
  platformHeldByLabel,
  platformMultiEntityError,
} from "./platform-owner.constants";
import {
  assignWorkspace,
  fetchMultiEntityState,
  provisionMultiEntityOwner,
  purgeProvisioningOrphan,
  purgeReplacedAuthUser,
  unassignWorkspace,
  type MultiEntityResult,
  type MultiEntityState,
} from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.multiEntity;

/** Stable key naming the in-flight action, so a busy row never disables the
 * whole page and two rows can never be confused for one another. */
export const BUSY = {
  provision: "provision",
  workspace: (id: string) => `ws:${id}`,
  replacementPurge: (id: string) => `rp:${id}`,
  orphanPurge: (id: string) => `op:${id}`,
} as const;

/** A transient, non-error notice attached to one action key (a completed
 * purge, or a 200-with-warning that must stay visible). */
export interface ActionNotice {
  key: string;
  message: string;
  tone: "success" | "warning";
}

/** The one-time password-setting link, held in COMPONENT MEMORY ONLY for as
 * long as its panel is on screen. Never localStorage, sessionStorage, a
 * store, the URL, or a log - it is a credential-grade value. */
export interface PasswordLinkState {
  link: string | null;
  replaced: boolean;
}

/**
 * Stage 4B state/orchestration layer for the Multi-Entity management page.
 *
 * Two rules shape everything here:
 *
 *  1. NO OPTIMISTIC WRITES. Every mutation awaits the server and is followed
 *     by an authoritative refetch of `multi_entity_state`. Assignment and
 *     purge are idempotent server-side, `is_active` is clock-derived, and an
 *     unintended unassign silently removes visibility - so a locally-guessed
 *     state could quietly disagree with the database. The refetch also
 *     reconciles anything a second session changed meanwhile.
 *
 *  2. THE CLEANUP QUEUES COME FROM THE SERVER, NEVER FROM A RESPONSE. The
 *     provision response does carry `previousAuthUserId`, but reading it here
 *     would recreate the exact bug Stage 4B exists to fix: state that lives
 *     only in one HTTP response and vanishes on reload. Both queues are read
 *     from the durable audit-derived arrays.
 *
 * A 401 is never rendered as a message. It re-resolves the Platform Owner
 * session and lets `PlatformOwnerAuthGuard` decide what happens next, which
 * keeps one decider for "may this console render at all".
 */
export function useMultiEntityManagement() {
  const [state, setState] = useState<MultiEntityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(
    null,
  );
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const [passwordLink, setPasswordLink] = useState<PasswordLinkState | null>(null);

  /** Reads the current access token. Returns null when there is no session at
   * all, which is treated exactly like a 401. */
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
    const res = await fetchMultiEntityState(t);
    if (res.status === "unauthorized") {
      setLoading(false);
      onUnauthorized();
      return;
    }
    if (res.status === "error") {
      setReadError(platformMultiEntityError(res.code));
      setLoading(false);
      return;
    }
    setState(res.data);
    setLoading(false);
  }, [token, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Turns a failed result into the Hebrew message shown inline, appending the
   * `heldBy` detail and the unconfirmed-cleanup warning when the server sent
   * them. Never surfaces raw server text - only mapped, fixed codes. */
  const messageFor = useCallback((res: MultiEntityResult<unknown>): string => {
    if (res.status !== "error") return text.errors.SERVER_ERROR;
    let msg = platformMultiEntityError(res.code);
    const held = platformHeldByLabel(res.heldBy);
    if (held) msg = `${msg} (${held})`;
    if (res.orphanedAuthUserId) {
      msg = `${msg} ${text.orphanWarning(res.orphanedAuthUserId)}`;
    }
    return msg;
  }, []);

  /**
   * One guarded path for every mutation: refuse a second submit while one is
   * in flight, clear stale feedback, await the server, then refetch. The
   * `false` return means "nothing changed" and is what the caller uses to keep
   * a modal open on failure.
   */
  const run = useCallback(
    async <T>(
      key: string,
      call: (t: string) => Promise<MultiEntityResult<T>>,
      onOk?: (data: T) => ActionNotice | null,
    ): Promise<boolean> => {
      if (busyKey) return false; // double-submit guard
      setActionError(null);
      setNotice(null);
      setBusyKey(key);
      try {
        const t = await token();
        if (!t) {
          onUnauthorized();
          return false;
        }
        const res = await call(t);
        if (res.status === "unauthorized") {
          onUnauthorized();
          return false;
        }
        if (res.status === "error") {
          setActionError({ key, message: messageFor(res) });
          return false;
        }
        const n = onOk?.(res.data) ?? null;
        if (n) setNotice(n);
        return true;
      } finally {
        setBusyKey(null);
      }
    },
    [busyKey, token, onUnauthorized, messageFor],
  );

  const provision = useCallback(
    async (input: { name: string; email: string; phone?: string }) => {
      const ok = await run(
        BUSY.provision,
        (t) => provisionMultiEntityOwner(t, input),
        (data) => {
          // Held in memory only, for exactly as long as the panel is shown.
          setPasswordLink({ link: data.passwordLink, replaced: data.replaced });
          return null;
        },
      );
      // Stage 8B: the authoritative refetch still always follows a success,
      // but it no longer holds the caller back - the provision form closes the
      // moment the server has succeeded instead of staying open (with a live
      // submit button) for the duration of the refetch.
      if (ok) void load();
      return ok;
    },
    [run, load],
  );

  const assign = useCallback(
    async (workspaceId: string) => {
      const ok = await run(BUSY.workspace(workspaceId), (t) =>
        assignWorkspace(t, workspaceId),
      );
      if (ok) await load();
      return ok;
    },
    [run, load],
  );

  const unassign = useCallback(
    async (workspaceId: string) => {
      const ok = await run(BUSY.workspace(workspaceId), (t) =>
        unassignWorkspace(t, workspaceId),
      );
      if (ok) await load();
      return ok;
    },
    [run, load],
  );

  /** Shared by both purge flows: a 200 can still carry
   * AUTH_CLEANUP_AUDIT_WRITE_FAILED, which is NOT an error - the delete may
   * have happened but the audit write did not, so the entry stays listed and
   * a retry converges. That must read as a warning, never as plain success. */
  const purgeNotice = useCallback(
    (key: string, successMessage: string) =>
      (data: { deleted: boolean; auditRecorded: boolean; warning: string | null }) => {
        if (data.warning) {
          return {
            key,
            tone: "warning" as const,
            message: platformMultiEntityError(data.warning),
          };
        }
        return data.deleted
          ? { key, tone: "success" as const, message: successMessage }
          : null;
      },
    [],
  );

  const purgeReplaced = useCallback(
    async (previousAuthUserId: string) => {
      const key = BUSY.replacementPurge(previousAuthUserId);
      const ok = await run(
        key,
        (t) => purgeReplacedAuthUser(t, previousAuthUserId),
        purgeNotice(key, text.replacementCleanup.success),
      );
      if (ok) await load();
      return ok;
    },
    [run, load, purgeNotice],
  );

  const purgeOrphan = useCallback(
    async (authUserId: string) => {
      const key = BUSY.orphanPurge(authUserId);
      const ok = await run(
        key,
        (t) => purgeProvisioningOrphan(t, authUserId),
        purgeNotice(key, text.orphanCleanup.success),
      );
      if (ok) await load();
      return ok;
    },
    [run, load, purgeNotice],
  );

  const workspaces = state?.workspaces ?? [];

  return {
    loading,
    readError,
    reload: load,

    seat: state?.seat ?? null,
    workspaces,
    assignedCount: workspaces.filter((w) => w.isAssigned).length,
    pendingAuthCleanup: state?.pendingAuthCleanup ?? [],
    pendingProvisioningOrphans: state?.pendingProvisioningOrphans ?? [],

    busyKey,
    isBusy: (key: string) => busyKey === key,
    /** True while ANY mutation is in flight - used to disable other triggers
     * so a second destructive action cannot be started mid-flight. */
    anyBusy: busyKey !== null,
    errorFor: (key: string) => (actionError?.key === key ? actionError.message : null),
    /** Stage 8B: drops a stale action error (e.g. before re-opening a form). */
    clearError: () => setActionError(null),
    noticeFor: (key: string) => (notice?.key === key ? notice : null),

    passwordLink,
    dismissPasswordLink: () => setPasswordLink(null),

    provision,
    assign,
    unassign,
    purgeReplaced,
    purgeOrphan,
  };
}
