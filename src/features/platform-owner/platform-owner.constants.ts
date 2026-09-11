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
    stageNote:
      "אישור בעלים יוצר חשבון ללא סיסמה ומפיק קישור חד-פעמי. הסיסמה נבחרת על ידי הבעלים בלבד.",
    logout: "התנתקות",
  },

  /** Stage 3B - approving a new Election Owner. */
  approveOwner: {
    title: "אישור בעלים חדש",
    subtitle:
      "יצירת גישה לבעלים של מערכת בחירות חדשה. מערכת הבחירות עצמה תיווצר על ידי הבעלים בכניסה הראשונה.",
    nameLabel: "שם הבעלים",
    emailLabel: "אימייל",
    phoneLabel: "טלפון (לא חובה)",
    submit: "אישור ויצירת קישור",
    submitting: "יוצרים...",
    missingFields: "יש להזין שם וכתובת אימייל תקינה",
    successTitle: "הבעלים אושר",
    alreadyExisted: "לחשבון הזה כבר קיימת הרשאה פעילה. הקישור שלהלן מתאים לה.",
    linkLabel: "קישור הפעלה חד-פעמי",
    linkHint:
      "מסרו את הקישור לבעלים בערוץ מאובטח. הוא חד-פעמי, תקף לזמן מוגבל, ומאפשר להם לבחור סיסמה משלהם. הקישור אינו נשמר ולא יוצג שוב.",
    linkMissing:
      "ההרשאה נוצרה, אך הפקת הקישור נכשלה. ניתן להפיק קישור חדש מרשימת ההרשאות שלמטה - לא ייווצר חשבון נוסף.",
    expiresAt: (iso: string) => `תוקף ההרשאה עד ${new Date(iso).toLocaleString("he-IL")}`,
    copy: "העתקה",
    copied: "הועתק",
    another: "אישור בעלים נוסף",
    errors: {
      EMAIL_ALREADY_REGISTERED: "כתובת האימייל הזו כבר משויכת לחשבון קיים.",
      APPROVAL_EXISTS:
        "לכתובת הזו כבר קיימת הרשאת בעלים. ניתן להפיק עבורה קישור חדש מרשימת ההרשאות שלמטה.",
      OWNER_ALREADY_PROVISIONED: "החשבון הזה כבר משמש כבעלים של מערכת קיימת.",
      PENDING_ACCESS_ALREADY_CONSUMED: "ההרשאה של החשבון הזה כבר נוצלה.",
      PENDING_ACCESS_EXPIRED: "תוקף ההרשאה הקודמת פג.",
      FORBIDDEN_ORIGIN: "הבקשה נחסמה. רעננו את הדף ונסו שוב.",
      UNAUTHORIZED: "אין הרשאה לביצוע הפעולה.",
      INVALID_REQUEST: "הפרטים שהוזנו אינם תקינים.",
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
    subtitle:
      "כל הבעלים שאושרו. לבעלים שטרם השלימו את ההרשמה ניתן להפיק קישור חדש; הרשאה שפג תוקפה ניתנת לחידוש.",
    empty: "טרם אושרו בעלים",
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
      title: "בעל רב-מערכות",
      emptyTitle: "טרם הוקצה בעל רב-מערכות",
      emptyHint: "הקצו בעל רב-מערכות כדי שניתן יהיה לשייך אליו מערכות בחירות.",
      provision: "הקצאת בעל רב-מערכות",
      replace: "החלפת בעל רב-מערכות",
      nameLabel: "שם",
      emailLabel: "אימייל",
      phoneLabel: "טלפון",
      authIdLabel: "מזהה חשבון",
      createdAtLabel: "הוקצה בתאריך",
      updatedAtLabel: "עודכן בתאריך",
      noPhone: "לא הוזן",
    },

    form: {
      provisionTitle: "הקצאת בעל רב-מערכות",
      replaceTitle: "החלפת בעל רב-מערכות",
      subtitle:
        "יצירת חשבון ללא סיסמה והפקת קישור חד-פעמי לקביעת סיסמה. הסיסמה נבחרת על ידי בעל רב-המערכות בלבד.",
      nameLabel: "שם מלא",
      emailLabel: "אימייל",
      phoneLabel: "טלפון (לא חובה)",
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
      copyFailed: "ההעתקה נכשלה. סמנו את הקישור והעתיקו ידנית.",
      missing:
        "בעל רב-המערכות הוקצה, אך הפקת הקישור נכשלה. לא ניתן להפיק מהמסוף קישור חדש לאותו חשבון; להשלמה יש לפעול לפי נוהל ההחלפה (החלפה לכתובת זמנית, מחיקת החשבון הקודם והחלפה חזרה).",
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
      MULTI_ENTITY_OWNER_NOT_PROVISIONED: "יש להקצות בעל רב-מערכות לפני שיוך מערכות.",
      WORKSPACE_NOT_FOUND: "מערכת הבחירות לא נמצאה. רעננו את הדף ונסו שוב.",
      AUTH_USER_STILL_HELD:
        "לא ניתן למחוק את החשבון - הוא עדיין משויך לתפקיד פעיל במערכת.",
      NOT_A_REPLACED_PRINCIPAL: "החשבון אינו רשום כחשבון שהוחלף. לא בוצעה מחיקה.",
      NOT_A_PROVISIONING_ORPHAN:
        "החשבון אינו רשום כחשבון שנוצר בניסיון הקצאה שנכשל. לא בוצעה מחיקה.",
      AUTH_CLEANUP_AUDIT_WRITE_FAILED:
        "המחיקה בוצעה אך רישום היומן נכשל. הריצו את הפעולה שוב כדי להשלים את הרישום.",
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
      multi_entity: "בעל רב-מערכות נוכחי",
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
