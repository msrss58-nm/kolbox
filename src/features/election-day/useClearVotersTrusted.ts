import { useCallback, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import type { ElectionDayReauthDialogProps } from "./useElectionDayReauth";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  clearVotersTrusted,
  reauthForClearVoters,
  type TrustedClearResult,
  type TrustedReauthResult,
} from "./electionDayTrustedVoterFileClient";

const errors = ELECTION_DAY_TEXT.reauth.trustedVoterFileErrors;

interface PendingClear {
  resolve: (value: true | undefined) => void;
}

function reauthErrorMessage(
  status: Exclude<TrustedReauthResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.wrongPassword;
    case "rate_limited":
      return errors.rateLimited;
    default:
      return errors.generic;
  }
}

function clearErrorMessage(status: Exclude<TrustedClearResult["status"], "ok">): string {
  switch (status) {
    case "unauthorized":
      return errors.sessionExpired;
    case "forbidden":
      return errors.forbidden;
    default:
      return errors.generic;
  }
}

/**
 * Phase 3 Import/Clear frontend cutover: dedicated trusted clear-voters
 * flow. Replaces the legacy raw, unguarded `api.clearElectionDayVoters()`
 * PostgREST delete (which had NO reauth step at all - only the existing
 * `ConfirmDialog` in `ElectionDayFilesPage.tsx`) with the trusted,
 * session-derived, one-time-consumed v3 path
 * (`electionDayTrustedVoterFileClient.ts`). Mirrors
 * `useDeletePermissionUserTrusted.ts`'s pattern exactly, minus any extra
 * business input - Clear needs nothing beyond a confirm trigger.
 *
 * The raw v3 proof exists only as a local `const` inside `onConfirm`'s one
 * continuous async flow (mint -> immediately consume -> function returns) -
 * never stored in any `useState`/`useRef`/store/persistence layer, never
 * logged. Nothing to clean up on logout: it cannot outlive one in-flight
 * call.
 */
export function useClearVotersTrusted() {
  const [pending, setPending] = useState<PendingClear | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const hasPendingRef = useRef(false);

  /** Opens the dedicated password dialog and resolves once the whole flow
   * concludes: `true` on success, `undefined` on cancel or on a failure the
   * user doesn't retry. A second call while a flow is already open is a
   * safe no-op. */
  const clearVoters = useCallback((): Promise<true | undefined> => {
    if (hasPendingRef.current) {
      return Promise.resolve(undefined);
    }
    hasPendingRef.current = true;
    return new Promise((resolve) => {
      setPending({ resolve });
    });
  }, []);

  const onConfirm = useCallback(
    async (password: string): Promise<unknown> => {
      if (!pending || inFlightRef.current) return undefined;
      inFlightRef.current = true;
      setBusy(true);
      try {
        const reauthResult = await reauthForClearVoters(password);
        if (reauthResult.status !== "ok") {
          toast.error(reauthErrorMessage(reauthResult.status));
          return undefined;
        }
        // Local variable only, for this one call - see this hook's own
        // doc comment.
        const proof = reauthResult.proof;
        const clearResult = await clearVotersTrusted(proof);
        if (clearResult.status !== "ok") {
          toast.error(clearErrorMessage(clearResult.status));
          return undefined;
        }
        toast.success(ELECTION_DAY_TEXT.clearAll.toast.cleared);
        pending.resolve(true);
        setPending(null);
        hasPendingRef.current = false;
        return true;
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [pending],
  );

  /** Once a reauth/clear request has actually started (`inFlightRef`),
   * Cancel is a safe no-op rather than resolving the caller as "cancelled" -
   * see `useCreatePermissionUserTrusted.ts`'s own onCancel doc comment for
   * the exact failure mode this prevents (identical reasoning). */
  const onCancel = useCallback(() => {
    if (inFlightRef.current) return;
    if (pending) pending.resolve(undefined);
    setPending(null);
    hasPendingRef.current = false;
  }, [pending]);

  const reauthDialog: ElectionDayReauthDialogProps | null = pending
    ? {
        open: true,
        title: ELECTION_DAY_TEXT.reauth.dialogTitle,
        summary: ELECTION_DAY_TEXT.reauth.dialogs.clearVoters,
        confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { clearVoters, reauthDialog, busy };
}
