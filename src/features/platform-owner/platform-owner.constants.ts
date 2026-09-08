/**
 * Platform Stage 2: every Hebrew string on the Platform Owner surface.
 * House rule (CLAUDE.md, "No hardcoded UI text") - no Hebrew literal may
 * appear inline in this feature's JSX.
 */

/** Friendly name attached to the Platform Owner's TOTP factor, so the factor
 * is identifiable in an authenticator app / in Supabase's own factor list.
 * Not user-visible copy - kept here so the enrollment flow has exactly one
 * source of truth for it. */
export const PLATFORM_OWNER_MFA_FACTOR_NAME = "KolBox Platform Owner";

/** Platform Stage 2 (password set/recovery): minimum length for the Platform
 * Owner's password. Deliberately well above the campaign app's bar - this is
 * the single most privileged identity in the system. Enforced client-side by
 * `platformOwnerPasswordPolicy.ts` (a quality gate, not a security boundary -
 * Supabase's own project policy is the server-side authority) and quoted in
 * the Hebrew rule list below, so the number has exactly one definition. */
export const PLATFORM_OWNER_PASSWORD_MIN_LENGTH = 12;

/** Platform Stage 2 (password set/recovery): hard upper bound, in BYTES.
 * bcrypt - which GoTrue uses - silently truncates beyond 72 bytes, and the
 * server rejects longer input with `validation_failed`. Enforced client-side
 * so a long passphrase gets a specific Hebrew message instead of a dead-end
 * generic error. Bytes, not characters: Hebrew is 2 bytes per letter in UTF-8. */
export const PLATFORM_OWNER_PASSWORD_MAX_BYTES = 72;

export const PLATFORM_OWNER_TEXT = {
  login: {
    title: "כניסת בעל הפלטפורמה",
    subtitle: "כניסה מאובטחת עם אימות דו-שלבי",
    emailLabel: "אימייל",
    passwordLabel: "סיסמה",
    showPassword: "הצג סיסמה",
    hidePassword: "הסתר סיסמה",
    submit: "התחברות",
    errors: {
      invalidCredentials: "פרטי ההתחברות שגויים",
      network: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
      generic: "אירעה שגיאה, נסו שוב",
    },
  },

  /** Platform Stage 2 (password set/recovery): the `/platform/set-password`
   * screen. Reachable only via a Supabase recovery/invite link; it grants no
   * console access of its own - see `PlatformOwnerSetPasswordScreen.tsx`. */
  setPassword: {
    title: "הגדרת סיסמה חדשה",
    subtitle: "בחרו סיסמה חדשה לחשבון בעל הפלטפורמה",
    checking: "מאמתים את הקישור...",
    passwordLabel: "סיסמה חדשה",
    confirmLabel: "אימות סיסמה חדשה",
    showPassword: "הצג סיסמה",
    hidePassword: "הסתר סיסמה",
    submit: "שמירת הסיסמה",
    rulesTitle: "דרישות הסיסמה",
    rules: [
      `לפחות ${PLATFORM_OWNER_PASSWORD_MIN_LENGTH} תווים`,
      "אות גדולה ואות קטנה באנגלית",
      "לפחות ספרה אחת",
      "לפחות תו מיוחד אחד",
    ],
    invalid: {
      title: "הקישור אינו תקף",
      body: "קישור הגדרת הסיסמה פג תוקף, כבר נעשה בו שימוש, או שאינו שייך לחשבון בעל הפלטפורמה. בקשו קישור חדש ונסו שוב.",
      backToLogin: "חזרה למסך הכניסה",
    },
    success: {
      title: "הסיסמה עודכנה",
      body: "התחברו מחדש עם הסיסמה החדשה. גם לאחר העדכון נדרש אימות דו-שלבי כרגיל.",
      continue: "המשך למסך הכניסה",
    },
    errors: {
      tooShort: `הסיסמה חייבת להכיל לפחות ${PLATFORM_OWNER_PASSWORD_MIN_LENGTH} תווים`,
      missingLower: "הסיסמה חייבת להכיל אות קטנה באנגלית",
      missingUpper: "הסיסמה חייבת להכיל אות גדולה באנגלית",
      missingDigit: "הסיסמה חייבת להכיל לפחות ספרה אחת",
      missingSymbol: "הסיסמה חייבת להכיל לפחות תו מיוחד אחד",
      tooLong: `הסיסמה ארוכה מדי - עד ${PLATFORM_OWNER_PASSWORD_MAX_BYTES} תווים`,
      mismatch: "הסיסמאות אינן תואמות",
      sameAsOld: "הסיסמה החדשה חייבת להיות שונה מהסיסמה הקודמת",
      weak: "הסיסמה נדחתה על ידי מדיניות האבטחה. בחרו סיסמה חזקה יותר",
      reauthNeeded:
        "נדרש אימות מחדש לפני שינוי הסיסמה. בקשו קישור חדש והשלימו את התהליך מיד",
      insufficientAal:
        "עדכון הסיסמה דורש אימות דו-שלבי. התחברו למסך הכניסה, השלימו את האימות הדו-שלבי, ורק אז שנו את הסיסמה",
      network: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
      generic: "לא הצלחנו לעדכן את הסיסמה. נסו שוב",
    },
  },

  mfa: {
    enroll: {
      title: "הגדרת אימות דו-שלבי",
      subtitle: "סרקו את הקוד באפליקציית האימות ולאחר מכן הזינו את הקוד בן 6 הספרות",
      qrAlt: "קוד QR להגדרת אימות דו-שלבי",
      manualLabel: "מפתח ידני להזנה באפליקציית האימות",
      loading: "מכינים את ההגדרה...",
      enrollError: "לא הצלחנו להתחיל את תהליך האימות. נסו שוב",
      retry: "נסו שוב",
    },
    challenge: {
      title: "אימות דו-שלבי",
      subtitle: "הזינו את הקוד בן 6 הספרות מאפליקציית האימות",
    },
    codeLabel: "קוד אימות",
    submit: "אימות",
    errors: {
      invalidCode: "הקוד שגוי או פג תוקפו. נסו שוב",
      noFactor: "לא נמצא אמצעי אימות. רעננו את הדף ונסו שוב",
      generic: "אירעה שגיאה, נסו שוב",
    },
  },

  forbidden: {
    title: "אין הרשאת גישה",
    body: "החשבון עבר אימות דו-שלבי אך אינו רשום כבעל הפלטפורמה. פנו לבעל הפלטפורמה הרשום.",
    logout: "התנתקות",
  },

  error: {
    title: "לא הצלחנו לאמת את ההרשאות",
    body: "ייתכן שאין חיבור לאינטרנט או שהשירות אינו זמין כרגע.",
    retry: "נסו שוב",
    logout: "התנתקות",
  },

  console: {
    title: "מסוף בעל הפלטפורמה",
    signedInAs: (email: string) => `מחובר כ-${email}`,
    identityTitle: "זהות מאומתת",
    ownerIdLabel: "מזהה בעל פלטפורמה",
    emailLabel: "אימייל",
    mfaLabel: "רמת אימות",
    mfaValue: "aal2 - אימות דו-שלבי פעיל",
    stageNote: "שלב זה מאמת זהות והרשאות בלבד. ניהול סביבות עבודה יתווסף בשלב הבא.",
    logout: "התנתקות",
  },
} as const;
