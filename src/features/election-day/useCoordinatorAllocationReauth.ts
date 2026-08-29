import { useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "../../components/ui/Toast";
import { useCoordinatorAllocationReauthProof } from "./coordinatorAllocationReauthProof";
import { reauthForCoordinatorAllocation } from "./electionDayTrustedCoordinatorAllocationClient";

interface ReauthDialogCopy {
  title: string;
  summary: ReactNode;
  confirmLabel: string;
}

interface PendingReauth {
  copy: ReauthDialogCopy;
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
 * Coordinator/Allocation V3 Frontend Cutover: the feature-specific reauth
 * gate for the 4 trusted Coordinator/Allocation mutations - mirrors
 * `useElectionDayReauth.ts`'s `gate(copy, run)` contract and dialog-render
 * shape exactly (so `CoordinatorAllocationView.tsx` needs no change), but
 * is a SEPARATE hook over a SEPARATE proof store
 * (`coordinatorAllocationReauthProof.ts`, 5-minute TTL, `coordinator_
 * allocation` action) - never shared with the legacy 15-minute cache still
 * serving the other `_v2` reauth-gated actions.
 *
 * Deliberately does NOT copy `useElectionDayReauth.ts`'s reachable
 * orphaned-promise bug (two `gate()` calls before any proof is cached: the
 * second `setPending` call silently overwrites the first, permanently
 * hanging the first caller's `await gate(...)` - traced against
 * `Modal.tsx`'s full-viewport backdrop and confirmed reachable via a fast
 * double-click before the first dialog paints). Instead uses the same
 * `hasPendingRef`/`inFlightRef` synchronous-guard pattern already reviewed
 * and shipped in `useCreatePermissionUserTrusted.ts`/
 * `useDeletePermissionUserTrusted.ts` for exactly this failure class:
 * - `hasPendingRef` is checked/set BEFORE `setPending`, synchronously, so a
 *   second `gate()` call while one is already open is a safe no-op
 *   (resolves `undefined` immediately, opens no second dialog, executes no
 *   business mutation) rather than orphaning the first caller.
 * - `inFlightRef` guards the confirm step itself against a duplicate
 *   submit (e.g. a fast double-click on the dialog's own confirm button)
 *   once a reauth/mutation attempt has actually started.
 * No queue: a rejected second caller must be retried by the user's own next
 * click, exactly matching the already-shipped trusted-hook UX contract -
 * deliberately simpler than a real queue for a feature-specific gate.
 */
export function useCoordinatorAllocationReauth() {
  const [pending, setPending] = useState<PendingReauth | null>(null);
  const [busy, setBusy] = useState(false);
  const hasPendingRef = useRef(false);
  const inFlightRef = useRef(false);

  const gate = useCallback(
    <R>(copy: ReauthDialogCopy, run: () => Promise<R>): Promise<R | undefined> => {
      if (useCoordinatorAllocationReauthProof.getState().hasValidProof()) {
        return run();
      }
      if (hasPendingRef.current) {
        return Promise.resolve(undefined);
      }
      hasPendingRef.current = true;
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
      if (!pending || inFlightRef.current) return undefined;
      inFlightRef.current = true;
      setBusy(true);
      try {
        let proof: string;
        try {
          proof = await reauthForCoordinatorAllocation(password);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
          return undefined; // dialog stays open, password field clears itself
        }
        useCoordinatorAllocationReauthProof.getState().setProof(proof);
        const result = await pending.run();
        if (result !== undefined) {
          pending.resolve(result);
          setPending(null);
          hasPendingRef.current = false;
        }
        return result;
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [pending],
  );

  const onCancel = useCallback(() => {
    if (inFlightRef.current) return;
    if (pending) pending.resolve(undefined);
    setPending(null);
    hasPendingRef.current = false;
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

export type CoordinatorAllocationReauthHook = ReturnType<
  typeof useCoordinatorAllocationReauth
>;
