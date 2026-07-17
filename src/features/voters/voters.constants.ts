import type { VoterSortKey } from "../../services/api";

export const SORT_LABELS: Record<VoterSortKey, string> = {
  lastName: "שם משפחה",
  city: "עיר",
  classifiedAt: "סווג לאחרונה",
  birthYear: "שנת לידה",
};

export const VOTERS_TEXT = {
  title: "בוחרים",
  loadingSubtitle: "טוען את פנקס הבוחרים…",
  subtitle: (total: number, isFiltered: boolean) =>
    `${total.toLocaleString("he-IL")} בוחרים${isFiltered ? " בסינון הנוכחי" : " בפנקס"}`,
  addVoter: "הוספת בוחר",
  searchPlaceholder: "חיפוש לפי שם, ת״ז או טלפון…",
  searchAriaLabel: "חיפוש בוחרים",
  clearSearchAriaLabel: "ניקוי חיפוש",
  filtersAriaLabel: "סינון",
  filtersSheetTitle: "סינון ומיון",
  showResults: (total: number) => `הצגת ${total.toLocaleString("he-IL")} תוצאות`,
  allCities: "כל הערים",
  allClassifications: "כל הסיווגים",
  sortByPrefix: "מיון:",
  columns: {
    select: "בחירת הכל",
    nameId: "שם + ת״ז",
    city: "עיר",
    address: "כתובת",
    phone: "טלפון",
    classification: "סיווג",
    quickClassify: "סיווג מהיר",
  },
  bulk: {
    selectedCount: (n: number) => `${n.toLocaleString("he-IL")} נבחרו`,
    quickClassifyLabel: "סיווג מהיר:",
    clearSelectionAriaLabel: "ביטול בחירה",
  },
  empty: {
    title: "לא נמצאו בוחרים",
    hint: "נסו לשנות את החיפוש או הסינון",
    clearFilters: "ניקוי סינון",
  },
  toast: {
    classificationRemoved: "הסיווג הוסר",
    classified: (label: string) => `סווג כ${label}`,
    familyClassified: (count: number, label: string) =>
      `${count} בני משפחה סווגו כ${label}`,
    bulkClassified: (count: number, label: string) =>
      `${count.toLocaleString("he-IL")} בוחרים סווגו כ${label}`,
    voterAdded: (name: string) => `${name} נוסף לפנקס`,
  },
} as const;

export const VOTER_DRAWER_TEXT = {
  fields: {
    address: "כתובת",
    phone: "טלפון",
    unknownPhone: "לא ידוע",
    birthYear: "שנת לידה",
    station: "קלפי",
    noStation: "-",
  },
  currentStatus: "סטטוס נוכחי",
  classifiedBy: (name: string) => `סווג ע״י ${name}`,
  includeFamily: "סיווג גם את בני הבית",
  classifyLabel: "סיווג:",
  historyTitle: "היסטוריית סיווגים",
  historyEmpty: "טרם סווג - היו הראשונים לתייג",
} as const;

export const ADD_VOTER_TEXT = {
  modalTitle: "הוספת בוחר",
  fields: {
    nationalId: "תעודת זהות",
    phone: "טלפון",
    firstName: "שם פרטי",
    lastName: "שם משפחה",
    city: "עיר",
    station: "קלפי",
    street: "רחוב",
    houseNumber: "מס' בית",
    birthYear: "שנת לידה",
  },
  placeholders: {
    nationalId: "9 ספרות",
    phone: "050-1234567",
    birthYear: "1985",
    pickCity: "בחירת עיר…",
    pickCityFirst: "בחרו עיר קודם",
    pickStation: "בחירת קלפי…",
  },
  errors: {
    invalidId: "מספר תעודת זהות לא תקין (בדיקת ספרת ביקורת)",
    invalidBirthYear: "שנת לידה לא סבירה לבעל זכות בחירה",
  },
  submit: "הוספה לפנקס",
  cancel: "ביטול",
} as const;
