/** Copy for the KOLBOX Auth origin (entry + handoff + confirmation). */
export const AUTH_ENTRY_TEXT = {
  subtitle: "הזינו את פרטי הכניסה שלכם",
  usernameLabel: "שם משתמש",
  passwordLabel: "סיסמה",
  submit: "התחברות",
  showPassword: "הצג סיסמה",
  hidePassword: "הסתר סיסמה",
  /** ONE message for every failure cause - unknown user, wrong password, a
   * username that belongs to a different realm, rate limiting. Nothing here
   * may ever reveal which. */
  genericFailure: "פרטי הכניסה שגויים",
  networkFailure: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
  continuing: "מעבירים אתכם…",
} as const;

/**
 * THE TWO LOGIN SCREENS. There are exactly two, and this map is the whole
 * list.
 *
 * `shared` is where every principal except the Platform Owner signs in -
 * Election Owner, Multi-Entity Owner, Manager and ordinary user alike. Its
 * title is deliberately GENERIC: the screen must not ask, hint at, or even
 * name which kind of user is typing, because nothing about the principal is
 * taken from the request. The server resolves it from the username directory
 * after the credential is verified, and routes accordingly.
 *
 * `platformOwner` keeps its own screen. That is not a leftover: it is the one
 * principal that administers the platform itself, its username never competes
 * with a tenant's in the shared directory lookup, and its credential is never
 * posted to the endpoint tenants use.
 *
 * One component renders both (see AuthLoginScreen) and each takes exactly a
 * username and a password, so the approved KOLBOX split-screen layout is the
 * same implementation rather than a promise to keep two in step. There is no
 * realm selector, no workspace selector, no system code and no e-mail field
 * on either.
 */
export interface AuthRealmScreen {
  /** Sent to the server only as the choice of endpoint, never as a body field. */
  endpoint: string;
  title: string;
}

export const AUTH_REALM_SCREENS = {
  shared: {
    endpoint: "/api/auth/login",
    title: "התחברות",
  },
  platformOwner: {
    endpoint: "/api/auth/login/platform-owner",
    title: "כניסה לקולבוקס - בעל הפלטפורמה",
  },
} as const satisfies Record<string, AuthRealmScreen>;

export type AuthRealmKey = keyof typeof AUTH_REALM_SCREENS;

/** Leg 2's copy. There is no longer a confirmation screen: the handoff
 * completes automatically, so the only strings left are the FAIL-CLOSED ones
 * shown when no session could be created and the visitor must start again.
 * The former confirmation copy - title, subtitle, Continue/Cancel and the
 * identity labels - was deleted with the screen rather than left to rot. */
export const AUTH_CONFIRM_TEXT = {
  expired: "פג תוקף הבקשה",
  expiredHint: "הבקשה אינה זמינה יותר. התחילו מחדש ממסך הכניסה.",
  backToEntry: "חזרה למסך הכניסה",
} as const;
