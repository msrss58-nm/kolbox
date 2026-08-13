import { useCallback, useState, type ReactNode } from "react";
import { toast } from "../../components/ui/Toast";
import { api } from "../../services/api";
import { useElectionDaySession } from "./electionDaySession";
import { useElectionDayReauthProof } from "./electionDayReauthProof";

interface ReauthDialogCopy {
  title: string;
  summary: ReactNode;
  confirmLabel: string;
}

interface PendingReauth {
  copy: ReauthDialogCopy;
  /** The gated mutation itself - already knows its own arguments (bound by
   * the caller), reads the just-cached proof from the store itself rather
   * than having it threaded through here. Never throws (mirrors every
   * `useAsyncAction`-wrapped function's "undefined on failure" contract) -
   * its own success/error toast already fired by the time this resolves. */
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
}

export interface ElectionDayReauthDialogProps {
  open: true;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (password: string) => Promise<unknown>;
  onCancel: () => void;
}

/**
 * Security Hardening (Reauth): the shared gate every one of the 8
 * `_v2` admin/import mutations goes through before it's allowed to run.
 *
 * `gate(copy, run)`:
 * - If `electionDayReauthProof`'s in-memory cache already holds a
 *   currently-valid proof, `run()` is called immediately - no dialog, no
 *   extra round trip. `run()` itself (via `useAsyncAction`, same as every
 *   other mutation in this codebase) is responsible for reading that proof
 *   from the store, clearing it if the RPC comes back `UNAUTHORIZED`, and
 *   toasting success/failure - this gate has no opinion on any of that.
 * - Otherwise this opens `AllocationPasswordDialog` (via the returned
 *   `reauthDialog` props - render it once per hook instance) with the
 *   caller-supplied copy. On submit, it calls `api.reauth()`, caches the
 *   returned proof, and only then calls `run()` - a single continuous flow
 *   from the gated action's point of view. On a failed password attempt (or
 *   a failed `run()`, e.g. a business-rule rejection), the dialog stays open
 *   for the user to retry - it only closes on `run()` actually succeeding
 *   (a defined result) or on the user cancelling, mirroring
 *   `CoordinatorRosterEditor.tsx`'s existing `AllocationPasswordDialog` usage
 *   exactly (same "undefined on failure - dialog stays" contract, not a
 *   custom close condition invented for this new engine).
 *
 * Deliberately does NOT auto-retry a mutation after an `UNAUTHORIZED`
 * failure on the FAST (cached-proof) path - `run()` clears the stale proof
 * and surfaces the failure normally (its own `useAsyncAction` toast); the
 * user's next click starts a fresh `gate()` call, which will naturally find
 * no cached proof and prompt for a password again. This keeps destructive
 * mutations (e.g. the ride-list import) from ever being silently retried.
 */
export function useElectionDayReauth() {
  const sessionUser = useElectionDaySession((s) => s.user);
  const [pending, setPending] = useState<PendingReauth | null>(null);
  const [busy, setBusy] = useState(false);

  const gate = useCallback(
    <R>(copy: ReauthDialogCopy, run: () => Promise<R>): Promise<R | undefined> => {
      if (useElectionDayReauthProof.getState().hasValidProof()) {
        return run();
      }
      return new Promise<R | undefined>((resolve) => {
        setPending({
          copy,
          run,
          resolve: resolve as (value: unknown) => void,
        });
      });
    },
    [],
  );

  const onConfirm = useCallback(
    async (password: string): Promise<unknown> => {
      if (!pending || !sessionUser) return undefined;
      setBusy(true);
      try {
        let proof: string;
        try {
          proof = await api.reauth(sessionUser.id, password);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          return undefined; // dialog stays open, password field clears itself
        }
        useElectionDayReauthProof.getState().setProof(proof);
        const result = await pending.run();
        if (result !== undefined) {
          pending.resolve(result);
          setPending(null);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [pending, sessionUser],
  );

  const onCancel = useCallback(() => {
    if (pending) pending.resolve(undefined);
    setPending(null);
  }, [pending]);

  const reauthDialog: ElectionDayReauthDialogProps | null = pending
    ? {
        open: true,
        title: pending.copy.title,
        summary: pending.copy.summary,
        confirmLabel: pending.copy.confirmLabel,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { gate, reauthDialog };
}

export type ElectionDayReauthHook = ReturnType<typeof useElectionDayReauth>;
