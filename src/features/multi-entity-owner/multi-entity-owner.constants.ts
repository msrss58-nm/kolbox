import { PLATFORM_OWNER_PASSWORD_MIN_LENGTH } from "../platform-owner/platform-owner.constants";

/**
 * Platform Stage 5: every Hebrew string on the Multi-Entity Owner surface.
 * House rule (CLAUDE.md, "No hardcoded UI text") - no Hebrew literal may
 * appear inline in this feature's JSX. Terminology follows Stage 4B: the
 * principal is "בעל רב-מערכות", a workspace is a "מערכת בחירות".
 */

/** Friendly name attached to the Multi-Entity Owner's TOTP factor. Not
 * user-visible copy - kept here so enrollment has one source of truth. */
export const MULTI_ENTITY_OWNER_MFA_FACTOR_NAME = "KolBox Multi-Entity Owner";

export const MULTI_ENTITY_OWNER_TEXT = {
  login: {
    title: "כניסת בעל רב-מערכות",
    subtitle: "כניסה מאובטחת עם אימות דו-שלבי",
    emailLabel: "אימייל",
    passwordLabel: "סיסמה",
    showPassword: "הצג סיסמה",
    hidePassword: "הסתר סיסמה",
    submit: "התחברות",
    errors: {
      invalidCredentials: "פרטי ההתחברות שגויים",
      network: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
    },
  },

  /** The `/multi-entity/set-password` screen - reachable only from the
   * one-time link the Platform Owner hands over. Grants no access itself. */
  setPassword: {
    title: "קביעת סיסמה",
    subtitle: "בחרו סיסמה לחשבון בעל רב-המערכות",
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
      body: "הקישור לקביעת סיסמה פג תוקף, כבר נעשה בו שימוש, או שאינו תקין. בקשו מבעל הפלטפורמה קישור חדש.",
      backToLogin: "חזרה למסך הכניסה",
    },
    success: {
      title: "הסיסמה נשמרה",
      body: "התחברו עם הסיסמה החדשה. בכניסה הראשונה תתבקשו להגדיר אימות דו-שלבי.",
      continue: "המשך למסך הכניסה",
    },
    errors: {
      tooShort: `הסיסמה חייבת להכיל לפחות ${PLATFORM_OWNER_PASSWORD_MIN_LENGTH} תווים`,
      missingLower: "הסיסמה חייבת להכיל אות קטנה באנגלית",
      missingUpper: "הסיסמה חייבת להכיל אות גדולה באנגלית",
      missingDigit: "הסיסמה חייבת להכיל לפחות ספרה אחת",
      missingSymbol: "הסיסמה חייבת להכיל לפחות תו מיוחד אחד",
      tooLong: "הסיסמה ארוכה מדי",
      mismatch: "הסיסמאות אינן תואמות",
      sameAsOld: "הסיסמה החדשה חייבת להיות שונה מהסיסמה הקודמת",
      weak: "הסיסמה נדחתה על ידי מדיניות האבטחה. בחרו סיסמה חזקה יותר",
      reauthNeeded:
        "נדרש אימות מחדש לפני שינוי הסיסמה. בקשו קישור חדש והשלימו את התהליך מיד",
      insufficientAal:
        "לחשבון כבר מוגדר אימות דו-שלבי, ולכן לא ניתן לשנות את הסיסמה מקישור זה. פנו לבעל הפלטפורמה.",
      network: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
      generic: "לא הצלחנו לשמור את הסיסמה. נסו שוב",
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
    body: "החשבון עבר אימות דו-שלבי אך אינו רשום כבעל רב-המערכות הנוכחי. ייתכן שההרשאה הוחלפה או בוטלה. פנו לבעל הפלטפורמה.",
    logout: "התנתקות",
  },

  error: {
    title: "לא הצלחנו לאמת את ההרשאות",
    body: "ייתכן שאין חיבור לאינטרנט או שהשירות אינו זמין כרגע.",
    retry: "נסו שוב",
    logout: "התנתקות",
  },

  home: {
    title: "המערכות שלי",
    signedInAs: (name: string) => `מחובר כ-${name}`,
    count: (n: number) => (n === 1 ? "מערכת משויכת אחת" : `${n} מערכות משויכות`),
    endsAtLabel: "מועד סיום הבחירות",
    assignedAtLabel: "שויכה בתאריך",
    emptyTitle: "אין מערכות משויכות",
    emptyHint: "בעל הפלטפורמה טרם שייך אליכם מערכות בחירות. לאחר השיוך הן יופיעו כאן.",
    refresh: "רענון",
    logout: "התנתקות",
    stageNote:
      "מוצגת כאן רשימת המערכות שאליהן יש לכם הרשאה בלבד. צפייה בנתוני המערכות תתווסף בשלב מאוחר יותר.",
  },
} as const;
