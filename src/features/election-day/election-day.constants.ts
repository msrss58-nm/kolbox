export const REMINDER_MINUTES_OPTIONS = [15, 30, 60] as const;
export type ReminderMinutes = (typeof REMINDER_MINUTES_OPTIONS)[number];

export const ELECTION_DAY_TEXT = {
  title: '📊 חמ"ל בחירות - מערכת שליטה',
  subtitle: "ניהול, סינון וחיוג ישיר לבוחרים בלחיצת כפתור",
  loadingSubtitle: "טוען…",

  searchPlaceholder: "🔍 חיפוש לפי שם או טלפון…",
  searchAriaLabel: "חיפוש אנשי קשר",
  clearSearchAriaLabel: "ניקוי חיפוש",

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
      "עמודות נדרשות: שם פרטי, שם משפחה, טלפון, אחראי (רחוב/מס' בית/עיר אופציונליים)",
    toast: {
      loaded: (count: number) => `נטענו ${count} אנשי קשר`,
      missingColumns:
        "לא זוהו כל העמודות הנדרשות (שם פרטי / שם משפחה / טלפון / אחראי) בקובץ",
      empty: "הקובץ ריק",
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
    call: "חייגו",
    whatsapp: "תיאום הסעה בוואטסאפ",
    whatsappMessage: (name: string) =>
      `שלום ${name}, מתקשרים בנוגע לתיאום הסעה לקלפי ביום הבחירות. מתי נוח לך?`,
    markArranged: "סמנו כתואמה",
    markNotArranged: "בטלו סימון",
  },

  notes: {
    label: "הערות ועדכוני סטטוס",
    placeholder: "לדוגמה: הבטיח לצאת ב-18:00, לא עונה, צריך לברר לגבי המשפחה...",
    saving: "שומר...",
    saved: "נשמר בהצלחה",
  },

  driver: {
    sendButton: "שלח לאחראי הסעות",
    chooseCoordinator: "בחרו אחראי הסעות",
    noCoordinators: "לא נוספו אחראי הסעות - הוסיפו אחד בניהול אחראי הסעות",
    rideArrangedNote: "תואמה הסעה",
    message: (voter: {
      name: string;
      address: string;
      phone: string;
      masad: string;
      coordinator: string;
    }) =>
      `בקשת הסעה חדשה לבוחר\n\nשם הבוחר: ${voter.name}\nכתובת איסוף: ${voter.address || "לא צוינה כתובת"}\nטלפון ליצירת קשר: ${voter.phone}\nמספר מסד: ${voter.masad || "-"}\nאחראי: ${voter.coordinator}\n\nנא לתאם איתו ולעדכן בהקדם!`,
    toast: {
      sent: (driverName: string) => `בקשת ההסעה נשלחה ל${driverName}`,
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
} as const;
