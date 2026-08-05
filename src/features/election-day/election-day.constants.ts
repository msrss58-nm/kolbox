export const REMINDER_MINUTES_OPTIONS = [15, 30, 60] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

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
    },
    showUnvotedOnly: "הצג רק מי שטרם הצביע",
  },

  reminder: {
    badge: "תזכורת",
    button: "תזכורת",
    cancelButton: "ביטול תזכורת",
    activeLabel: (time: string) => `תזכורת בשעה ${time}`,
    options: {
      15: "15 דקות",
      30: "30 דקות",
      60: "שעה",
    },
    toast: {
      set: (label: string) => `התזכורת נקבעה - בעוד ${label}`,
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
    roleOptions: {
      user: "משתמש",
      manager: "מנהל",
    },
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
