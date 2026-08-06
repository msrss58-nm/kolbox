import type { Permission, RoleScopeType } from "../../permissions/types";

export const REMINDER_MINUTES_OPTIONS = [15, 30, 60] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

/** Dynamic Roles & Permissions Phase 2: Hebrew label for every entry in
 * `ALL_PERMISSIONS` (src/permissions/permissionsMap.ts) - the role editor's
 * permission checkbox list reads through this so a new permission added to
 * the code catalog fails to compile here (an exhaustive `Record`) rather
 * than silently rendering as a raw camelCase key. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "voter.markVoted": "סימון הצבעה",
  "voter.manageReminder": "ניהול תזכורות",
  "voter.manageRide": "ניהול הסעות",
  "voter.editPhone": "עריכת טלפון",
  "voter.editNotes": "עריכת הערות",
  "electionDay.import": "ייבוא קובץ בוחרים",
  "electionDay.clearData": "מחיקת נתונים",
  "electionDay.export": "ייצוא דוחות",
  "electionDay.manageSettings": "ניהול הגדרות (יעד זמן)",
  "electionDay.manageUsers": "ניהול הרשאות משתמשים",
  "electionDay.manageRideCoordinators": "ניהול אחראי הסעות",
  "electionDay.manageRolesAndPermissions": "ניהול תפקידים והרשאות",
  "electionDay.manageNonVotingReasons": "ניהול סיבות אי-הצבעה",
  "app.accessFullNavigation": "גישה לתפריט הראשי המלא",
  "voter.viewName": "צפייה בשם",
  "voter.viewAddress": "צפייה בכתובת",
  "voter.viewPhone": "צפייה בטלפון",
  "voter.viewMasad": "צפייה במסד",
  "voter.viewCoordinator": "צפייה באחראי",
  "voter.viewNotes": "צפייה בהערות",
  "voter.viewReminderStatus": "צפייה בסטטוס תזכורת",
  "voter.viewRideStatus": "צפייה בסטטוס הסעה",
  "voter.viewVotedStatus": "צפייה בסטטוס הצבעה",
};

export const ROLE_SCOPE_LABELS: Record<RoleScopeType, string> = {
  all: "כל אנשי הקשר",
  assigned_to_me: "רק המוקצים לי",
};

export const ELECTION_DAY_TEXT = {
  title: '📊 חמ"ל בחירות - מערכת שליטה',
  subtitle: "ניהול, סינון וחיוג ישיר לבוחרים בלחיצת כפתור",
  loadingSubtitle: "טוען…",

  searchPlaceholder: "🔍 חיפוש לפי שם או טלפון…",
  searchAriaLabel: "חיפוש אנשי קשר",
  clearSearchAriaLabel: "ניקוי חיפוש",

  permissionDenied: "אין לך הרשאה לבצע פעולה זו",

  countdown: {
    label: "יעד",
    noDeadline: "לא נקבע יעד",
    expired: "הזמן הגיע!",
    setDeadline: "קביעת יעד",
    deadlineFieldLabel: "תאריך ושעה יעד",
    days: "ימים",
    hours: "שעות",
    minutes: "דקות",
    seconds: "שניות",
    toast: {
      saved: "היעד נשמר",
    },
  },

  import: {
    button: "טען קובץ בוחרים",
    columnsHint:
      "עמודות נדרשות: שם פרטי, שם משפחה, אחראי (טלפון/רחוב/מס' בית/עיר אופציונליים)",
    confirmTitle: "החלפת רשימת הבוחרים",
    confirmMessage:
      "הייבוא יחליף לחלוטין את רשימת אנשי הקשר הקיימת - כולל כל סימוני ההצבעה וסטטוס ההסעות שכבר נרשמו היום. פעולה זו אינה הפיכה.",
    confirmButton: "טענו את הקובץ",
    toast: {
      loaded: (imported: number, total: number, rejected: number) =>
        rejected === 0
          ? `נטענו ${imported} אנשי קשר`
          : `נטענו ${imported} מתוך ${total} אנשי קשר - ${rejected} נדחו, ראו פירוט למטה`,
      missingColumns: "לא זוהו כל העמודות הנדרשות (שם פרטי / שם משפחה / אחראי) בקובץ",
      empty: "הקובץ ריק",
    },
    summary: {
      title: "סיכום הייבוא האחרון",
      imported: (n: number) => `נקלטו: ${n}`,
      rejected: (n: number) => `נדחו: ${n}`,
      reasons: {
        missingName: "חסר שם פרטי/משפחה",
        missingCoordinator: "חסר אחראי",
        duplicate: "כפילות (זהה לרשומה קודמת בקובץ)",
      },
      downloadButton: "⬇️ הורדת רשומות שנדחו",
      dismiss: "סגירה",
    },
  },

  clearAll: {
    button: "מחק קובץ בוחרים",
    confirmTitle: "מחיקת קובץ הבוחרים",
    confirmMessage: "כל אנשי הקשר וסטטוס ההסעות יימחקו לצמיתות. פעולה זו אינה הפיכה.",
    confirmButton: "מחקו",
    toast: {
      cleared: "קובץ הבוחרים נמחק",
    },
  },

  exportReport: {
    button: "ייצא דוח הצבעות",
    toast: {
      empty: "אין נתונים לייצוא",
    },
  },

  snapshotReport: {
    button: "שלח דוח תמונת מצב",
    message: (opts: {
      time: string;
      total: number;
      voted: number;
      votedPct: number;
      coordinators: { name: string; total: number; voted: number }[];
    }) =>
      [
        `דוח תמונת מצב הצבעות לשעה ${opts.time}`,
        "",
        `סה"כ בוחרים: ${opts.total}`,
        `כמה הצביעו: ${opts.voted}`,
        `אחוז הצבעה: ${opts.votedPct}%`,
        "",
        ...opts.coordinators.map(
          (c) => `${c.name}: ${c.total} בוחרים, ${c.voted} הצביעו`,
        ),
        "",
        "יש להגביר את הקצב - כל קול קובע!",
      ].join("\n"),
  },

  coordinatorFilter: {
    label: "אחראי",
    all: "כל האחראים",
  },

  cityFilter: {
    label: "עיר",
    all: "כל הערים",
  },

  statusFilter: {
    label: "סטטוס הסעה",
    all: "כל הסטטוסים",
  },

  reasonFilter: {
    label: "סיבת אי-הצבעה",
    all: "כל הסיבות",
  },

  dashboard: {
    totalContacts: 'סה"כ אנשי קשר',
    arranged: "הסעות תואמו",
    remaining: "נותרו לתיאום",
    coveragePct: "אחוז השלמה",
    byCoordinator: "התקדמות לפי אחראי",
    byCoordinatorEmpty: "אין נתונים עדיין",
    recentActivity: {
      title: "פעילות אחרונה",
      empty: "אין עדיין הסעות שתואמו",
    },
    votingProgress: {
      title: "קצב התקדמות ההצבעות",
      progressLabel: (voted: number, total: number) => `${voted} מתוך ${total} הצביעו`,
      pieTitle: "יחס הצבעה",
      voted: "הצביעו",
      notVoted: "טרם הצביעו",
      totalVoters: 'סה"כ בוחרים',
      totalVoted: 'סה"כ הצביעו',
      votingPct: "אחוז הצבעה",
    },
    rideCoordination: {
      title: "תיאום הסעה",
      empty: "אין הסעות הממתינות כרגע",
      statusRequested: "דרישה להסעה",
      statusPending: "תואם הסעה",
      statusDone: "בוצע הסעה",
      toast: {
        done: "ההסעה סומנה כבוצעה",
        undone: "הסימון בוטל",
      },
    },
  },

  list: {
    columns: {
      masad: "מסד",
      name: "שם מלא",
      street: "רחוב",
      houseNumber: "מס' בית",
      city: "עיר",
      address: "כתובת",
      phone: "טלפון",
      coordinator: "אחראי",
      notes: "הערות",
      status: "סטטוס",
    },
    empty: {
      title: "אין עדיין אנשי קשר",
      hint: "טענו קובץ אקסל כדי להתחיל לתאם הסעות",
    },
    noMatches: {
      title: "לא נמצאו התאמות",
      hint: "נסו לשנות את הסינון",
    },
  },

  status: {
    arranged: "הסעה תואמה",
    notArranged: "טרם תואמה",
    toast: {
      arranged: "הסעה סומנה כתואמה",
      notArranged: "הסימון בוטל",
    },
  },

  voted: {
    voted: "הצביע",
    notVoted: "לא הצביע",
    markButton: "סימון כהצביע",
    unmarkButton: "בטל סימון הצבעה",
    toast: {
      voted: "סומן כהצביע",
      notVoted: "הסימון בוטל",
      reasonSet: "סיבת אי-ההצבעה נשמרה",
    },
    showUnvotedOnly: "הצג רק מי שטרם הצביע",
    /** Shown only while voted = false - the reason is never cleared when
     * voted flips to true (kept for history/reports), it just stops being
     * offered for editing (see useElectionDay.ts's setNonVotingReason). */
    reasonLabel: "סיבת אי-הצבעה",
    reasonPlaceholder: "בחרו סיבה (אופציונלי)",
    reasonNoneOption: "ללא סיבה",
  },

  reminder: {
    badge: "תזכורת",
    button: "תזכורת",
    cancelButton: "ביטול תזכורת",
    /** Opens the same shared `DateTimePicker` used elsewhere in the app for
     * an arbitrary date+time - see `ReminderMenu.tsx`. */
    customOption: "קביעת שעה",
    customConfirm: "אישור",
    /** `formatted` is `formatReminderDisplay(reminderAt)`'s output (e.g.
     * "בשעה 22:00" or "ב-17/08/2026 בשעה 22:00"). */
    activeLabel: (formatted: string) => `תזכורת ${formatted}`,
    options: {
      15: "15 דקות",
      30: "30 דקות",
      60: "שעה",
    },
    toast: {
      set: (label: string) => `התזכורת נקבעה - בעוד ${label}`,
      /** For the custom-time path - `formatted` is the same
       * `formatReminderDisplay` output `activeLabel` uses. */
      setAt: (formatted: string) => `התזכורת נקבעה ${formatted}`,
      cancelled: "התזכורת בוטלה",
      due: (name: string, coordinator: string) =>
        `תזכורת: זמן ליצור קשר עם ${name} (${coordinator})`,
    },
  },

  modal: {
    call: "חיוג מהיר",
    noPhone: "לא צוין טלפון",
    addPhoneButton: "הוסף מספר",
    editPhoneAriaLabel: "עריכת מספר טלפון",
    rideRequestButton: "דרישה להסעה",
    rideRequestActiveLabel: "יש דרישה להסעה",
    cancelCoordinationButton: "בטל תיאום",
    coordinatedLabel: "תואם",
  },

  phoneEditor: {
    addTitle: "הוספת מספר טלפון",
    editTitle: "עדכון מספר טלפון",
    phoneLabel: "מספר טלפון",
    phonePlaceholder: "050-1234567",
    invalidPhone: "מספר טלפון לא תקין",
    saveButton: "שמירה",
    toast: {
      saved: "מספר הטלפון נשמר",
    },
  },

  notes: {
    label: "הערות ועדכוני סטטוס",
    placeholder: "לדוגמה: הבטיח לצאת ב-18:00, לא עונה, צריך לברר לגבי המשפחה...",
    saving: "שומר...",
    saved: "נשמר בהצלחה",
  },

  /** Short tags appended to the free-text notes field (see `notesTags.ts`) -
   * additive, never overwrite whatever the activist already typed there. */
  noteTags: {
    rideRequested: "נדרש הסעה",
    rideArranged: "תואם",
  },

  driver: {
    sendButton: "תיאום הסעה",
    message: (voter: { name: string; address: string; phone: string | null }) =>
      `שלום, עליך לתאם עם הבוחר הר"מ שעת איסוף שלו להצבעה ובסיום ההצבעה עליך להחזירו לביתו.\n\nשם ומשפחה: ${voter.name}\nכתובת מלאה: ${voter.address || "לא צוינה כתובת"}\nטלפון: ${voter.phone || "לא צוין טלפון"}\n\nבסיום יש לסמנו כבוצע הסעה.\nתודה, צוות החמ"ל`,
    cancelMessage: (voter: { name: string; address: string; phone: string | null }) =>
      `שלום, נא לבטל את ההסעה שתואמה עבור הבוחר הר"מ.\n\nשם ומשפחה: ${voter.name}\nכתובת מלאה: ${voter.address || "לא צוינה כתובת"}\nטלפון: ${voter.phone || "לא צוין טלפון"}\n\nתודה, צוות החמ"ל`,
    toast: {
      sent: "וואטסאפ נפתח - בחרו את הנהג ושלחו",
    },
  },

  coordinatorsManager: {
    button: "ניהול אחראי הסעות",
    modalTitle: "ניהול אחראי הסעות",
    nameLabel: "שם",
    namePlaceholder: "שם האחראי",
    phoneLabel: "טלפון",
    phonePlaceholder: "05X-XXXXXXX",
    addButton: "הוספה",
    deleteAriaLabel: "מחיקת אחראי הסעות",
    empty: "לא נוספו אחראי הסעות עדיין",
    toast: {
      added: "אחראי ההסעות נוסף",
      deleted: "אחראי ההסעות הוסר",
      invalid: "יש להזין שם וטלפון",
    },
  },

  permissionsManager: {
    button: "ניהול הרשאות משתמשים",
    modalTitle: "הוסף משתמש",
    nameLabel: "שם",
    namePlaceholder: "שם המשתמש",
    passwordLabel: "סיסמה",
    passwordPlaceholder: "סיסמה",
    showPasswordAriaLabel: "הצג סיסמה",
    hidePasswordAriaLabel: "הסתר סיסמה",
    roleLabel: "הרשאה",
    /** Dynamic Roles & Permissions Phase 2: shown when a user's role can't be
     * resolved from the live catalog (should not normally happen given the
     * DB's FK guarantee). */
    unknownRole: "תפקיד לא ידוע",
    addButton: "הוספה",
    columns: {
      name: "שם",
      role: "הרשאה",
    },
    deleteAriaLabel: "מחיקת משתמש",
    empty: "לא נוספו משתמשים עדיין",
    toast: {
      added: "המשתמש נוסף",
      deleted: "המשתמש הוסר",
      invalid: "יש להזין שם וסיסמה",
    },
  },

  /** Dynamic Roles & Permissions Phase 2: real role management ("תפקידים"). */
  rolesManager: {
    button: "ניהול תפקידים והרשאות",
    modalTitle: "ניהול תפקידים",
    newRoleButton: "תפקיד חדש",
    editTitle: "עריכת תפקיד",
    createTitle: "תפקיד חדש",
    nameLabel: "שם התפקיד",
    namePlaceholder: "לדוגמה: רכז אזור",
    descriptionLabel: "תיאור",
    descriptionPlaceholder: "תיאור קצר של התפקיד",
    scopeLabel: "תחום עבודה",
    permissionsLabel: "הרשאות",
    saveButton: "שמירה",
    cancelButton: "ביטול",
    cloneButton: "שכפול",
    cloneSuffix: (name: string) => `${name} (עותק)`,
    deleteAriaLabel: "מחיקת תפקיד",
    editAriaLabel: "עריכת תפקיד",
    usersCount: (n: number) => `${n} משתמשים`,
    empty: "לא נוספו תפקידים עדיין",
    confirmDeleteTitle: "מחיקת תפקיד",
    confirmDeleteMessage:
      "פעולה זו אינה הפיכה. תפקידים עם משתמשים משויכים לא ניתנים למחיקה.",
    confirmDeleteButton: "מחיקת התפקיד",
    toast: {
      created: "התפקיד נוצר",
      updated: "התפקיד עודכן",
      deleted: "התפקיד נמחק",
      cloned: "התפקיד שוכפל",
      invalid: "יש להזין שם לתפקיד",
    },
  },

  /** Dynamic Non-Voting Reasons: catalog management ("ניהול סיבות
   * אי-הצבעה") - mirrors `rolesManager` above exactly. */
  nonVotingReasonsManager: {
    button: "ניהול סיבות אי-הצבעה",
    modalTitle: "ניהול סיבות אי-הצבעה",
    newButton: "סיבה חדשה",
    createTitle: "סיבה חדשה",
    editTitle: "עריכת סיבה",
    nameLabel: "שם הסיבה",
    namePlaceholder: "לדוגמה: לא עונה",
    descriptionLabel: "תיאור",
    descriptionPlaceholder: "תיאור קצר (אופציונלי)",
    saveButton: "שמירה",
    cancelButton: "ביטול",
    activeLabel: "פעילה",
    inactiveBadge: "מושבתת",
    moveUpAriaLabel: "הזזה למעלה",
    moveDownAriaLabel: "הזזה למטה",
    editAriaLabel: "עריכת סיבה",
    deleteAriaLabel: "מחיקת סיבה",
    activateAriaLabel: "הפעלת סיבה",
    deactivateAriaLabel: "השבתת סיבה",
    usageCount: (n: number) => `${n} בוחרים`,
    empty: "לא הוגדרו סיבות אי-הצבעה עדיין",
    confirmDeleteTitle: "מחיקת סיבה",
    confirmDeleteMessage: "פעולה זו אינה הפיכה. סיבות המשויכות לבוחרים לא ניתנות למחיקה.",
    confirmDeleteButton: "מחיקת הסיבה",
    toast: {
      created: "הסיבה נוצרה",
      updated: "הסיבה עודכנה",
      deleted: "הסיבה נמחקה",
      activated: "הסיבה הופעלה",
      deactivated: "הסיבה הושבתה",
      reordered: "הסדר נשמר",
      invalid: "יש להזין שם לסיבה",
    },
  },

  /** Local, non-server login gate for this screen only - checks against the
   * same roster managed in "ניהול הרשאות משתמשים" (see `electionDaySession.ts`). */
  session: {
    title: 'התחברות - חמ"ל בחירות',
    subtitle: "מסך יום הבחירות דורש התחברות נפרדת משאר המערכת",
    nameLabel: "שם משתמש",
    passwordLabel: "סיסמה",
    submit: "התחברות",
    signOut: "התנתקות",
    errors: {
      invalidCredentials: "שם משתמש או סיסמה שגויים",
    },
  },
} as const;
