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
const MULTI_ENTITY_ORIGIN = "https://kolbox-multi-entity.vercel.app";
const AUTH_ORIGIN = "https://kolbox-auth.vercel.app";

export const KOLBOX_ORIGIN_URLS = {
  /** `/platform/mfa` has no entry on purpose - on the platform surface that
   * path is itself a redirect to the console, so the console IS its canonical
   * destination and the MFA architecture is untouched. */
  console: `${PLATFORM_ORIGIN}/platform`,
  login: `${PLATFORM_ORIGIN}/platform/login`,
  setPassword: `${PLATFORM_ORIGIN}/platform/set-password`,
  multiEntityLogin: `${MULTI_ENTITY_ORIGIN}/multi-entity/login`,
  /** The dedicated Multi-Entity login on the AUTH origin - the address a
   * Platform Owner sends to a new seat holder. Hard-coded like every other
   * entry here: a cross-origin destination that a misconfigured deployment
   * or a crafted URL could repoint is exactly what an origin split must not
   * have. */
  multiEntityLoginEntry: `${AUTH_ORIGIN}/login/multi-entity-owner`,
} as const;

export type KolboxOriginTarget = keyof typeof KOLBOX_ORIGIN_URLS;
