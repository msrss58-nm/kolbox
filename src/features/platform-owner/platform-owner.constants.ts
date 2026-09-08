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
