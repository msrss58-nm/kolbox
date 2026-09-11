import { ROUTES } from "../../constants/routes";

/**
 * Platform Stage 5: captures - and strips - the one-time set-password link
 * material that lands on `/multi-entity/set-password`.
 *
 * ONE ENTRY MODE ONLY: `?token_hash=<hashed_token>&type=recovery` in the query
 * string, which is exactly and only what api/platform/session.ts mints for
 * the Multi-Entity seat. The screen redeems it explicitly with `verifyOtp()`.
 * Unlike the Platform Owner's module, the legacy `#access_token` fragment is
 * deliberately NOT accepted: this surface never issues one, and a link that
 * arrives in that shape is treated as invalid (its tokens are still stripped).
 *
 * Why strip at module scope: token hygiene. `history.replaceState` removes the
 * one-time token from the address bar and from session history before the
 * router renders. There is no client-consumption race to win here -
 * `multiEntityOwnerAuthClient` has `detectSessionInUrl: false`, and no
 * supabase-js client auto-consumes the `token_hash` query shape - so this
 * module does not need to be the first import.
 *
 * SCOPE GUARD: only ever acts on `ROUTES.multiEntitySetPassword` (trailing
 * slashes ignored, case-insensitive, matching react-router). Every other route
 * is left completely untouched.
 *
 * NOT AUTHORITY: everything captured here is an unverified URL value. The
 * screen proves it against the server (`verifyOtp`, then `getUser()`) before
 * rendering the form. Nothing here is logged or persisted.
 */

export interface MultiEntityRecoveryOtp {
  tokenHash: string;
  type: "recovery";
}

/** Auth-related params removed from the URL when the capture fires. */
const AUTH_PARAM_KEYS = [
  "token_hash",
  "token",
  "access_token",
  "refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
  "provider_token",
  "provider_refresh_token",
  "code",
  "type",
  "error",
  "error_code",
  "error_description",
] as const;

let capturedOtp: MultiEntityRecoveryOtp | null = null;
let capturedLinkError: string | null = null;
/** True when THIS page load arrived carrying link material of any shape. Lets
 * the screen refuse to open the password form for a session that merely
 * happens to be sitting in localStorage. */
let linkWasPresent = false;

function readParams(raw: string): URLSearchParams {
  const trimmed = raw.startsWith("#") || raw.startsWith("?") ? raw.slice(1) : raw;
  return new URLSearchParams(trimmed);
}

function isSetPasswordPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").toLowerCase() === ROUTES.multiEntitySetPassword;
}

function capture(): void {
  if (typeof window === "undefined") return;
  if (!isSetPasswordPath(window.location.pathname)) return;

  const query = readParams(window.location.search);
  const hash = readParams(window.location.hash);

  // A code, never the raw `error_description` - the screen renders its own
  // Hebrew copy rather than echoing a server string.
  capturedLinkError =
    query.get("error_code") ??
    query.get("error") ??
    hash.get("error_code") ??
    hash.get("error");

  const tokenHash = query.get("token_hash");
  if (query.get("type") === "recovery" && tokenHash) {
    capturedOtp = { tokenHash, type: "recovery" };
  }

  const hadUnsupportedFragment = hash.has("access_token") || hash.has("refresh_token");
  linkWasPresent =
    capturedOtp !== null || capturedLinkError !== null || hadUnsupportedFragment;

  // Strip unconditionally - even a link we refuse must not leave its
  // parameters in the address bar or history. The fragment is dropped whole.
  const url = new URL(window.location.href);
  for (const key of AUTH_PARAM_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

capture();

/** The one-time token, if any. Non-consuming (StrictMode mounts twice). */
export function getCapturedMultiEntityRecoveryOtp(): MultiEntityRecoveryOtp | null {
  return capturedOtp;
}

/** Supabase's error code for an expired/used link, latched for the page load. */
export function getCapturedMultiEntityRecoveryLinkError(): string | null {
  return capturedLinkError;
}

/** Whether this page load arrived with link material at all. REQUIRED by the
 * screen: storage is not evidence of a recovery. */
export function hadMultiEntityRecoveryLink(): boolean {
  return linkWasPresent;
}

/** Drops the in-memory token once redeemed. The error and presence verdicts
 * are deliberately kept - a later mount must reach the same verdict. */
export function clearCapturedMultiEntityRecovery(): void {
  capturedOtp = null;
}
