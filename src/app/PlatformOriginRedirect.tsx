import { useEffect } from "react";
import { APP_SHELL_TEXT } from "./appShell.constants";

/**
 * ORIGIN SEPARATION - CUTOVER compatibility shim for the ELECTION surface.
 *
 * After cutover the main origin stops serving the Platform Owner routes, so a
 * bookmark or a stale link to `https://<election-origin>/platform/...` would
 * otherwise land on react-router's no-match page. These four paths instead
 * bounce to the canonical Platform origin.
 *
 * DELIBERATELY NOT A GENERAL-PURPOSE REDIRECTOR. The destination can only ever
 * be one of the three constants below: the component takes a KEY, never a URL
 * or a path, so there is no code path in which anything derived from the
 * address bar - a query string, a fragment, a path segment - can influence
 * where the browser is sent. An open-redirect is structurally impossible here
 * rather than merely filtered out.
 *
 * NOTHING IS FORWARDED, and that matters most for `/platform/set-password`: a
 * recovery link deposits a one-time token there. The target is the BARE
 * set-password route, so the token is never handed across origins by this
 * shim. (The token is already stripped from the address bar before any of this
 * renders - `platformOwnerRecoveryUrl` runs at module-evaluation time and is
 * still imported on this surface for exactly that reason - so the owner simply
 * requests a fresh link on the new origin, which is the correct outcome for a
 * link issued against a origin that no longer serves the flow.)
 *
 * Renders no Platform credential field, and imports nothing from
 * `features/platform-owner/` beyond that side-effect module, so the Platform
 * Owner login form stays absent from this surface's bundle - which is the
 * entire point of the origin split.
 */

/** Every destination this component can ever produce - the same hard-coded,
 * key-addressed map the unified entry screen links through, now kept in one
 * audited place (`./origins`). Behaviour here is unchanged: this shim still
 * accepts only the three platform keys below. */
import { KOLBOX_ORIGIN_URLS } from "./origins";

const PLATFORM_ORIGIN_URLS = {
  console: KOLBOX_ORIGIN_URLS.console,
  login: KOLBOX_ORIGIN_URLS.login,
  setPassword: KOLBOX_ORIGIN_URLS.setPassword,
} as const;

export type PlatformOriginTarget = keyof typeof PLATFORM_ORIGIN_URLS;

export function PlatformOriginRedirect({ target }: { target: PlatformOriginTarget }) {
  const href = PLATFORM_ORIGIN_URLS[target];

  useEffect(() => {
    // `replace`, not `assign`: the old-origin URL must not stay in session
    // history, so Back cannot bounce the owner straight back into a dead route.
    window.location.replace(href);
  }, [href]);

  // Shown only for the moment before the navigation commits, and as the
  // fallback if a browser blocks the scripted redirect outright.
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">
          {APP_SHELL_TEXT.platformMovedTitle}
        </h1>
        <p className="mt-2 text-sm text-slate-500">{APP_SHELL_TEXT.platformMovedBody}</p>
        <a
          href={href}
          className="mt-4 inline-block text-sm font-medium text-sky-600 underline"
        >
          {APP_SHELL_TEXT.platformMovedLink}
        </a>
      </div>
    </div>
  );
}
