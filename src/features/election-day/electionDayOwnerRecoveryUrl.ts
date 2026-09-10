import { ROUTES } from "../../constants/routes";

/**
 * Stage 3B - Election Owner activation-link capture.
 *
 * The Election Owner's one-time link is the DIRECT form:
 *   /election-day/owner-set-password?token_hash=<hashed_token>&type=recovery
 * minted by api/platform/session.ts (op=create_owner_access) from
 * generateLink()'s `hashed_token`, and redeemed here with verifyOtp().
 *
 * WHY THE DIRECT FORM, AND WHY THIS MODULE STILL EXISTS
 *
 * The direct link never touches GoTrue's /verify endpoint, so it does not
 * depend on the project's Site URL or its Redirect URLs allow-list (which on
 * this project still point at localhost and would silently swallow a
 * redirect), and it never puts an `#access_token=...` fragment on our origin.
 * That removes the worst version of the cross-identity hazard - but not all
 * of it, so the capture below is still done explicitly rather than left to
 * chance:
 *
 * CROSS-IDENTITY LEAKAGE. This app constructs several Supabase clients
 * (client.ts campaign, ownerAuthClient.ts Election Owner,
 * platformOwnerAuthClient.ts Platform Owner). Every one auto-initializes with
 * `detectSessionInUrl` at its default of `true`, so any auth material left in
 * the URL is fair game for whichever module the bundler happens to evaluate
 * first. On the Election surface BOTH the campaign client and the Election
 * Owner client are live, so a token landing here must be taken out of the URL
 * deliberately and handed to exactly one client, not left for a race to
 * resolve. This mirrors platformOwnerRecoveryUrl.ts exactly - same reasoning,
 * same pathname-scoped guard, same unconditional strip.
 *
 * Scope guard: capture fires ONLY on the Election Owner set-password
 * pathname. Every other route - the campaign app's own magic-link landings,
 * the PermissionUser login, the Platform surface - is left completely
 * untouched, so this module can never swallow another identity's callback.
 *
 * Nothing here is authority. Everything captured is unverified input from a
 * URL; OwnerSetPasswordScreen proves it against the server (verifyOtp, then
 * getUser) before showing the form. Nothing is logged or persisted - only
 * module-level in-memory variables and history.replaceState.
 */

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

export interface CapturedOwnerOtp {
  tokenHash: string;
  type: "recovery" | "invite";
}

export interface CapturedOwnerTokens {
  accessToken: string;
  refreshToken: string;
}

let capturedOtp: CapturedOwnerOtp | null = null;
let capturedTokens: CapturedOwnerTokens | null = null;
let capturedLinkError: string | null = null;
let linkWasPresent = false;

function isPasswordSetLinkType(v: string | null): v is "recovery" | "invite" {
  return v === "recovery" || v === "invite";
}

function isOwnerSetPasswordPath(pathname: string): boolean {
  return (
    pathname.replace(/\/+$/, "").toLowerCase() === ROUTES.electionDayOwnerSetPassword
  );
}

function capture(): void {
  if (typeof window === "undefined") return;
  if (!isOwnerSetPasswordPath(window.location.pathname)) return;

  const queryParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(
    window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "",
  );
  const read = (key: string) => queryParams.get(key) ?? hashParams.get(key);

  capturedLinkError = read("error_code") ?? read("error");

  const type = read("type");
  if (isPasswordSetLinkType(type)) {
    const tokenHash = read("token_hash");
    const accessToken = read("access_token");
    const refreshToken = read("refresh_token");
    if (tokenHash) {
      capturedOtp = { tokenHash, type };
    } else if (accessToken && refreshToken) {
      // Legacy implicit-fragment form. Not what this project mints, but
      // handled so such a link is consumed here rather than by whichever
      // other Supabase client on this origin gets there first.
      capturedTokens = { accessToken, refreshToken };
    }
  }

  linkWasPresent =
    capturedOtp !== null || capturedTokens !== null || capturedLinkError !== null;

  // Strip unconditionally, whether or not anything was captured, and via
  // replaceState so no history entry retains the token.
  const url = new URL(window.location.href);
  for (const key of AUTH_PARAM_KEYS) url.searchParams.delete(key);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

capture();

/* Getters are deliberately NON-consuming, so React StrictMode's double mount
 * does not make the second read come back empty. */
export function getCapturedOwnerRecoveryOtp(): CapturedOwnerOtp | null {
  return capturedOtp;
}

export function getCapturedOwnerRecoveryTokens(): CapturedOwnerTokens | null {
  return capturedTokens;
}

export function getCapturedOwnerRecoveryLinkError(): string | null {
  return capturedLinkError;
}

/**
 * Whether this page load arrived with activation-link material at all. The
 * screen REQUIRES this: without it, simply typing the URL while a stale Owner
 * session sits in localStorage would open the password form and allow a
 * password change with no proof of the link at all.
 */
export function hadOwnerRecoveryLink(): boolean {
  return linkWasPresent;
}

/** Clears the redeemable material once used. Deliberately does NOT reset
 * `capturedLinkError`/`linkWasPresent` - the screen still needs to know how
 * this page load arrived after the material is spent. */
export function clearCapturedOwnerRecovery(): void {
  capturedOtp = null;
  capturedTokens = null;
}
