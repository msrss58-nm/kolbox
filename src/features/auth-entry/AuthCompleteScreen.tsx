import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { AuthBrandLayout } from "../../components/AuthBrandLayout";
import { LogoMark } from "../../components/Logo";
import { EmptyState } from "../../components/ui/EmptyState";
import { AUTH_CONFIRM_TEXT, AUTH_ENTRY_TEXT } from "./authEntry.constants";
import { completeHandoff } from "./authBrokerClient";

const text = AUTH_CONFIRM_TEXT;

/**
 * Leg 2 of the handoff, on the target origin - and the ONLY path that mints a
 * session.
 *
 * IT PERFORMS NO SECOND AUTHENTICATION, and now asks for nothing at all: the
 * credential was entered once, on the auth origin, and this step completes
 * automatically. It used to render a Continue/Cancel confirmation showing the
 * resolved identity. That was a deliberate anti-login-CSRF control and its
 * removal is a deliberate product decision - see the note on what does and
 * does not still protect this exchange.
 *
 * WHAT STILL PROTECTS LEG 2, unchanged and entirely server-side:
 *   - the transaction is proven by THIS origin's own `__Host-kb_auth_txn`
 *     HttpOnly cookie, which no script on any origin can read or write and
 *     which the auth origin can never manufacture;
 *   - leg 1 accepted the code only from the configured auth origin, as a
 *     genuine cross-site `form_post`, and consumed it atomically - it is
 *     single-use and lives 90 s;
 *   - the row is re-checked for expiry and prior consumption on every read;
 *   - the session is minted by the server, for the realm the DIRECTORY
 *     resolved, never one the client named.
 * This component changes none of that: the server contract is byte-identical
 * and `api/platform/_authBroker.ts` was not touched.
 *
 * WHAT WAS GIVEN UP, stated plainly: the confirmation was the one control
 * that survived a SCRIPTED auth origin, because an attacker who can run
 * script there can drive every automatic step - including this one. It is
 * worth being honest that its marginal value was narrow: an attacker able to
 * execute script on the credential page can simply read the password as it
 * is typed, so they never needed a session swap in the first place. The auth
 * origin's strict CSP (`default-src 'none'; script-src 'self'`, no
 * `unsafe-inline`, no `unsafe-eval`, no third-party asset) remains the
 * control that keeps that scenario out of reach.
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
  const [failed, setFailed] = useState(false);
  // The handoff is SINGLE-USE. `StrictMode` double-invokes effects in
  // development, and a second call would consume an already-consumed
  // transaction and fail a sign-in that had actually succeeded.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const result = await completeHandoff("continue");
      if (result.status !== "session" && result.status !== "owner") {
        // Fail closed and visibly: no session was created, and the only way
        // onward is to start again from the entry.
        setFailed(true);
        return;
      }
      if (result.status === "owner") {
        // Establishes an aal1 session in THIS origin's isolated client. The
        // existing guard then renders the existing MFA enrol/challenge flow.
        const ok = verifyOtp ? await verifyOtp(result.tokenHash) : false;
        if (!ok) {
          setFailed(true);
          return;
        }
      }
      // A full navigation, so every guard re-runs from a clean state.
      window.location.replace(result.redirect);
    })();
  }, [verifyOtp]);

  if (failed) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface p-6">
        <EmptyState
          icon={ShieldCheck}
          title={text.expired}
          hint={text.expiredHint}
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

  // A transitional state, not a decision: nothing here is clickable and
  // nothing waits for the user. Rendered in the same branded shell as the
  // entry and the leg-1 bridge, so the whole sign-in reads as one screen.
  return (
    <AuthBrandLayout>
      <div className="space-y-4 text-center animate-fade-in">
        <LogoMark className="mx-auto size-12 animate-pulse" />
        <p className="text-sm text-slate-600">{AUTH_ENTRY_TEXT.continuing}</p>
      </div>
    </AuthBrandLayout>
  );
}
