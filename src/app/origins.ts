/**
 * The canonical KOLBOX origins, in ONE place.
 *
 * ORIGIN SEPARATION is a deliberate security control, not a deployment
 * accident: Chrome scopes saved credentials by origin (`signon_realm`), so
 * while two principals' login forms share an origin, one principal's saved
 * credential is a fill candidate on the other's form. No in-page attribute
 * prevents that. `VITE_APP_SURFACE` therefore constant-folds the router at
 * BUILD time and each deployment ships only its own routes - the other
 * principal's login screen is not merely hidden but absent from the bundle.
 *
 * That is why the unified entry screen can render the two realms that already
 * share the election origin (PermissionUser, Election Owner) but can only LINK
 * to the Platform and Multi-Entity origins: hosting their credential fields
 * here would undo the control above.
 *
 * HARD-CODED, never read from an env var or anything derived from the address
 * bar: a cross-origin destination a misconfigured deployment (or a crafted
 * URL) could repoint is exactly what an origin split must not have. Consumers
 * take a KEY from this map, never a URL, so an open redirect is structurally
 * impossible rather than merely filtered.
 */
const PLATFORM_ORIGIN = "https://kolbox-platform.vercel.app";
const AUTH_ORIGIN = "https://kolbox-auth.vercel.app";

export const KOLBOX_ORIGIN_URLS = {
  /** `/platform/mfa` has no entry on purpose - on the platform surface that
   * path is itself a redirect to the console, so the console IS its canonical
   * destination and the MFA architecture is untouched. */
  console: `${PLATFORM_ORIGIN}/platform`,
  /** THE Platform Owner login - one of the two KOLBOX login screens, and it
   * lives on the auth origin like the other one. */
  login: `${AUTH_ORIGIN}/login/platform-owner`,
  setPassword: `${PLATFORM_ORIGIN}/platform/set-password`,
  /** THE shared login - the single address every principal except the
   * Platform Owner is sent to, whoever they are. It is deliberately the same
   * URL for an Election Owner, a Multi-Entity Owner, a Manager and an
   * ordinary user: handing someone a realm-specific address would be a realm
   * chooser with extra steps, and the server resolves the principal anyway.
   * Hard-coded like every other entry here: a cross-origin destination a
   * misconfigured deployment or a crafted URL could repoint is exactly what
   * an origin split must not have. */
  sharedLogin: `${AUTH_ORIGIN}/login`,
} as const;

export type KolboxOriginTarget = keyof typeof KOLBOX_ORIGIN_URLS;
