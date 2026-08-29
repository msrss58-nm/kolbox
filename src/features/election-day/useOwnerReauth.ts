import { useCallback, useState, type ReactNode } from "react";
import { toast } from "../../components/ui/Toast";
import { ownerReauth, type OwnerReauthAction } from "./electionDayOwnerClient";
import { useOwnerSession } from "./ownerSession";

interface OwnerReauthDialogCopy {
  title: string;
  summary: ReactNode;
  confirmLabel: string;
}

interface PendingOwnerReauth<R> {
  copy: OwnerReauthDialogCopy;
  action: OwnerReauthAction;
  /** Receives the freshly-minted proof and the access token used to mint it
   * - both live only in this call's own async control flow, never persisted
   * to any store/localStorage/sessionStorage. */
  run: (proof: string, accessToken: string) => Promise<R>;
  resolve: (value: R | undefined) => void;
}

export interface OwnerReauthDialogProps {
  open: true;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (password: string) => Promise<unknown>;
  onCancel: () => void;
}

const REAUTH_ERROR_TEXT: Record<"wrong_password" | "rate_limited" | "error", string> = {
  wrong_password: "הסיסמה שהזנת אינה נכונה",
  rate_limited: "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות",
  error: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
};

/**
 * Phase 3C Roles Mutations: the Owner-side equivalent of
 * `useElectionDayReauth.ts`, with one deliberate structural difference - it
 * NEVER caches a minted proof anywhere (no store, no localStorage/
 * sessionStorage). Every gated action re-opens the password dialog and mints
 * a brand-new one-time proof, which is consumed immediately by the same
 * mutation call and never survives past that call's own `await` chain. This
 * is a stricter posture than the legacy PermissionUser reauth flow's 5-minute
 * proof cache, matching this task's explicit requirement that an Owner proof
 * "stays in local async control flow only".
 */
export function useOwnerReauth() {
  const owner = useOwnerSession((s) => s.owner);
  const getAccessToken = useOwnerSession((s) => s.getAccessToken);
  const [pending, setPending] = useState<PendingOwnerReauth<unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const gate = useCallback(
    <R>(
      action: OwnerReauthAction,
      copy: OwnerReauthDialogCopy,
      run: (proof: string, accessToken: string) => Promise<R>,
    ): Promise<R | undefined> => {
      return new Promise<R | undefined>((resolve) => {
        setPending({
          copy,
          action,
          run: run as (proof: string, accessToken: string) => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
        });
      });
    },
    [],
  );

  const onConfirm = useCallback(
    async (password: string): Promise<unknown> => {
      if (!pending || !owner) return undefined;
      setBusy(true);
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          toast.error(REAUTH_ERROR_TEXT.error);
          return undefined;
        }
        const reauthResult = await ownerReauth(accessToken, password, pending.action);
        if (reauthResult.status !== "ok") {
          toast.error(REAUTH_ERROR_TEXT[reauthResult.status]);
          return undefined; // dialog stays open, password field clears itself
        }
        // The raw proof exists only in this local variable - it is passed
        // directly into `run()` and never assigned to any store/state.
        const result = await pending.run(reauthResult.proof, accessToken);
        if (result !== undefined) {
          pending.resolve(result);
          setPending(null);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [pending, owner, getAccessToken],
  );

  const onCancel = useCallback(() => {
    if (pending) pending.resolve(undefined);
    setPending(null);
  }, [pending]);

  const reauthDialog: OwnerReauthDialogProps | null = pending
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

export type OwnerReauthHook = ReturnType<typeof useOwnerReauth>;
