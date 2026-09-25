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

/** Whether the Platform Owner console demands a second factor before it will
 * render, i.e. whether `platformOwnerSession.refreshStatus()` diverts an
 * `aal1` session into the enrollment/challenge screens.
 *
 * Currently FALSE by product decision: sign-in completes with username +
 * password and the TOTP screen is never shown. Nothing was deleted -
 * `PlatformOwnerMfaEnrollScreen`, `PlatformOwnerMfaChallengeScreen`, the
 * store's `enrollMfa`/`verifyMfa` actions and the guard's `mfa_enroll`/
 * `mfa_challenge` branches all remain, simply unreachable while this is
 * false. Re-enabling is this one constant plus its server-side twin.
 *
 * MUST BE KEPT IN SYNC with PLATFORM_OWNER_MFA_REQUIRED in
 * `api/election-day/_platformAuth.ts`, which is the actual security
 * boundary - this constant only decides which screen renders. */
export const PLATFORM_OWNER_MFA_REQUIRED = false;

/** Platform Stage 2 (password set/recovery): minimum length for the Platform
 * Owner's password. KOLBOX no longer defines a password policy of its own -
 * no minimum length, no maximum and no character classes, for this or any
 * other identity. `platformOwnerPasswordPolicy.ts` checks only that something
 * was typed and that the confirmation matches; the auth provider is the sole
 * authority on what it accepts. */

export const PLATFORM_OWNER_TEXT = {
  login: {
    title: "כניסת בעל הפלטפורמה",
    subtitle: "כניסה מאובטחת לניהול הפלטפורמה",
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
    invalid: {
      title: "הקישור אינו תקף",
      body: "קישור הגדרת הסיסמה פג תוקף, כבר נעשה בו שימוש, או שאינו שייך לחשבון בעל הפלטפורמה. בקשו קישור חדש ונסו שוב.",
      backToLogin: "חזרה למסך הכניסה",
    },
    success: {
      title: "הסיסמה עודכנה",
      body: "התחברו מחדש עם הסיסמה החדשה.",
      continue: "המשך למסך הכניסה",
    },
    errors: {
      empty: "יש להזין סיסמה",
      /** NOT a KOLBOX rule: the auth provider itself refuses a password over
       * 72 BYTES (bcrypt's own ceiling - Hebrew costs 2 bytes per letter).
       * Shown only when the provider actually refuses one. */
      tooLong: "ספק האימות דחה את הסיסמה - עד 72 בייטים",
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
    body: "החשבון אינו רשום כבעל הפלטפורמה. פנו לבעל הפלטפורמה הרשום.",
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
    usernameLabel: "שם משתמש לכניסה",
    usernameUnset: "טרם הוגדר",
    approvalUsernameLabel: "שם משתמש לכניסה",
    approvalUsernameHint:
      "השם שבעל המערכת יזין במסך הכניסה. חייב להיות ייחודי בין בעלי המערכות.",
    approvalUsernameRequired: "יש להזין שם משתמש לכניסה",
    approvalUsernameTaken: "שם המשתמש תפוס",
    approvalUsernameSuggestion: (n: string) => `השם הפנוי הבא: ${n}`,
    approvalUsernameUseSuggestion: "השתמשו בשם המוצע",
    usernameSet: "הגדרת שם משתמש",
    usernameSave: "שמירה",
    usernameCancel: "ביטול",
    usernamePlaceholder: "לדוגמה: נחום משה",
    usernameHint: "זהו שם המשתמש לכניסה בכתובת בעל הפלטפורמה. ניתן להגדיר פעם אחת בלבד.",
    usernameSaved: "שם המשתמש נשמר",
    usernameTaken: "שם המשתמש תפוס",
    usernameSuggestion: (name: string) => `השם הפנוי הבא: ${name}`,
    usernameUseSuggestion: "השתמשו בשם המוצע",
    usernameInvalid: "שם המשתמש אינו תקין. אסור להשתמש ב-@ וברווח כפול.",
    usernameError: "שמירת שם המשתמש נכשלה",
    emailLabel: "אימייל",
    mfaLabel: "רמת אימות",
    mfaValue: "כניסה עם סיסמה - אימות דו-שלבי אינו נדרש",
    stageNote:
      "אישור בעלים יוצר חשבון ללא סיסמה ומפיק קישור חד-פעמי. הסיסמה נבחרת על ידי הבעלים בלבד.",
    logout: "התנתקות",

    /** Changing the console operator's OWN password. */
    passwordTitle: "החלפת הסיסמה שלי",
    passwordOpen: "החלפת סיסמה",
    passwordCurrent: "הסיסמה הנוכחית",
    passwordNew: "סיסמה חדשה",
    passwordConfirm: "אימות הסיסמה החדשה",
    passwordSubmit: "שמירת הסיסמה",
    passwordCancel: "ביטול",
    passwordSaved: "הסיסמה עודכנה",
    passwordHint:
      "נדרשת הסיסמה הנוכחית. הסיסמה הקיימת אינה ניתנת לצפייה.",
    passwordErrors: {
      INVALID_CURRENT_PASSWORD: "הסיסמה הנוכחית שגויה",
      SAME_PASSWORD: "הסיסמה החדשה חייבת להיות שונה מהנוכחית",
      WEAK_PASSWORD: "הסיסמה אינה עומדת בדרישות",
      MISMATCH: "הסיסמאות אינן תואמות",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** The console's side navigation (one route per section). */
  shell: {
    nav: {
      workspaces: "מערכות בחירות",
      multiEntity: "רב-מערכות",
      audit: "יומן פעולות",
      settings: "הגדרות",
    },
  },

  /**
   * The ONE management section: every election system, whether it already
   * exists or is still an approved owner waiting to create it, with the
   * owner, status, modules and every action that used to live on a separate
   * "בעלי מערכות" screen.
   */
  workspaces: {
    title: "מערכות בחירות",
    description:
      "כל מערכות הבחירות בפלטפורמה - הבעלים שלהן, מצבן והמודולים הפעילים בהן. מערכת שטרם הוקמה מופיעה כאן מרגע אישור הבעלים.",
    search: "חיפוש לפי שם מערכת, בעלים, אימייל או קוד מערכת",
    empty: "אין מערכות בחירות",
    noResults: "לא נמצאו מערכות התואמות לחיפוש",
    approve: "אישור בעלים חדש",
    count: (shown: number, total: number) =>
      shown === total ? `${total} מערכות` : `${shown} מתוך ${total} מערכות`,
    columns: {
      name: "מערכת",
      owner: "בעלים",
      status: "מצב",
      modules: "מודולים",
    },
    filterLabel: "סינון לפי מצב",
    filterAll: "כל המצבים",
    filterActive: "מערכות פעילות",
    filterEnded: "מערכות שהסתיימו",
    filterPending: "ממתינות להרשמה",
    filterExpired: "הרשאה שפג תוקפה",
    filterDone: "הרשמה הושלמה",
    details: "פרטים",
    detailsAria: (name: string) => `פרטי ${name}`,
    ownerLabel: "בעלים",
    ownerEmailLabel: "אימייל הבעלים",
    ownerPhoneLabel: "טלפון הבעלים",
    noOwner: "לא משויך בעלים",
    noPhone: "לא הוזן",
    codeLabel: "קוד מערכת",
    endLabel: "סיום הבחירות",
    statusLabel: "מצב",
    modulesLabel: "מודולים פעילים",
    multiEntityLabel: "שיוך לבעל רב-מערכות",
    notAvailable: "לא זמין כרגע",
    editModules: "עריכת מודולים",
    /** A workspace that does not exist yet: the owner is approved and the
     * system itself is created by them on first sign-in. */
    notCreated: "המערכת טרם הוקמה",
    notCreatedHint: "המערכת תיווצר על ידי הבעלים בכניסה הראשונה.",
    approvalLabel: "מצב ההרשאה",
    requestedModulesLabel: "מודולים שנבחרו באישור",
  },

  /** The Election Owner's own account, as the console may act on it. */
  ownerAccount: {
    open: "עריכת בעל המערכת",
    title: (name: string) => `בעל המערכת - ${name}`,
    loading: "טועןים את פרטי הבעלים...",
    loadError: "לא הצלחנו לטעון את פרטי הבעלים.",
    detailsTitle: "פרטי הבעלים",
    detailsHint:
      "פרטים אלה נשמרים ברשומת הבעלים של המערכת. שינוי נרשם ביומן הפעולות.",
    detailsSave: "שמירת פרטי הבעלים",
    detailsSaved: "פרטי הבעלים עודכנו",
    phoneHint: "מספר ישראלי. ניתן להשאיר ריק.",
    nameLabel: "שם הבעלים",
    emailLabel: "אימייל",
    phoneLabel: "טלפון",
    noPhone: "לא הוזן",

    usernameTitle: "שם משתמש לכניסה",
    usernameLabel: "שם משתמש",
    usernameHint:
      "השם שהבעלים מזין במסך הכניסה. שינוי משחרר את השם הקודם לשימוש אחר.",
    usernameUnset: "טרם הוגדר",
    usernameSave: "שמירת שם המשתמש",
    usernameSaved: "שם המשתמש עודכן",

    passwordTitle: "קביעת סיסמה חדשה",
    passwordLabel: "סיסמה חדשה",
    passwordHint:
      "הסיסמה הקיימת אינה ניתנת לצפייה - ניתן רק לקבוע אחת חדשה.",
    passwordShow: "הצג סיסמה",
    passwordHide: "הסתר סיסמה",
    passwordSave: "קביעת הסיסמה",
    passwordSaved:
      "הסיסמה עודכנה. מסרו אותה לבעלים בערוץ מאובטח.",
    passwordEmpty: "יש להזין סיסמה",

    loginTitle: "כתובת הכניסה של הבעלים",
    loginHint:
      "זו כתובת הכניסה למערכת שלהם. הבעלים נכנסים בשם המשתמש ובסיסמה שלהם.",
    loginCopy: "העתקת כתובת הכניסה",
    loginCopied: "הכתובת הועתקה",
    close: "סגירה",
    errors: {
      OWNER_NOT_FOUND:
        "לא נמצא בעלים למערכת זו. רעננו את הדף.",
      USERNAME_TAKEN: "שם המשתמש תפוס",
      USERNAME_ALREADY_SET: "שם המשתמש כבר מוגדר עבור חשבון זה",
      INVALID_NAME: "יש להזין שם בעלים",
      INVALID_EMAIL: "יש להזין כתובת אימייל תקינה",
      INVALID_PHONE: "יש להזין מספר טלפון ישראלי תקין",
      INVALID_USERNAME:
        "שם המשתמש אינו תקין. אסור להשתמש ב-@ וברווח כפול.",
      WEAK_PASSWORD: "הסיסמה נדחתה. בחרו סיסמה ארוכה יותר.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** Permanent deletion of an election system. Deliberately the only place in
   * the console that speaks in these terms: the copy has to say what actually
   * happens, because nothing here can be undone afterwards. */
  deleteWorkspace: {
    /** The grouping the destructive action sits under, inside the details view. */
    advancedTitle: "פעולות מתקדמות",
    advancedHint: "פעולות בלתי הפיכות. קראו את האזהרה לפני הביצוע.",
    open: "מחיקת מערכת הבחירות",
    title: (name: string) => `מחיקת מערכת הבחירות - ${name}`,
    warningTitle: "הפעולה הזו אינה ניתנת לביטול",
    /** What goes, stated as a list rather than as one long sentence: an
     * operator about to delete a live system should be able to scan it. */
    warningItems: [
      "כל נתוני יום הבחירות של המערכת - בוחרים, נסיעות, תזכורות ודוחות",
      "המשתמשים והתפקידים של המערכת, וכל הסיסמאות שלהם",
      "נתוני התקציב של המערכת, אם קיימים",
      "הרשאת הבעלים ושם המשתמש שלו - השם משתחרר לשימוש חדש",
      "השיוך של המערכת לבעלי רב-מערכות",
    ],
    /** The two things that deliberately survive. Saying so is part of being
     * honest about what deletion means. */
    keptTitle: "מה נשמר",
    keptItems: [
      "רישום המחיקה עצמה - שם המערכת, הבעלים והמועד - נשמר לצמיתות ואינו ניתן לשינוי",
      "יומן הפעולות ההיסטורי של המערכת נשמר",
    ],
    /** The system is CHOSEN from the real list, not typed - so a name that
     * does not exist, or a near-miss of one that does, is not expressible. */
    selectLabel: "בחרו את מערכת הבחירות למחיקה",
    selectPlaceholder: "בחרו מערכת",
    selectEmpty: "אין מערכות בחירות למחיקה",
    /** What the chosen system actually holds, read from the server. */
    inspecting: "בודקים מה המערכת מכילה...",
    inspectError: "לא הצלחנו לבדוק את תוכן המערכת.",
    contentsTitle: "תוכן המערכת",
    contents: (rows: number) => `${rows} רשומות יימחקו`,
    contentsEmpty: "המערכת אינה מכילה נתונים",
    contentsRow: (table: string, n: number) => `${table}: ${n}`,
    /** Budget data does not block deletion - it only adds a prerequisite. */
    budgetTitle: "נתוני תקציב",
    budgetNeedsExport:
      "למערכת יש נתוני תקציב. לפני המחיקה יש לייצא אותם ולשמור אותם אצלכם - זו הדרישה שמגנה על הנתונים, והמחיקה לא תתאפשר בלעדיה.",
    budgetExport: "ייצוא נתוני התקציב ושמירה בתיקייה",
    budgetExporting: (done: number, total: number) =>
      `מייצא... ${done} מתוך ${total}`,
    budgetReady: "הייצוא הושלם ואומת. ניתן להמשיך למחיקה.",
    budgetAlreadyReady: "קיים ייצוא מאומת ועדכני. ניתן להמשיך למחיקה.",
    budgetNone: "למערכת אין נתוני תקציב",
    budgetUnsupported:
      "ייצוא לתיקייה נתמך ב-Chrome או Edge במחשב. פתחו את המסוף בדפדפן כזה כדי להשלים את הייצוא.",
    budgetExportFailed: "הייצוא לא הושלם. המערכת לא נמחקה ולא השתנתה.",
    /** Step 2: the final, named warning. */
    continueLabel: "המשך למחיקה",
    back: "חזרה",
    aboutToDelete: (name: string) => `אתם עומדים למחוק את "${name}"`,
    submit: "מחיקה לצמיתות",
    submitting: "מוחק...",
    cancel: "ביטול",
    deleted: (name: string) => `המערכת "${name}" נמחקה לצמיתות`,
    /** The workspace IS gone; only the Owner's Auth account was left behind. */
    deletedAuthLeft: (name: string) =>
      `המערכת "${name}" נמחקה, אך לא הצלחנו למחוק את חשבון הבעלים. פנו לתמיכה כדי להשלים את הניקוי.`,
    errors: {
      WORKSPACE_NAME_MISMATCH:
        "שם המערכת אינו תואם את המערכת שנבחרה. רעננו את הדף ונסו שוב.",
      WORKSPACE_NOT_FOUND: "המערכת אינה קיימת. רעננו את הדף.",
      BUDGET_EXPORT_INCOMPLETE:
        "הייצוא לא הושלם במלואו. יש לבצע ייצוא תקציב חדש.",
      NOT_FOUND: "המידע המבוקש אינו קיים. רעננו את הדף.",
      STORAGE_ERROR: "לא הצלחנו להוריד את קבצי התקציב. נסו שוב.",
      CHECKSUM_MISMATCH: "אחד הקבצים שהתקבלו אינו תקין. יש לבצע ייצוא חדש.",
      NETWORK: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
      EXPORT_UNSUPPORTED:
        "ייצוא לתיקייה נתמך ב-Chrome או Edge במחשב.",
      BUDGET_EXPORT_REQUIRED:
        "למערכת יש נתוני תקציב. יש לבצע ייצוא תקציב מאומת לפני המחיקה.",
      BUDGET_EXPORT_STALE:
        "נתוני התקציב השתנו מאז הייצוע האחרון. יש לבצע ייצוא תקציב מאומת חדש.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** Module-entitlement section heading (the list itself: workspaceModules). */
  modulesSection: {
    title: "הקצאת מודולים",
    search: "חיפוש לפי שם מערכת או בעלים",
    editTitle: (name: string) => `עריכת מודולים - ${name}`,
  },

  /** Audit section. No read API for the entitlement audit exists yet, so the
   * section says so instead of inventing one. */
  audit: {
    title: "יומן פעולות",
    description:
      "פעולות ניהול שנרשמו בשרת, מהחדשה לישנה. לצפייה בלבד.",
    /** The log shows ONLY recorded events - it never reconstructs history. */
    emptyTitle: "טרם נרשמו פעולות",
    emptyHint:
      "פעולות ניהול יופיעו כאן מרגע שיירשמו. פעולות שבוצעו לפני שהיומן הופעל אינן מוצגות, ואינן משוחזרות.",
    loadError: "לא הצלחנו לטעון את יומן הפעולות.",
    count: (n: number) => `${n} רשומות`,
    search: "חיפוש ביומן",
    noResults: "לא נמצאו רשומות התואמות לחיפוש",
    sources: {
      owner_account: "חשבון בעלים",
      entitlement: "מודולים",
      module_availability: "זמינות מודולים",
      multi_entity: "רב-מערכות",
    } as Record<string, string>,
    actions: {
      profile_updated: "עודכנו פרטי הבעלים",
      username_changed: "שונה שם המשתמש",
      password_set: "נקבעה סיסמה לבעלים",
      self_password_set: "בעל הפלטפורמה החליף את סיסמתו",
      approval_selected: "מודולים נבחרו באישור",
      provisioning_granted: "מודולים הוקצו בהקמה",
      enabled: "הופעל",
      disabled: "הושבת",
      backfill_granted: "הוקצה במיגרציה",
      provisioned: "הוקצה בעל רב-מערכות",
      replaced: "בעל רב-מערכות הוחלף",
      removed: "בעל רב-מערכות הוסר",
      assigned: "שויכה מערכת",
      unassigned: "בוטל שיוך מערכת",
    } as Record<string, string>,
    changedFields: {
      name: "שם",
      email: "אימייל",
      phone: "טלפון",
    } as Record<string, string>,
    changedLabel: (fields: string) => `שונו: ${fields}`,
    renamedLabel: (from: string, to: string) => `${from} ← ${to}`,

    /** Emptying the log is a real, permanent deletion of the records - not a
     * filter and not a "clear from view". The copy has to say so. */
    purgeOpen: "מחיקת כל היומן",
    purgeTitle: "מחיקת כל יומן הפעולות",
    purgeWarningTitle: "הפעולה הזו אינה ניתנת לביטול",
    purgeWarning:
      "כל הרשומות ביומן יימחקו לצמיתות מהשרת. זו מחיקה אמיתית, לא הסתרה - הרשומות לא יהיו זמינות לשחזור.",
    purgeCount: (n: number) => `יימחקו ${n} רשומות`,
    purgeKept:
      "עצם המחיקה נרשמת בנפרד - מי ביצע אותה, מתי, וכמה רשומות נמחקו - ורישום זה אינו ניתן לשינוי או למחיקה.",
    purgeConfirmWord: "מחיקה",
    purgeConfirmLabel: "להמשך, הקלידו: מחיקה",
    purgeMismatch: "יש להקליד את המילה מחיקה",
    purgeSubmit: "מחיקה לצמיתות",
    purgeSubmitting: "מוחק...",
    purgeCancel: "ביטול",
    purged: (n: number) => `${n} רשומות נמחקו מהיומן`,
    purgeErrors: {
      PURGE_NOT_CONFIRMED: "יש להקליד את המילה מחיקה",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  settings: {
    title: "הגדרות",
    description: "פרטי החשבון המאומת של בעל הפלטפורמה.",
  },

  /** Stage 3B - approving a new Election Owner. */
  approveOwner: {
    title: "אישור בעלים חדש",
    subtitle:
      "יצירת גישה לבעלים של מערכת בחירות חדשה. מערכת הבחירות עצמה תיווצר על ידי הבעלים בכניסה הראשונה.",
    nameLabel: "שם הבעלים",
    emailLabel: "אימייל",
    phoneLabel: "טלפון",
    phoneHint: "מספר ישראלי. משמש לשליחת פרטי הכניסה בוואטסאפ.",
    missingPhone: "יש להזין מספר טלפון ישראלי תקין",
    /** Stage 9: explicit module entitlement choice. */
    modulesLabel: "מודולים למערכת",
    modulesHint:
      "בחרו במפורש לאילו מודולים תהיה גישה למערכת החדשה. ניתן לשנות זאת בהמשך ממסך הקצאת המודולים.",
    modulesRequired: "יש לבחור לפחות מודול אחד",
    moduleUnavailable: "טרם זמין - יישמר ויופעל כשיהיה זמין",
    modulesLoading: "טוענים את רשימת המודולים...",
    modulesLoadError: "לא הצלחנו לטעון את רשימת המודולים. רעננו את הדף.",
    submit: "אישור ויצירת קישור",
    submitting: "יוצרים...",
    missingFields: "יש להזין שם וכתובת אימייל תקינה",
    successTitle: "הבעלים אושר",
    alreadyExisted: "לחשבון הזה כבר קיימת הרשאה פעילה. הקישור שלהלן מתאים לה.",
    linkLabel: "קישור הפעלה חד-פעמי",
    linkHint:
      "מסרו את הקישור לבעלים בערוץ מאובטח. הוא חד-פעמי, תקף לזמן מוגבל, ומאפשר להם לבחור סיסמה משלהם. הקישור אינו נשמר ולא יוצג שוב.",
    linkMissing:
      "ההרשאה נוצרה, אך הפקת הקישור נכשלה. ניתן להפיק קישור חדש מרשימת בעלי המערכות - לא ייווצר חשבון נוסף.",
    expiresAt: (iso: string) => `תוקף ההרשאה עד ${new Date(iso).toLocaleString("he-IL")}`,
    copy: "העתקה",
    copied: "הועתק",
    /** The two hand-off actions. Both open the operator's OWN app with the
     * message prepared - nothing is sent by the system, and the copy says so
     * rather than implying a delivery guarantee it cannot make. */
    send: {
      label: "שליחת פרטי הכניסה",
      whatsapp: "שליחה בוואטסאפ",
      email: "שליחה באימייל",
      hint: "הפעולה פותחת אצלכם את וואטסאפ או את תוכנת הדואר עם ההודעה מוכנה. המערכת אינה שולחת ואינה מאמתת מסירה.",
      emailSubject: "פרטי הכניסה שלך לקולבוקס",
    },
    another: "אישור בעלים נוסף",
    done: "סיום",
    errors: {
      EMAIL_ALREADY_REGISTERED: "כתובת האימייל הזו כבר משויכת לחשבון קיים.",
      APPROVAL_EXISTS:
        "לכתובת הזו כבר קיימת הרשאת בעלים. ניתן להפיק עבורה קישור חדש מרשימת בעלי המערכות.",
      OWNER_ALREADY_PROVISIONED: "החשבון הזה כבר משמש כבעלים של מערכת קיימת.",
      PENDING_ACCESS_ALREADY_CONSUMED: "ההרשאה של החשבון הזה כבר נוצלה.",
      PENDING_ACCESS_EXPIRED: "תוקף ההרשאה הקודמת פג.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הפרטים שהוזנו אינם תקינים.",
      INVALID_MODULES: "בחירת המודולים אינה תקינה. בחרו לפחות מודול אחד מהרשימה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
    /** Stage 8B: the approval failed AND the compensating delete of the account
     * it created could not be confirmed. Appended to the real failure. */
    orphanWarning: (id: string) =>
      `בנוסף, לא ניתן היה לאמת שחשבון ההתחברות שנוצר נמחק (מזהה ${id}). אישור חוזר של אותה כתובת ישתמש בחשבון זה - לא ייווצר חשבון כפול.`,
  },

  /** Stage 8B - shared copy for a one-time link box. */
  oneTimeLink: {
    copy: "העתקה",
    copied: "הועתק",
    copyFailed: "ההעתקה נכשלה. סמנו את הקישור והעתיקו ידנית.",
  },

  /** Stage 8B - the Election Owner approvals list and its recovery actions. */
  ownerAccess: {
    title: "הרשאות בעלים",
    loadError: "לא הצלחנו לטעון את רשימת ההרשאות.",
    retry: "נסו שוב",
    states: {
      active: "ממתינה להרשמה",
      expired: "פג תוקף",
      consumed: "הושלמה",
    },
    expiresAt: (d: string) => `בתוקף עד ${d}`,
    expiredAt: (d: string) => `פג תוקף ב-${d}`,
    consumedAt: (d: string) => `ההרשמה הושלמה ב-${d}`,
    workspace: (name: string) => `מערכת: ${name}`,
    /** Stage 9: the module choice recorded with a not-yet-used approval. */
    requestedModules: (list: string) => `מודולים שנבחרו: ${list}`,
    reissue: "הפקת קישור חדש",
    renew: "חידוש והפקת קישור",
    confirmReissueTitle: "להפיק קישור חדש?",
    confirmReissueMessage: (name: string) =>
      `יופק קישור חד-פעמי חדש עבור ${name}. קישור שנמסר קודם יפסיק לעבוד. תוקף ההרשאה לא ישתנה.`,
    confirmRenewTitle: "לחדש את ההרשאה?",
    confirmRenewMessage: (name: string) =>
      `ההרשאה של ${name} תחודש ל-7 ימים ויופק קישור חד-פעמי חדש. קישור שנמסר קודם יפסיק לעבוד.`,
    confirm: "הפקת קישור",
    linkTitle: (name: string) => `קישור חד-פעמי חדש עבור ${name}`,
    renewedNote: "ההרשאה חודשה ל-7 ימים.",
    linkMissing: "ההרשאה בתוקף, אך הפקת הקישור נכשלה. ניתן לנסות שוב מהרשימה.",
    dismiss: "סגירה",
    errors: {
      PENDING_ACCESS_ALREADY_CONSUMED:
        "הבעלים כבר השלים את ההרשמה - לא ניתן להפיק עבורו קישור חדש.",
      OWNER_ALREADY_PROVISIONED:
        "הבעלים כבר השלים את ההרשמה - לא ניתן להפיק עבורו קישור חדש.",
      IDENTITY_ALREADY_PRINCIPAL: "החשבון משמש כבר בתפקיד אחר במערכת. לא הופק קישור.",
      PENDING_ACCESS_NOT_FOUND: "ההרשאה לא נמצאה. רעננו את הדף.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** Gate 4 - GLOBAL module availability: a platform-wide kill switch, NOT the
   * per-workspace entitlement below. A module is active in a workspace only
   * when it is available here AND assigned to that workspace. */
  moduleAvailability: {
    open: "זמינות מודולים",
    title: "זמינות מודולים בכל הפלטפורמה",
    subtitle:
      "מתג גלובלי לכל מערכות הבחירות. מודול פעיל במערכת רק כשהוא זמין כאן וגם הוקצה לאותה מערכת. שינוי הזמינות אינו מוסיף ואינו מסיר הקצאות.",
    available: "זמין",
    unavailable: "לא זמין",
    fixed: "זמינות קבועה - לא ניתנת לשינוי כאן",
    entitled: (n: number) =>
      n === 0
        ? "לא הוקצה לאף מערכת"
        : n === 1
          ? "הוקצה למערכת אחת"
          : `הוקצה ל-${n} מערכות`,
    enable: "הפיכה לזמין",
    disable: "הפיכה ללא זמין",
    confirmEnableTitle: (label: string) => `להפוך את "${label}" לזמין?`,
    confirmEnableMessage: (label: string, n: number) =>
      `"${label}" ייפתח מיד בכל מערכת שהוקצה לה (${n}). אף מערכת אחרת לא תקבל גישה, והפעולה נרשמת ביומן.`,
    confirmDisableTitle: (label: string) => `להפוך את "${label}" ללא זמין?`,
    confirmDisableMessage: (label: string, n: number) =>
      `"${label}" ייחסם מיד בכל המערכות שהוקצה להן (${n}), גם למשתמשים מחוברים. ההקצאות והנתונים נשמרים, והפיכה לזמין תחזיר את הגישה. הפעולה נרשמת ביומן.`,
    close: "סגירה",
    changed: "הזמינות עודכנה",
    errors: {
      MODULE_AVAILABILITY_FIXED: "הזמינות של מודול זה קבועה ואינה ניתנת לשינוי.",
      MODULE_NOT_FOUND: "המודול לא נמצא. רעננו את הדף.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** Stage 9 - per-workspace module entitlements (platform licensing). An
   * entitlement decides whether a module is available to a workspace at all;
   * what a user may do inside it is still decided by that workspace's roles. */
  workspaceModules: {
    title: "מודולים לפי מערכת",
    subtitle:
      "אילו מודולים פעילים בכל מערכת בחירות. ההרשאות בתוך מודול פעיל נקבעות בתפקידים שמנהלים הבעלים.",
    empty: "אין מערכות בחירות",
    loadError: "לא הצלחנו לטעון את המודולים.",
    retry: "נסו שוב",
    owner: (name: string) => `בעלים: ${name}`,
    none: "אין מודולים פעילים",
    edit: "עריכת מודולים",
    save: "שמירה",
    cancel: "ביטול",
    unavailable: "טרם זמין",
    required: "יש לבחור לפחות מודול אחד",
    confirmTitle: "לעדכן את המודולים?",
    confirmMessage: (name: string) =>
      `המודולים של "${name}" יעודכנו מיד. הסרת "ניהול יום הבחירות" תנתק את אנשי הצוות של המערכת ותחסום את כניסתם; ניהול המשתמשים והתפקידים של הבעלים יישאר זמין.`,
    confirm: "עדכון",
    saved: "המודולים עודכנו",
    errors: {
      INVALID_MODULES: "בחירת המודולים אינה תקינה.",
      WORKSPACE_NOT_FOUND: "מערכת הבחירות לא נמצאה. רעננו את הדף.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הבקשה אינה תקינה.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,
  },

  /** Stage 4B - Multi-Entity Owner management (the FOURTH platform principal).
   *
   * Terminology follows what the repo already uses: a workspace is a
   * "מערכת בחירות", its login_code is a "קוד מערכת"
   * (election-day.constants.ts), an Election Owner is a "בעלים", and the
   * Platform Owner is "בעל הפלטפורמה". The fourth principal is
   * "בעל רב-מערכות".
   *
   * D-14: the one-time link is called "קישור לקביעת סיסמה", never an
   * "activation link" - in Stage 4B it sets a password and nothing more, and
   * the copy says so explicitly; the holder then signs in on the dedicated
   * Multi-Entity origin (Stages 5-7). */
  multiEntity: {
    entry: {
      title: "ניהול בעל רב-מערכות",
      unprovisioned: "טרם הוקצה בעל רב-מערכות",
      provisioned: (name: string, assigned: number) =>
        `${name} - ${assigned} מערכות משויכות`,
      open: "פתיחת הניהול",
    },

    page: {
      title: "ניהול בעל רב-מערכות",
      back: "חזרה למסוף",
      loading: "טוענים את הנתונים...",
      loadError: "לא הצלחנו לטעון את הנתונים.",
      retry: "נסו שוב",
      stageNote:
        "בעל רב-מערכות מתחבר בכתובת ייעודית עם אימות דו-שלבי ורואה נתונים מצטברים בלבד (ספירות) של המערכות הפעילות המשויכות אליו - ללא פרטי בוחרים.",
    },

    seat: {
      title: "בעלי רב-מערכות",
      emptyTitle: "טרם הוקצו בעלי רב-מערכות",
      emptyHint: "הקצו בעל רב-מערכות כדי שניתן יהיה לשייך אליו מערכות בחירות.",
      provision: "הקצאת בעל רב-מערכות",
      add: "הוספת בעל רב-מערכות",
      replace: "החלפת בעל רב-מערכות",
      remove: "הסרת בעל רב-מערכות",
      count: (n: number) => (n === 1 ? "בעל רב-מערכות אחד" : `${n} בעלי רב-מערכות`),
      assignedCount: (n: number) =>
        n === 0 ? "ללא מערכות משויכות" : n === 1 ? "מערכת אחת משויכת" : `${n} מערכות משויכות`,
      open: "פתח",
      close: "סגירה",
      openedHint: "השיוך מתבצע עבור בעל רב-המערכות הפתוח.",
      assignmentsLabel: "מערכות משויכות",
      noAssignments: "אין מערכות משויכות",
      reissue: "הפקת קישור חדש לקביעת סיסמה",
      reissueHint:
        "הקישור החד-פעמי מוצג פעם אחת בלבד ואינו נשמר. אם אבד, אפשר להפיק קישור חדש - ההפקה מבטלת מיד את הקישור הקודם של אותו חשבון.",
      reissued: "הופק קישור חדש. הקישור הקודם בוטל.",
      select: "בחירה",
      selected: "נבחר",
      selectHint: "בחרו בעל רב-מערכות כדי לנהל את המערכות המשויכות אליו.",
      confirmRemoveTitle: "הסרת בעל רב-מערכות",
      confirmRemoveMessage: (name: string) =>
        `להסיר את ${name}? כל השיוכים שלו יבוטלו והגישה שלו תיפסק מיד. בעלים אחרים המשויכים לאותן מערכות אינם מושפעים. חשבון ההתחברות שלו לא יימחק אוטומטית - מחיקתו היא פעולה נפרדת הדורשת אישור מפורש.`,
      confirmRemove: "הסרה",
      removed: "בעל רב-המערכות הוסר.",
      nameLabel: "שם",
      usernameLabel: "שם משתמש לכניסה",
      noUsername: "לא נקבע",
      emailLabel: "אימייל",
      phoneLabel: "טלפון",
      authIdLabel: "מזהה חשבון",
      loginUrlLabel: "כתובת כניסה",
      createdAtLabel: "הוקצה בתאריך",
      updatedAtLabel: "עודכן בתאריך",
      noPhone: "לא הוזן",
      handoffHint:
        "פרטי המסירה נשמרים בשרת וזמינים גם לאחר רענון. הקישור החד-פעמי לקביעת סיסמה אינו נשמר - אם הוא אבד, יש להחליף את בעל רב-המערכות כדי להפיק קישור חדש.",
    },

    form: {
      provisionTitle: "הקצאת בעל רב-מערכות",
      replaceTitle: "החלפת בעל רב-מערכות",
      subtitle:
        "יצירת חשבון ללא סיסמה והפקת קישור חד-פעמי לקביעת סיסמה. הסיסמה נבחרת על ידי בעל רב-המערכות בלבד.",
      nameLabel: "שם מלא",
      emailLabel: "אימייל",
      phoneLabel: "טלפון",
      phoneHint: "מספר ישראלי.",
      missingPhone: "יש להזין מספר טלפון ישראלי תקין",
      /** The seat holder's LOGIN username for /login/multi-entity-owner.
       * Required: without a directory identity the holder could never sign in. */
      usernameLabel: "שם משתמש לכניסה",
      usernameHint:
        "זהו שם המשתמש לכניסה בכתובת בעל רב-המערכות. ניתן להגדיר פעם אחת בלבד.",
      usernamePlaceholder: "לדוגמה: נחום משה",
      missingUsername: "יש להזין שם משתמש לכניסה",
      usernameSuggestion: (name: string) => `השם הפנוי הבא: ${name}`,
      usernameUseSuggestion: "השתמשו בשם המוצע",
      submitProvision: "הקצאת בעל רב-מערכות",
      submitReplace: "החלפת בעל רב-מערכות",
      submitting: "מבצעים...",
      missingName: "יש להזין שם מלא",
      missingEmail: "יש להזין כתובת אימייל תקינה",
      replaceWarningTitle: "לפני ההחלפה",
      replaceCurrent: (name: string, email: string) =>
        `בעל רב-המערכות הנוכחי הוא ${name} (${email}). לאחר ההחלפה:`,
      replaceBullets: [
        "כל המערכות המשויכות יעברו אוטומטית לבעל החדש",
        "החשבון הקודם לא יימחק אוטומטית",
        "מחיקת החשבון הקודם היא פעולה נפרדת הדורשת אישור מפורש",
      ],
      replaceEmailNote:
        "לא ניתן להשתמש שוב בכתובת האימייל של הבעל הנוכחי לפני מחיקת החשבון הקודם.",
      confirmReplaceTitle: "להחליף את בעל רב-המערכות?",
      confirmReplaceMessage: (name: string) =>
        `${name} יחליף את בעל רב-המערכות הנוכחי. המערכות המשויכות יעברו אליו אוטומטית, והחשבון הקודם יישאר קיים עד למחיקה נפרדת.`,
      confirmReplace: "החלפה",
    },

    /** D-14: password-setting link, NOT an "activation link". */
    passwordLink: {
      title: "קישור לקביעת סיסמה",
      hint: "מסרו את הקישור בערוץ מאובטח. הוא חד-פעמי, תקף לזמן מוגבל, ואינו נשמר - לאחר סגירת הפאנל לא ניתן יהיה להציגו שוב.",
      accessNote:
        "הקישור מאפשר קביעת סיסמה בלבד. לאחר מכן בעל רב-המערכות מתחבר בכתובת הכניסה שלהלן ומגדיר אימות דו-שלבי.",
      destinationLabel: "כתובת הכניסה של בעל רב-המערכות",
      copy: "העתקה",
      copied: "הועתק",
      copyDestination: "העתקת כתובת הכניסה",
      destinationCopied: "כתובת הכניסה הועתקה",
      legacyDestinationLabel: "כתובת ישירה (זמנית, עד סיום המעבר)",
      copyFailed: "ההעתקה נכשלה. סמנו את הקישור והעתיקו ידנית.",
      missing:
        "בעל רב-המערכות הוקצה, אך הפקת הקישור נכשלה. פתחו את בעל רב-המערכות ברשימה והפיקו קישור חדש - אין צורך בהחלפה.",
      dismiss: "סגירה",
      replacedNote: "ההחלפה הושלמה. שימו לב לפעולת המחיקה הממתינה מטה.",
    },

    /** Accounts displaced from the seat by a replacement. */
    replacementCleanup: {
      titleOne: "מחיקת חשבון קודם - נדרש אישור",
      titleMany: "מחיקת חשבונות קודמים - נדרש אישור",
      count: (n: number) => `${n} חשבונות ממתינים למחיקה`,
      body: "החלפת בעל רב-המערכות הושלמה במסד הנתונים. חשבון ההתחברות הקודם עדיין קיים ולא נמחק.",
      idLabel: "מזהה החשבון הקודם",
      replacedAt: (d: string) => `הוחלף בתאריך ${d}`,
      failures: (n: number, d: string) =>
        `ניסיון מחיקה קודם נכשל - ${n} ניסיונות, האחרון ב-${d}`,
      action: "מחיקת החשבון",
      confirmTitle: "למחוק לצמיתות את החשבון הקודם?",
      confirmMessage: (id: string) =>
        `פעולה זו מוחקת את חשבון ההתחברות ${id} לצמיתות ואינה ניתנת לביטול. החלפת בעל רב-המערכות כבר הושלמה בהצלחה - זוהי פעולת ניקוי נפרדת בלבד.`,
      confirm: "מחיקה לצמיתות",
      success: "החשבון הקודם נמחק והפעולה נרשמה ביומן.",
    },

    /** Accounts left behind by a FAILED provisioning attempt - a different
     * business fact from a replacement, so a visibly different card. */
    orphanCleanup: {
      title: "חשבונות שנוצרו בניסיון הקצאה שנכשל",
      count: (n: number) => `${n} חשבונות ממתינים למחיקה`,
      body: "בניסיון הקצאה שנכשל נוצר חשבון התחברות שלא הפך לבעל רב-מערכות. החשבון אינו משמש לשום דבר וניתן למחוק אותו.",
      idLabel: "מזהה חשבון",
      emailLabel: "אימייל שהוזן",
      noEmail: "לא נשמר אימייל",
      mintedAt: (d: string) => `נוצר בתאריך ${d}`,
      failures: (n: number, d: string) =>
        `ניסיון מחיקה קודם נכשל - ${n} ניסיונות, האחרון ב-${d}`,
      action: "מחיקת החשבון",
      confirmTitle: "למחוק לצמיתות את החשבון?",
      confirmMessage: (id: string) =>
        `פעולה זו מוחקת את חשבון ההתחברות ${id} לצמיתות ואינה ניתנת לביטול. החשבון נוצר בניסיון הקצאה שנכשל ואינו משמש כבעל רב-מערכות.`,
      confirm: "מחיקה לצמיתות",
      success: "החשבון נמחק והפעולה נרשמה ביומן.",
    },

    workspaces: {
      title: "מערכות בחירות",
      count: (assigned: number, total: number) => `${assigned} מתוך ${total} משויכות`,
      empty: "אין מערכות בחירות במערכת",
      noResults: "לא נמצאו מערכות התואמות לחיפוש",
      search: "חיפוש לפי שם או קוד מערכת",
      onlyAssigned: "משויכות בלבד",
      codeLabel: "קוד מערכת",
      duplicateName: "שם כפול - הבחינו לפי קוד המערכת",
      active: "פעילה",
      ended: "הסתיימה",
      assigned: "משויכת",
      unassigned: "לא משויכת",
      assignedAt: (d: string) => `שויכה ב-${d}`,
      sharedWith: (n: number) =>
        n === 1 ? "משויכת גם לבעל רב-מערכות נוסף" : `משויכת גם ל-${n} בעלי רב-מערכות נוספים`,
      assignedToOwners: (n: number) =>
        n === 1 ? "משויכת לבעל רב-מערכות אחד" : `משויכת ל-${n} בעלי רב-מערכות`,
      forOwner: (name: string) => `שיוך מערכות עבור ${name}`,
      noOwnerSelected: "בחרו בעל רב-מערכות כדי לשייך אליו מערכות.",
      endsAt: (d: string) => `מסתיימת ב-${d}`,
      assign: "שיוך",
      unassign: "ביטול שיוך",
      blocked: "יש להקצות בעל רב-מערכות לפני שיוך מערכות.",
      confirmUnassignTitle: "לבטל את השיוך?",
      confirmUnassignMessage: (name: string, code: string) =>
        `${name} (קוד ${code}) לא תהיה עוד גלויה לבעל רב-המערכות. ניתן לשייך אותה מחדש בכל עת.`,
      confirmUnassign: "ביטול שיוך",
    },

    errors: {
      EMAIL_ALREADY_REGISTERED:
        "כתובת האימייל הזו כבר משויכת לחשבון קיים. אם זו הכתובת של הבעל הנוכחי, יש למחוק תחילה את החשבון הקודם.",
      IDENTITY_ALREADY_PRINCIPAL:
        "החשבון הזה כבר משמש כבעל הפלטפורמה או כבעלים של מערכת קיימת.",
      IDENTITY_PENDING_ELECTION_OWNER:
        "לחשבון הזה קיימת הרשאת בעלים ממתינה. יש להשלים או לבטל אותה תחילה.",
      MULTI_ENTITY_OWNER_NOT_FOUND: "בעל רב-המערכות שנבחר אינו קיים. רעננו את המסך ונסו שוב.",
      MULTI_ENTITY_OWNER_NOT_PROVISIONED: "יש להקצות בעל רב-מערכות לפני שיוך מערכות.",
      WORKSPACE_NOT_FOUND: "מערכת הבחירות לא נמצאה. רעננו את הדף ונסו שוב.",
      AUTH_USER_STILL_HELD:
        "לא ניתן למחוק את החשבון - הוא עדיין משויך לתפקיד פעיל במערכת.",
      NOT_A_REPLACED_PRINCIPAL: "החשבון אינו רשום כחשבון שהוחלף. לא בוצעה מחיקה.",
      NOT_A_PROVISIONING_ORPHAN:
        "החשבון אינו רשום כחשבון שנוצר בניסיון הקצאה שנכשל. לא בוצעה מחיקה.",
      AUTH_CLEANUP_AUDIT_WRITE_FAILED:
        "המחיקה בוצעה אך רישום היומן נכשל. הריצו את הפעולה שוב כדי להשלים את הרישום.",
      USERNAME_TAKEN: "שם המשתמש תפוס",
      INVALID_USERNAME: "שם המשתמש אינו תקין. אסור להשתמש ב-@ וברווח כפול.",
      USERNAME_ALREADY_SET: "לחשבון הזה כבר הוגדר שם משתמש לכניסה.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הפרטים שהוזנו אינם תקינים.",
      SERVER_CONFIG_MISSING: "השירות אינו מוגדר כראוי. פנו לתמיכה.",
      SERVER_ERROR: "אירעה שגיאה, נסו שוב",
    } as Record<string, string>,

    /** Provisioning failed AND the compensating Auth delete could not be
     * confirmed. Deliberately not in the map above: it is a WARNING appended
     * to whatever the real failure was, and it carries an id. */
    orphanWarning: (id: string) =>
      `בנוסף, לא ניתן היה לאמת שחשבון ההתחברות שנוצר נמחק. מזהה החשבון: ${id}. החשבון יופיע ברשימת המחיקה לאחר רענון.`,

    heldBy: {
      platform: "בעל הפלטפורמה",
      election: "בעלים של מערכת בחירות",
      multi_entity: "בעל רב-מערכות",
      pending_owner: "הרשאת בעלים ממתינה",
    } as Record<string, string>,
  },
} as const;

/** Stage 8B - maps an approvals-list / re-issue error code to Hebrew, with the
 * same unknown-code fallback as the functions around it. */
export function platformOwnerAccessError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.ownerAccess.errors[code] ??
    PLATFORM_OWNER_TEXT.ownerAccess.errors.SERVER_ERROR
  );
}

/** Stage 9 - maps a module-entitlement error code to Hebrew (same unknown-code
 * fallback as the functions around it). */
export function platformModuleAvailabilityError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.moduleAvailability.errors[code] ??
    PLATFORM_OWNER_TEXT.moduleAvailability.errors.SERVER_ERROR
  );
}

export function platformWorkspaceModulesError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.workspaceModules.errors[code] ??
    PLATFORM_OWNER_TEXT.workspaceModules.errors.SERVER_ERROR
  );
}

export function platformPurgeAuditError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.audit.purgeErrors[code] ??
    PLATFORM_OWNER_TEXT.audit.purgeErrors.SERVER_ERROR
  );
}

export function platformDeleteWorkspaceError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.deleteWorkspace.errors[code] ??
    PLATFORM_OWNER_TEXT.deleteWorkspace.errors.SERVER_ERROR
  );
}

export function platformOwnerAccountError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.ownerAccount.errors[code] ??
    PLATFORM_OWNER_TEXT.ownerAccount.errors.SERVER_ERROR
  );
}

export function platformApproveOwnerError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.approveOwner.errors[code] ??
    PLATFORM_OWNER_TEXT.approveOwner.errors.SERVER_ERROR
  );
}

/** Maps a Stage 4B server error code to Hebrew. Same shape and same
 * unknown-code fallback as platformApproveOwnerError - a code the backend
 * does not actually emit is never invented here, and an unrecognised one
 * degrades to the generic message rather than rendering a raw literal. */
export function platformMultiEntityError(code: string): string {
  return (
    PLATFORM_OWNER_TEXT.multiEntity.errors[code] ??
    PLATFORM_OWNER_TEXT.multiEntity.errors.SERVER_ERROR
  );
}

/** Hebrew label for the linkage that still holds an Auth account
 * (409 AUTH_USER_STILL_HELD -> `heldBy`). Returns null for an unknown label
 * so the caller simply omits the detail rather than printing a raw token. */
export function platformHeldByLabel(heldBy: string | null | undefined): string | null {
  if (!heldBy) return null;
  return PLATFORM_OWNER_TEXT.multiEntity.heldBy[heldBy] ?? null;
}
