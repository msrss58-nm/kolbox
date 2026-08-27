import { useCallback, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import type { NewPermissionUser } from "../../services/api";
import type { PermissionUser } from "../../types";
import type { ElectionDayReauthDialogProps } from "./useElectionDayReauth";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  createPermissionUserTrusted,
  reauthForCreatePermissionUser,
  type TrustedCreateResult,
  type TrustedReauthResult,
} from "./electionDayTrustedPermissionUserClient";

const errors = ELECTION_DAY_TEXT.reauth.trustedCreateErrors;

interface PendingCreate {
  input: NewPermissionUser;
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

function createErrorMessage(
  status: Exclude<TrustedCreateResult["status"], "ok">,
): string {
  switch (status) {
    case "unauthorized":
      return errors.sessionExpired;
    case "forbidden":
      return errors.forbidden;
    case "role_not_found":
      return errors.roleNotFound;
    case "duplicate_name":
      return errors.duplicateName;
    default:
      return errors.generic;
  }
}

/**
 * Phase 3C: dedicated trusted create-user flow, cut over from the legacy
 * general-purpose reauth-proof gate (`useElectionDayReauth.ts`) to the
 * already-deployed session-derived v3 path
 * (`electionDayTrustedPermissionUserClient.ts`). Deliberately independent of
 * `useElectionDayReauth`/`electionDayReauthProof.ts` - its own `pending`/
 * `busy` state, its own dialog instance - so the v3 proof this flow mints
 * can never enter the legacy 15-minute cache shared by the other 10
 * `_v2` reauth-gated actions (delete/reset-password/import/role-management/
 * coordinator-allocation), which stay completely unchanged by this hook.
 *
 * The raw v3 proof exists only as a local `const` inside `onConfirm`'s one
 * continuous async flow (mint -> immediately consume -> function returns) -
 * never stored in any `useState`/`useRef`/store/persistence layer, never
 * logged. Nothing to clean up on logout: it cannot outlive one in-flight
 * call.
 */
export function useCreatePermissionUserTrusted() {
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous in-flight guard, checked/set before any `await` - independent
  // of AllocationPasswordDialog's own `submitting` state (defense in depth,
  // same reasoning as electionDaySession.login's own duplicate-submit guard).
  const inFlightRef = useRef(false);

  /** Opens the dedicated password dialog for `input` and resolves once the
   * whole flow concludes: the created user on success, `undefined` on
   * cancel or on a failure the user doesn't retry (dialog stays open on a
   * failed attempt, mirroring every other `useAsyncAction`/gate contract in
   * this codebase - the caller decides whether to retry by confirming
   * again, which always mints a fresh proof, never reuses the failed one). */
  const createUser = useCallback(
    (input: NewPermissionUser): Promise<PermissionUser | undefined> => {
      return new Promise((resolve) => {
        setPending({ input, resolve });
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
        const reauthResult = await reauthForCreatePermissionUser(password);
        if (reauthResult.status !== "ok") {
          toast.error(reauthErrorMessage(reauthResult.status));
          return undefined;
        }
        // Local variable only, for this one call - never assigned to any
        // useState/useRef/store. Discarded when this try block exits.
        const proof = reauthResult.proof;
        const createResult = await createPermissionUserTrusted(pending.input, proof);
        if (createResult.status !== "ok") {
          toast.error(createErrorMessage(createResult.status));
          return undefined;
        }
        toast.success(ELECTION_DAY_TEXT.permissionsManager.toast.added);
        pending.resolve(createResult.user);
        setPending(null);
        return createResult.user;
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [pending],
  );

  const onCancel = useCallback(() => {
    if (pending) pending.resolve(undefined);
    setPending(null);
  }, [pending]);

  const reauthDialog: ElectionDayReauthDialogProps | null = pending
    ? {
        open: true,
        title: ELECTION_DAY_TEXT.reauth.dialogTitle,
        summary: ELECTION_DAY_TEXT.reauth.dialogs.addPermissionUser(pending.input.name),
        confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        busy,
        onConfirm,
        onCancel,
      }
    : null;

  return { createUser, reauthDialog };
}
