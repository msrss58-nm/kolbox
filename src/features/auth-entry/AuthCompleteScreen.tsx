import { useCallback, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { useAsyncData } from "../../hooks/useAsyncData";
import { AUTH_CONFIRM_TEXT } from "./authEntry.constants";
import { completeHandoff, readTxnInfo } from "./authBrokerClient";

const text = AUTH_CONFIRM_TEXT;

/**
 * The target-origin confirmation - leg 2 of the handoff, and the control that
 * actually closes login CSRF / session swapping.
 *
 * It performs NO second authentication: credentials were entered once, on the
 * auth origin. It only shows the resolved identity and requires an explicit,
 * user-activated Continue before any session exists. That is what makes a
 * swapped sign-in visible and refusable - no mechanical binding can, because
 * an attacker who can script the auth origin can drive every automatic step.
 *
 * The transaction itself is proven by this origin's own `__Host-` HttpOnly
 * cookie, which no script on any origin can read or write, and which the auth
 * origin can never manufacture. This screen never sees it.
 *
 * `verifyOtp` is injected per surface, because each realm must establish its
 * aal1 session in ITS OWN isolated client's storage; MFA then runs afterwards
 * through the existing guard, completely unchanged.
 */
export function AuthCompleteScreen({
  verifyOtp,
}: {
  verifyOtp?: (tokenHash: string) => Promise<boolean>;
}) {
  const fetchInfo = useCallback(() => readTxnInfo(), []);
  const { data: info, loading } = useAsyncData(fetchInfo);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"cancelled" | "failed" | null>(null);

  const decide = async (action: "continue" | "cancel") => {
    setBusy(true);
    const result = await completeHandoff(action);
    if (result.status === "cancelled") {
      setOutcome("cancelled");
      setBusy(false);
      return;
    }
    if (result.status === "failed") {
      setOutcome("failed");
      setBusy(false);
      return;
    }
    if (result.status === "owner") {
      // Establishes an aal1 session in THIS origin's isolated client. The
      // existing guard then renders the existing MFA enrol/challenge screens.
      const ok = verifyOtp ? await verifyOtp(result.tokenHash) : false;
      if (!ok) {
        setOutcome("failed");
        setBusy(false);
        return;
      }
    }
    // A full navigation, so every guard re-runs from a clean state.
    window.location.replace(result.redirect);
  };

  if (loading && info === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }

  if (outcome !== null || info === null) {
    const cancelled = outcome === "cancelled";
    return (
      <div className="grid min-h-dvh place-items-center bg-surface p-6">
        <EmptyState
          icon={ShieldCheck}
          title={cancelled ? text.cancelled : text.expired}
          hint={cancelled ? text.cancelledHint : text.expiredHint}
          action={
            <a
              href="/"
              className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-semibold text-primary-700 ring-1 ring-slate-200"
            >
              {text.backToEntry}
            </a>
          }
        />
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>

        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-extrabold text-slate-800">{text.title}</h2>
          <p className="text-sm text-slate-500">{text.subtitle}</p>
        </div>

        {/* A minimal identity summary - enough to spot a swap, and nothing
            more. No email in the clear, no id, no token, no handoff code. */}
        <dl
          className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-slate-200"
          data-testid="auth-confirm-identity"
        >
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-bold text-slate-400">{text.identityLabel}</dt>
            <dd className="min-w-0 truncate text-sm font-bold text-slate-800" dir="ltr">
              {info.displayName}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs font-bold text-slate-400">{text.principalLabel}</dt>
            <dd className="text-sm text-slate-700">
              {text.realmNames[info.realm] ?? info.realm}
            </dd>
          </div>
          {info.displayContext && (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs font-bold text-slate-400">{text.contextLabel}</dt>
              <dd className="min-w-0 truncate text-sm text-slate-700">
                {info.displayContext}
              </dd>
            </div>
          )}
        </dl>

        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            className="w-full"
            loading={busy}
            onClick={() => void decide("continue")}
          >
            {text.continueAction}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => void decide("cancel")}
          >
            {text.cancelAction}
          </Button>
        </div>
      </div>
    </div>
  );
}
