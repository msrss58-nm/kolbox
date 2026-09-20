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
 * THE FOUR DEDICATED LOGIN SCREENS.
 *
 * One shared component renders all four (see AuthLoginScreen), and every one
 * takes exactly a username and a password. Only the title differs - the
 * approved KOLBOX split-screen layout is literally the same implementation,
 * which is what makes "identical visual design" structural rather than a
 * promise. The realm is carried by the ROUTE, never chosen by the user and
 * never guessed from what they typed: there is no realm selector, no
 * workspace selector, no system code and no e-mail on any of them.
 */
export interface AuthRealmScreen {
  /** Sent to the server only as the choice of endpoint, never as a body field. */
  endpoint: string;
  title: string;
}

export const AUTH_REALM_SCREENS = {
  platformOwner: {
    endpoint: "/api/auth/login/platform-owner",
    title: "כניסה לקולבוקס - בעל הפלטפורמה",
  },
  electionOwner: {
    endpoint: "/api/auth/login/election-owner",
    title: "כניסה לקולבוקס - בעל המערכת",
  },
  multiEntityOwner: {
    endpoint: "/api/auth/login/multi-entity-owner",
    title: "כניסה לקולבוקס - בעל ריבוי מערכות",
  },
  users: {
    endpoint: "/api/auth/login/users",
    title: "כניסה לקולבוקס - משתמשים",
  },
} as const satisfies Record<string, AuthRealmScreen>;

export type AuthRealmKey = keyof typeof AUTH_REALM_SCREENS;

/** The target-origin confirmation screen. It performs NO second
 * authentication - it only confirms the resolved identity before a session is
 * created, so a session swap becomes visible and refusable. */
export const AUTH_CONFIRM_TEXT = {
  title: "אישור כניסה",
  subtitle: "ודאו שאלו הפרטים שלכם לפני הכניסה למערכת",
  continueAction: "המשך",
  cancelAction: "ביטול",
  cancelled: "הכניסה בוטלה",
  cancelledHint: "לא נוצרה התחברות. אפשר להתחיל מחדש ממסך הכניסה.",
  expired: "פג תוקף הבקשה",
  expiredHint: "הבקשה אינה זמינה יותר. התחילו מחדש ממסך הכניסה.",
  backToEntry: "חזרה למסך הכניסה",
  principalLabel: "סוג משתמש",
  contextLabel: "מערכת",
  identityLabel: "מזוהים בתור",
  realmNames: {
    worker: "משתמש מערכת",
    election_owner: "בעלי מערכת בחירות",
    platform_owner: "בעלי הפלטפורמה",
    multi_entity_owner: "בעלי מספר מערכות",
  } as Record<string, string>,
} as const;
