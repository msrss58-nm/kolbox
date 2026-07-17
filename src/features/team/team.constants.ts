export const TEAM_TEXT = {
  title: "צוות",
  loadingSubtitle: "טוען את הצוות…",
  subtitle: (count: number) => `${count.toLocaleString("he-IL")} חברי צוות בקמפיין`,
  addMember: "הוספת חבר צוות",
  you: "(אתם)",
  empty: {
    title: "אין עדיין חברי צוות",
    hint: "הוסיפו את חבר הצוות הראשון",
  },
  columns: {
    name: "שם",
    email: "אימייל",
    role: "תפקיד",
    area: "אזור",
    joined: "הצטרפות",
    actions: "",
  },
  removeTitle: "הסרת חבר צוות",
  removeConfirm: (name: string) => `להסיר את ${name} מהצוות? הפעולה בלתי הפיכה.`,
  removeAction: "הסרה",
  editAriaLabel: (name: string) => `עריכת ${name}`,
  removeAriaLabel: (name: string) => `הסרת ${name}`,
} as const;

export const TEAM_MODAL_TEXT = {
  addTitle: "הוספת חבר צוות",
  editTitle: "עריכת חבר צוות",
  fields: {
    name: "שם מלא",
    email: "אימייל",
    phone: "טלפון",
    area: "אזור פעילות",
    role: "תפקיד",
  },
  placeholders: {
    email: "user@example.com",
    phone: "050-1234567",
    area: "למשל: אשקלון",
  },
  addHint: "חבר הצוות יקבל קוד כניסה באימייל בפעם הראשונה שינסה להתחבר - ללא צורך בסיסמה",
  submitAdd: "הוספה לצוות",
  submitEdit: "שמירה",
  toast: {
    added: (name: string) => `${name} נוסף/ה לצוות`,
    updated: "הפרטים עודכנו",
    removed: (name: string) => `${name} הוסר/ה מהצוות`,
  },
  errors: {
    lastManager: "לא ניתן להסיר את תפקיד המנהל מחבר הצוות היחיד שנותר",
  },
} as const;
