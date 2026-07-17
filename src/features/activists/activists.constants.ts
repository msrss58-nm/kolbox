export const ACTIVISTS_TEXT = {
  title: "פעילים",
  loadingSubtitle: "טוען את צוות השטח…",
  subtitle: (count: number) => `${count.toLocaleString("he-IL")} פעילי שטח בקמפיין`,
  addActivist: "הוספת פעיל",
  tagsSuffix: "סיווגים",
  maxRank: "דרגה מקסימלית 🎖",
  nextRankProgress: (remaining: number, nextLabel: string) =>
    `עוד ${remaining} ל${nextLabel}`,
  empty: {
    title: "אין עדיין פעילים",
    hint: "הוסיפו את פעיל השטח הראשון כדי להתחיל לסווג",
    action: "הוספת פעיל ראשון",
  },
  columns: {
    rank: "#",
    name: "שם",
    area: "אזור",
    phone: "טלפון",
    rankBadge: "דרגה",
    progress: "התקדמות לדרגה הבאה",
    lastActive: "פעילות אחרונה",
  },
} as const;

export const ACTIVIST_MODAL_TEXT = {
  addTitle: "הזמנת פעיל חדש",
  editTitle: "עריכת פעיל",
  fields: {
    firstName: "שם פרטי",
    lastName: "שם משפחה",
    email: "אימייל",
    phone: "טלפון",
    area: "אזור פעילות",
  },
  placeholders: {
    email: "activist@example.com",
    phone: "050-1234567",
    area: "למשל: אשקלון",
  },
  inviteHint: "הפעיל יקבל קישור כניסה באימייל - ללא צורך בסיסמה",
  submitAdd: "שליחת הזמנה",
  submitEdit: "שמירה",
  toast: {
    updated: "פרטי הפעיל עודכנו",
    invited: (name: string) => `הזמנה נשלחה ל${name} 📩`,
  },
} as const;

export const ACTIVIST_DRAWER_TEXT = {
  totalTags: "סה״כ סיווגים",
  editButton: "עריכת פרטי הפעיל",
  nextRank: (remaining: number, nextLabel: string) =>
    `עוד ${remaining} סיווגים לדרגת ${nextLabel}`,
  maxRank: "🎖 הדרגה הגבוהה ביותר",
  fields: {
    area: "אזור פעילות",
    phone: "טלפון",
    joined: "הצטרפות",
    lastActive: "פעילות אחרונה",
  },
  breakdownTitle: "פילוח הסיווגים",
  activityTitle: (weeks: number) => `פעילות · ${weeks} שבועות`,
  activityTooltipLabel: "סיווגים",
} as const;
