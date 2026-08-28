import { useCallback, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import type { PermissionUser } from "../../types";
import type { ElectionDayReauthDialogProps } from "./useElectionDayReauth";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  reauthForResetPermissionUserPassword,
  resetPermissionUserPasswordTrusted,
  type TrustedReauthResult,
  type TrustedResetPasswordResult,
} from "./electionDayTrustedUsersClient";

const errors = ELECTION_DAY_TEXT.reauth.trustedUserErrors;

interface PendingReset {
  targetUserId: string;
  targetName: string;
  newPassword: string;
  resolve: (value: PermissionUser | undefined) => void;
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

function resetErrorMessage(
  status: Exclude<TrustedResetPasswordResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.sessionExpired;
    case "forbidden":
      return errors.forbidden;
    case "user_not_found":
      return errors.userNotFound;
    case "invalid_password":
      return errors.invalidPassword;
    default:
      return errors.generic;
  }
}

/**
 * Phase 3C Users (EXPAND, not yet wired to the frontend/useElectionDay.ts):
 * dedicated trusted reset-password flow, session + one-time-consumed-proof
 * (`api/election-day/permission-users-reset-password.ts` +
 * `election_day_reset_permission_user_password_v3`). Deliberately
 * independent of `useElectionDayReauth`/`electionDayReauthProof.ts` and of
 * the create/delete trusted hooks - its own `pending`/`busy` state, own
 * dialog instance, own one-time proof for exactly this call.
 *
 * `newPassword` is captured into `pending` at `resetPassword()`-call time
 * (from the caller, e.g. `ResetPasswordDialog`'s own form fields) rather
 * than collected by this hook's own dialog - the reauth dialog only ever
 * asks for the ACTING MANAGER's password (step-up), never the new password
 * being set for the target, matching `ResetPasswordDialog.tsx`'s existing
 * documented division of responsibility exactly.
 *
 * The raw reauth proof exists only as a local `const` inside `onConfirm`'s
 * one continuous async flow - never stored in any `useState`/`useRef`/
 * store/persistence layer, never logged. On success the server also
 * revokes every one of the target's active sessions and outstanding legacy
 * reauth proofs - this hook has no separate responsibility for that.
 */
export function useResetPermissionUserPasswordTrusted() {
  const [pending, setPending] = useState<PendingReset | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef(false);
  const hasPendingRef = useRef(false);

  /** Opens the dedicated password dialog (asking for the ACTING MANAGER's
   * own password, step-up style) for resetting `targetUserId` to
   * `newPassword`. Resolves once the whole flow concludes: the updated
   * `PermissionUser` on success, `undefined` on cancel or a failed attempt
   * the user doesn't retry. A second call while a flow is already open is a
   * safe no-op. */
  const resetPassword = useCallback(
    (
      targetUserId: string,
      targetName: string,
      newPassword: string,
    ): Promise<PermissionUser | undefined> => {
      if (hasPendingRef.current) {
        return Promise.resolve(undefined);
      }
      hasPendingRef.current = true;
      return new Promise((resolve) => {
        setPending({ targetUserId, targetName, newPassword, resolve });
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
        const reauthResult = await reauthForResetPermissionUserPassword(password);
        if (reauthResult.status !== "ok") {
          toast.error(reauthErrorMessage(reauthResult.status));
          return undefined;
        }
        const proof = reauthResult.proof;
        const resetResult = await resetPermissionUserPasswordTrusted(
          pending.targetUserId,
          pending.newPassword,
          proof,
        );
        if (resetResult.status !== "ok") {
          toast.error(resetErrorMessage(resetResult.status));
          return undefined;
        }
        pending.resolve(resetResult.user);
        setPending(null);
        hasPendingRef.current = false;
        return resetResult.user;
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [pending],
  );

  /** Once a reauth/reset request has actually started (`inFlightRef`),
   * Cancel is a safe no-op rather than resolving the caller as "cancelled" -
   * the server mutation may still complete. Same reasoning as
   * useDeletePermissionUserTrusted.ts's own onCancel. */
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
        summary: ELECTION_DAY_TEXT.reauth.dialogs.resetPermissionUserPassword(
          pending.targetName,
        ),
        confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { resetPassword, reauthDialog };
}
