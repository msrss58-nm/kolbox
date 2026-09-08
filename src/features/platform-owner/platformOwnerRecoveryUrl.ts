import { ROUTES } from "../../constants/routes";

/**
 * Platform Stage 2 (password set/recovery): captures - and strips - the
 * Supabase auth parameters that a recovery/invite link deposits on
 * `/platform/set-password`.
 *
 * TWO SUPPORTED ENTRY MODES
 * -------------------------
 *  1. PREFERRED - `?token_hash=<hashed_token>&type=recovery` in the QUERY
 *     string. The operator's link points straight at this route, carrying
 *     `properties.hashed_token` from `auth.admin.generateLink`, so GoTrue's
 *     own `/verify` redirect is never involved. Nothing in `@supabase/auth-js`
 *     auto-consumes this shape (`_isImplicitGrantCallback` wants
 *     `access_token`/`error_description`; `_isPKCECallback` wants `code`), so
 *     there is no race at all - the screen redeems it explicitly with
 *     `verifyOtp({ token_hash, type })`.
 *  2. FALLBACK - the legacy implicit fragment
 *     `#access_token=...&refresh_token=...&type=recovery`, produced when the
 *     link goes through GoTrue's `/verify` redirect. Redeemed with an explicit
 *     `setSession()`.
 *
 * WHY THIS RUNS AT MODULE SCOPE (and is imported first by `router.tsx`)
 * --------------------------------------------------------------------
 * Only mode 2 needs it, and for two independent reasons:
 *
 *  a. Token hygiene. `@supabase/auth-js` clears the fragment with
 *     `window.location.hash = ''`, which PUSHES a history entry and therefore
 *     leaves the access token sitting in the previous one. The requirement
 *     here is the opposite: strip it with `history.replaceState`, so the token
 *     never survives in the address bar or in session history.
 *
 *  b. Cross-identity leakage. This app constructs several Supabase clients
 *     (`client.ts` campaign, `ownerAuthClient.ts` Election Owner,
 *     `platformOwnerAuthClient.ts` Platform Owner). Every one auto-initializes
 *     in its constructor with `detectSessionInUrl` at its default of `true`
 *     and `flowType` at its default of `'implicit'`, so whichever module is
 *     evaluated first would consume the Platform Owner's recovery tokens and
 *     persist them under ITS OWN storage key - silently replacing, for
 *     example, a signed-in campaign user's session. Which client wins is a
 *     bundler-ordering race. Those client files are intentionally NOT modified
 *     (their `storageKey` semantics are load-bearing for already-signed-in
 *     users); this module solves it from the outside.
 *
 * ON THE "STRIP TOO EARLY" TRAP: stripping the URL is only destructive if a
 * client still has to READ it. Here the read and the strip are one synchronous
 * block at module-evaluation time, before any client is constructed - so no
 * client ever enters `_getSessionFromURL` on this page, and none of them needs
 * the URL afterwards. (Even in the ordering this file does not control, a
 * client that already ran `parseParametersFromURL` holds its params in memory,
 * and one that runs later simply falls through to `_recoverAndRefresh()`.
 * Neither case loses the session, because the tokens are redeemed explicitly
 * by the screen, never by `detectSessionInUrl`.)
 *
 * ERROR LINKS ARE OTHERWISE SILENT: on an expired or already-used link GoTrue
 * redirects with `#error=...&error_code=otp_expired&...`. `_getSessionFromURL`
 * throws before its own hash-clearing line, `_initialize`'s floating `.catch`
 * swallows it, and NO `onAuthStateChange` event fires - the user would sit on
 * a blank page with the error still in the address bar. Capturing the error
 * params here is what lets the screen render its Hebrew "invalid link" state.
 *
 * SCOPE GUARD: the capture only ever fires on `ROUTES.platformSetPassword`,
 * compared the way react-router matches it (trailing slashes ignored, case
 * insensitive) so a valid link can never be stranded unparsed in the URL. Every other route - including the campaign
 * app's own magic-link/invite landings - is left completely untouched, so this
 * module can never swallow another identity's callback.
 *
 * NOT AUTHORITY: everything captured here is unverified input from a URL. It
 * is only ever a candidate; `PlatformOwnerSetPasswordScreen` proves it against
 * the server (`verifyOtp`/`setSession`, then `getUser()`) before showing the
 * form, and the password change itself is authorized by Supabase. Nothing here
 * is logged or persisted.
 */

/** Link types that legitimately end at a "set a password" screen. Anything
 * else (`magiclink`, an OAuth callback, ...) is treated as not-a-recovery and
 * falls through to the fail-closed "invalid link" state. Both values are valid
 * `EmailOtpType`s, so they can be passed straight to `verifyOtp`. */
export type PlatformRecoveryLinkType = "recovery" | "invite";

const PASSWORD_SET_LINK_TYPES: readonly PlatformRecoveryLinkType[] = [
  "recovery",
  "invite",
];

function isPasswordSetLinkType(value: string | null): value is PlatformRecoveryLinkType {
  return (
    value !== null && PASSWORD_SET_LINK_TYPES.includes(value as PlatformRecoveryLinkType)
  );
}

/** Mode 1 - a hashed one-time token to redeem with `verifyOtp`. */
export interface PlatformRecoveryOtp {
  tokenHash: string;
  type: PlatformRecoveryLinkType;
}

/** Mode 2 - an already-issued session from the legacy implicit fragment. */
export interface PlatformRecoveryTokens {
  accessToken: string;
  refreshToken: string;
}

/** Auth-related params removed from the URL when the capture fires. Kept as
 * one list so the strip and the parse can never drift apart. */
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

let capturedOtp: PlatformRecoveryOtp | null = null;
let capturedTokens: PlatformRecoveryTokens | null = null;
let capturedLinkError: string | null = null;
/** True when THIS page load actually arrived carrying recovery-link material
 * (a token, a session pair, or an error). Load-scoped on purpose: it is what
 * lets the screen refuse to open the password form for a session that merely
 * happens to be sitting in localStorage. */
let linkWasPresent = false;

function readParams(raw: string): URLSearchParams {
  const trimmed = raw.startsWith("#") || raw.startsWith("?") ? raw.slice(1) : raw;
  return new URLSearchParams(trimmed);
}

/** react-router matches `/platform/set-password`, `/platform/set-password/` and
 * `/Platform/Set-Password` all to the same route, so the capture has to be at
 * least as lenient. A stricter comparison fails CLOSED in the worst way: the
 * screen renders, captures nothing, tells the owner the link is invalid - and
 * leaves the still-unused one-time token sitting in the address bar. */
function isSetPasswordPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "").toLowerCase() === ROUTES.platformSetPassword;
}

function capture(): void {
  if (typeof window === "undefined") return;
  if (!isSetPasswordPath(window.location.pathname)) return;

  const hashParams = readParams(window.location.hash);
  const queryParams = readParams(window.location.search);
  // Query first: mode 1 is the preferred shape and lives there, while mode 2's
  // params only ever arrive in the fragment, so the two cannot collide.
  const read = (key: string) => queryParams.get(key) ?? hashParams.get(key);

  // Recorded as a code, never as the raw `error_description` - the screen
  // renders its own Hebrew copy rather than echoing a server string.
  capturedLinkError = read("error_code") ?? read("error");

  const type = read("type");
  const tokenHash = read("token_hash");
  const accessToken = read("access_token");
  const refreshToken = read("refresh_token");

  if (isPasswordSetLinkType(type)) {
    if (tokenHash) {
      capturedOtp = { tokenHash, type };
    } else if (accessToken && refreshToken) {
      capturedTokens = { accessToken, refreshToken };
    }
  }

  linkWasPresent =
    capturedOtp !== null || capturedTokens !== null || capturedLinkError !== null;

  // Strip unconditionally: even a link we refuse to act on must not leave its
  // parameters behind in the address bar or in session history. `replaceState`
  // (not `location.hash = ''`) so no history entry retains them.
  const url = new URL(window.location.href);
  for (const key of AUTH_PARAM_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

capture();

/** The one-time token carried by a mode-1 link, if any. Non-consuming on
 * purpose: React StrictMode mounts an effect twice, and both passes must see
 * the same input. */
export function getCapturedPlatformRecoveryOtp(): PlatformRecoveryOtp | null {
  return capturedOtp;
}

/** The already-issued session carried by a mode-2 link, if any. */
export function getCapturedPlatformRecoveryTokens(): PlatformRecoveryTokens | null {
  return capturedTokens;
}

/** Supabase's own error code for a link that is expired/already used, or
 * `null` when the link carried no error. LATCHED for the whole page load:
 * `clearCapturedPlatformRecovery()` deliberately does not reset it, so a
 * second mount of the screen (React StrictMode, or a later in-app navigation
 * back to this route) still sees that the link was rejected instead of
 * falling through and evaluating whatever session is in storage. */
export function getCapturedPlatformRecoveryLinkError(): string | null {
  return capturedLinkError;
}

/** Whether this page load arrived with recovery-link material at all. The
 * screen REQUIRES this: without it, simply typing the URL while a stale
 * platform session sits in localStorage would open the password form and
 * allow a password change with neither the old password nor MFA. */
export function hadPlatformRecoveryLink(): boolean {
  return linkWasPresent;
}

/** Drops the in-memory copies once the link has been redeemed, so neither the
 * one-time token nor the tokens are retained beyond the call that needs them. */
export function clearCapturedPlatformRecovery(): void {
  capturedOtp = null;
  capturedTokens = null;
  // capturedLinkError and linkWasPresent are deliberately NOT reset - both are
  // verdicts about this page load, and a later mount must reach the same one.
}
