/** Generic action words reused across multiple features' forms/modals. */
export const COMMON_TEXT = {
  cancel: "ביטול",
  save: "שמירה",
  add: "הוספה",
  loading: "טוען…",
  genericError: "אירעה שגיאה, נסו שוב",
  networkError: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב",
  multiSelect: {
    selectedCount: (n: number) => `${n} נבחרו`,
    clearAll: "נקה הכל",
  },
  pagination: {
    rowsPerPage: "שורות בעמוד",
    prevPage: "עמוד קודם",
    nextPage: "עמוד הבא",
    pageOf: (page: number, totalPages: number) => `עמוד ${page} מתוך ${totalPages}`,
    showingRange: (from: number, to: number, total: number) =>
      `מציג ${from.toLocaleString("he-IL")}–${to.toLocaleString("he-IL")} מתוך ${total.toLocaleString("he-IL")}`,
  },
} as const;
