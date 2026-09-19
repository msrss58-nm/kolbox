/** Copy for the KOLBOX Auth origin (entry + handoff + confirmation). */
export const AUTH_ENTRY_TEXT = {
  title: "כניסה לקולבוקס",
  subtitle: "הזינו את פרטי הכניסה שלכם",
  identifierLabel: "אימייל או שם משתמש",
  passwordLabel: "סיסמה",
  workspaceCodeLabel: "קוד מערכת",
  workspaceCodeHint: "הקוד שקיבלתם ממנהל המערכת",
  workspaceCodeFromLinkHint: "הקוד מולא אוטומטית מהקישור",
  staffToggle: "כניסת צוות עם קוד מערכת",
  staffToggleOff: "כניסה עם אימייל",
  submit: "התחברות",
  showPassword: "הצג סיסמה",
  hidePassword: "הסתר סיסמה",
  /** ONE message for every failure cause - unknown user, wrong password,
   * wrong system code, an account that belongs to no realm, rate limiting.
   * Nothing here may ever reveal which. */
  genericFailure: "פרטי הכניסה שגויים",
  networkFailure: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
  continuing: "מעבירים אתכם…",
} as const;

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
