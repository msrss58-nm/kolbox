import { APP_CONFIG } from "../../constants/config";

export const IMPORT_TEXT = {
  title: "טעינת נתונים",
  subtitle: "ייבוא פנקס בוחרים מקובץ Excel או JSON",
  exportButton: "ייצוא הפנקס",
  steps: {
    upload: "1. בחירת קובץ",
    map: "2. מיפוי ובדיקה",
    done: "3. סיכום",
  },
  upload: {
    dropHint: "גררו לכאן קובץ Excel / JSON או לחצו לבחירה",
    fileTypes: ".xlsx · .csv · .json",
    downloadTemplate: "הורדת תבנית לדוגמה",
    dropzoneAriaLabel: "העלאת קובץ",
    demoTitle: "נתוני הדגמה",
    demoHint: `איפוס הקמפיין וטעינת ${APP_CONFIG.demoVoterCount.toLocaleString("he-IL")} בוחרים מדומים - נהדר להתנסות`,
    demoButton: "טעינת נתוני הדגמה",
  },
  mapping: {
    title: "מיפוי עמודות",
    fileSummary: (fileName: string, rowCount: number) =>
      `${fileName} · ${rowCount.toLocaleString("he-IL")} שורות`,
    unmappedOption: "- לא ממופה -",
    columnFallback: (index: number) => `עמודה ${index}`,
    validRows: "שורות תקינות",
    invalidRows: 'שורות שידולגו (ת"ז/שם חסרים)',
    previewTitle: (count: number) => `תצוגה מקדימה · ${count} שורות ראשונות`,
    commitButton: (count: number) => `ייבוא ${count.toLocaleString("he-IL")} בוחרים`,
    back: "חזרה",
    missingRequired: "יש למפות את שדות החובה: תעודת זהות, שם פרטי ושם משפחה",
  },
  summary: {
    title: "הייבוא הושלם!",
    added: "נוספו",
    updated: "עודכנו",
    skipped: "דולגו",
    skippedDetails: (count: number) =>
      `פירוט השורות שדולגו (${count.toLocaleString("he-IL")})`,
    skippedRow: (row: number, reason: string) => `שורה ${row}: ${reason}`,
    skippedMore: "…ועוד",
    goToVoters: "לפנקס הבוחרים",
    importAnother: "ייבוא קובץ נוסף",
  },
  errors: {
    emptyFile: "לא נמצאו שורות נתונים בקובץ",
    readError: "שגיאה בקריאת הקובץ",
    importError: "שגיאה בייבוא",
  },
  toast: {
    demoLoaded: `נתוני ההדגמה נטענו - ${APP_CONFIG.demoVoterCount.toLocaleString("he-IL")} בוחרים`,
    exported: (count: number) =>
      `${count.toLocaleString("he-IL")} בוחרים יוצאו לקובץ Excel`,
  },
} as const;
