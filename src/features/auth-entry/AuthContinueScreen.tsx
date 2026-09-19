import { useEffect, useRef } from "react";
import { AuthBrandLayout } from "../../components/AuthBrandLayout";
import { LogoMark } from "../../components/Logo";
import { AUTH_ENTRY_TEXT } from "./authEntry.constants";

export interface PendingHandoff {
  code: string;
  targetOrigin: string;
}

/**
 * The cross-origin bridge: OIDC's `form_post` response mode.
 *
 * A top-level auto-submitting form POST carries the one-time handoff code to
 * the target origin **in the request body**. That is the whole point: a body
 * never reaches the address bar, `Referer`, browser history, a bookmark, or a
 * server access log - all of which record URLs. A fragment or query handoff
 * would have leaked the code into every one of them, and would also have
 * handed an attacker a way to inject a code into someone else's auth-origin
 * page, which is a complete login-CSRF bypass.
 *
 * The code arrives as a prop, from React state set by the broker response in
 * this same page load. It is never read from the URL - asserted by test, and
 * this component deliberately has no access to `useSearchParams`.
 */
export function AuthContinueForm({ handoff }: { handoff: PendingHandoff }) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Submitted once, immediately. A genuine external-state sync - the
    // canonical case an effect exists for.
    formRef.current?.submit();
  }, []);

  // Rendered inside the same branded shell as the entry form it replaces, so
  // the hand-off reads as one continuous screen instead of collapsing the
  // brand panel for the moment before the cross-origin POST leaves.
  return (
    <AuthBrandLayout>
      <div className="space-y-4 text-center animate-fade-in">
        <LogoMark className="mx-auto size-12 animate-pulse" />
        <p className="text-sm text-slate-600">{AUTH_ENTRY_TEXT.continuing}</p>
        <form
          ref={formRef}
          method="POST"
          action={`${handoff.targetOrigin}/api/auth/continue`}
        >
          <input type="hidden" name="code" value={handoff.code} />
          {/* A no-JS fallback; the effect above submits this for everyone else. */}
          <noscript>
            <button type="submit">{AUTH_ENTRY_TEXT.submit}</button>
          </noscript>
        </form>
      </div>
    </AuthBrandLayout>
  );
}

/** Route element for `/auth/continue`. Reaching this path directly carries no
 * pending handoff - and, critically, the code is NEVER taken from the URL -
 * so it simply sends the visitor back to the entry form. */
export function AuthContinueScreen() {
  useEffect(() => {
    window.location.replace("/");
  }, []);
  return (
    <div className="grid min-h-dvh place-items-center bg-surface">
      <LogoMark className="size-12 animate-pulse" />
    </div>
  );
}
