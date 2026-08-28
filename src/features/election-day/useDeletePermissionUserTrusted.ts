import { useCallback, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import type { ElectionDayReauthDialogProps } from "./useElectionDayReauth";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  deletePermissionUserTrusted,
  reauthForDeletePermissionUser,
  type TrustedDeleteResult,
  type TrustedReauthResult,
} from "./electionDayTrustedUsersClient";

const errors = ELECTION_DAY_TEXT.reauth.trustedUserErrors;

interface PendingDelete {
  targetUserId: string;
  targetName: string;
  resolve: (value: boolean | undefined) => void;
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

function deleteErrorMessage(
  status: Exclude<TrustedDeleteResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.sessionExpired;
    case "forbidden":
      return errors.forbidden;
    case "cannot_delete_self":
      return errors.cannotDeleteSelf;
    case "user_not_found":
      return errors.userNotFound;
    default:
      return errors.generic;
  }
}

/**
 * Phase 3C Users: dedicated trusted delete-user flow, wired into
 * `useElectionDay.ts`'s `deletePermissionUser`, session +
 * one-time-consumed-proof (`api/election-day/permission-users-delete.ts` +
 * `election_day_delete_permission_user_v3`). Deliberately independent of
 * `useElectionDayReauth`/`electionDayReauthProof.ts` (the legacy 15-minute,
 * reusable, general-purpose proof cache shared by the 9 remaining `_v2`
 * reauth-gated actions) and of `useCreatePermissionUserTrusted.ts`/
 * `useResetPermissionUserPasswordTrusted.ts` - its own `pending`/`busy`
 * state, its own dialog instance, own one-time proof for exactly this call.
 *
 * The raw proof exists only as a local `const` inside `onConfirm`'s one
 * continuous async flow (mint -> immediately consume -> function returns) -
 * never stored in any `useState`/`useRef`/store/persistence layer, never
 * logged, never reused after the call settles (the server itself also
 * one-time-consumes it - see the migration's own header comment for the
 * exact semantics - but this hook never attempts a second use either way).
 */
export function useDeletePermissionUserTrusted() {
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard, checked/set before any `await` - same
  // defense-in-depth reasoning as useCreatePermissionUserTrusted.ts's own
  // inFlightRef.
  const inFlightRef = useRef(false);
  // Synchronous "a flow is currently open" guard - see
  // useCreatePermissionUserTrusted.ts's own hasPendingRef doc comment for
  // the exact orphaned-Promise failure mode this prevents.
  const hasPendingRef = useRef(false);

  /** Opens the dedicated password dialog for `targetUserId`/`targetName` and
   * resolves once the whole flow concludes: `true` on success, `undefined`
   * on cancel or a failed attempt the user doesn't retry. A second call
   * while a flow is already open is a safe no-op. */
  const deleteUser = useCallback(
    (targetUserId: string, targetName: string): Promise<boolean | undefined> => {
      if (hasPendingRef.current) {
        return Promise.resolve(undefined);
      }
      hasPendingRef.current = true;
      return new Promise((resolve) => {
        setPending({ targetUserId, targetName, resolve });
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
        const reauthResult = await reauthForDeletePermissionUser(password);
        if (reauthResult.status !== "ok") {
          toast.error(reauthErrorMessage(reauthResult.status));
          return undefined;
        }
        // Local variable only, for this one call - see this hook's own
        // doc comment. The server also one-time-consumes this same proof
        // (see the migration's header) - this local copy is never reused
        // after this line, regardless of outcome.
        const proof = reauthResult.proof;
        const deleteResult = await deletePermissionUserTrusted(
          pending.targetUserId,
          proof,
        );
        if (deleteResult.status !== "ok") {
          toast.error(deleteErrorMessage(deleteResult.status));
          return undefined;
        }
        toast.success(ELECTION_DAY_TEXT.permissionsManager.toast.deleted);
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

  /** Once a reauth/delete request has actually started (`inFlightRef`),
   * Cancel is a safe no-op rather than resolving the caller as "cancelled" -
   * the server mutation may still complete. See
   * useCreatePermissionUserTrusted.ts's own onCancel doc comment for the
   * full failure mode this prevents (identical reasoning). */
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
        summary: ELECTION_DAY_TEXT.reauth.dialogs.deletePermissionUser(
          pending.targetName,
        ),
        confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { deleteUser, reauthDialog };
}
