export const ELECTION_DAY_TEXT = {
  title: "יום הבחירות",
  subtitle: (total: number) => `${total.toLocaleString("he-IL")} אנשי קשר להסעה`,
  loadingSubtitle: "טוען…",

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
    button: "טען נתונים מקובץ",
    columnsHint:
      "עמודות נדרשות: שם פרטי, שם משפחה, טלפון, אחראי (רחוב/מס' בית/עיר אופציונליים)",
    toast: {
      loaded: (count: number) => `נטענו ${count} אנשי קשר`,
      missingColumns:
        "לא זוהו כל העמודות הנדרשות (שם פרטי / שם משפחה / טלפון / אחראי) בקובץ",
      empty: "הקובץ ריק",
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
  },

  list: {
    columns: {
      name: "שם מלא",
      city: "עיר",
      address: "כתובת",
      phone: "טלפון",
      coordinator: "אחראי",
      status: "סטטוס הסעה",
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

  modal: {
    call: "חייגו",
    whatsapp: "תיאום הסעה בוואטסאפ",
    whatsappMessage: (name: string) =>
      `שלום ${name}, מתקשרים בנוגע לתיאום הסעה לקלפי ביום הבחירות. מתי נוח לך?`,
    markArranged: "סמנו כתואמה",
    markNotArranged: "בטלו סימון",
  },
} as const;
