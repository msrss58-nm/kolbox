/**
 * Stage 3B - all Hebrew copy for the Election Owner activation and workspace
 * provisioning flow. No inline Hebrew literal belongs in these screens' JSX,
 * matching this project's "No hardcoded UI text" rule.
 */

export const OWNER_PROVISIONING_TEXT = {
  setPassword: {
    title: "הגדרת סיסמה לחשבון הבעלים",
    subtitle: "בחרו סיסמה אישית לחשבון שלכם. אף אחד מלבדכם לא יידע אותה.",
    checking: "מאמתים את הקישור...",
    invalidTitle: "הקישור אינו תקין",
    invalidBody:
      "הקישור פג תוקף או שכבר נעשה בו שימוש. פנו למנהל הפלטפורמה לקבלת קישור חדש.",
    passwordLabel: "סיסמה חדשה",
    confirmLabel: "אימות סיסמה",
    submit: "שמירת סיסמה",
    saving: "שומרים...",
    showPassword: "הצגת הסיסמה",
    hidePassword: "הסתרת הסיסמה",
    mismatch: "הסיסמאות אינן זהות",
    tooShort: "הסיסמה חייבת להכיל לפחות 8 תווים",
    successTitle: "הסיסמה נשמרה",
    successBody: "אפשר להתחבר עכשיו עם כתובת האימייל והסיסמה שבחרתם.",
    goToLogin: "מעבר להתחברות",
    networkError: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
    genericError: "אירעה שגיאה, נסו שוב",
  },

  setup: {
    title: "הקמת מערכת הבחירות",
    subtitle: "עוד שלב אחד ומערכת הבחירות שלכם מוכנה. הפרטים האלה ניתנים לשינוי בהמשך.",
    welcome: (name: string) => `שלום ${name},`,
    workspaceNameLabel: "שם מערכת הבחירות",
    workspaceNameHint: "לדוגמה: בחירות מודיעין 2026",
    electionEndLabel: "מועד סיום הבחירות",
    electionEndHint: "התאריך והשעה שבהם נסגרות הקלפיות",
    submit: "יצירת מערכת הבחירות",
    submitting: "יוצרים את המערכת...",
    missingName: "יש להזין שם למערכת הבחירות",
    missingEnd: "יש לבחור מועד סיום",
    expiredTitle: "תוקף ההרשאה פג",
    expiredBody: "ההרשאה שקיבלתם אינה בתוקף עוד. פנו למנהל הפלטפורמה לקבלת הרשאה חדשה.",
  },

  created: {
    title: "מערכת הבחירות נוצרה",
    subtitle: "שמרו את קוד המערכת - אנשי הצוות יזדקקו לו כדי להתחבר.",
    loginCodeLabel: "קוד המערכת",
    loginCodeHint:
      "הקוד אינו סיסמה. הוא מזהה את המערכת שאליה מתחברים, ואפשר למסור אותו בחופשיות לאנשי הצוות.",
    copy: "העתקה",
    copied: "הועתק",
    /** Platform Stage 9: no mandatory first-user step - the Owner goes
     * straight to administration. */
    nextHint:
      "בשלב הבא תגיעו לניהול המערכת. שם תוכלו ליצור מנהלים ומשתמשים - עכשיו או בכל זמן אחר.",
    continue: "המשך לניהול המערכת",
  },

  errors: {
    PENDING_ACCESS_NOT_FOUND: "לא נמצאה הרשאה פעילה עבור החשבון הזה.",
    PENDING_ACCESS_EXPIRED: "תוקף ההרשאה פג. פנו למנהל הפלטפורמה.",
    PENDING_ACCESS_ALREADY_CONSUMED: "ההרשאה כבר נוצלה.",
    /** Platform Stage 9: an approval without a recorded module choice. */
    APPROVAL_MODULES_MISSING:
      "ההרשאה שקיבלתם אינה כוללת בחירת מודולים, ולכן לא ניתן להקים את המערכת. פנו לבעל הפלטפורמה.",
    MISSING_WORKSPACE_NAME: "יש להזין שם למערכת הבחירות.",
    MISSING_ELECTION_END_AT: "יש לבחור מועד סיום.",
    WORKSPACE_NAME_TOO_LONG: "שם המערכת ארוך מדי.",
    UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
    SERVER_ERROR: "אירעה שגיאה, נסו שוב",
  } as Record<string, string>,
} as const;

export function ownerProvisioningError(code: string): string {
  return (
    OWNER_PROVISIONING_TEXT.errors[code] ?? OWNER_PROVISIONING_TEXT.errors.SERVER_ERROR
  );
}
