/** Generic copy for the shared administration shell. Surface-specific copy
 * (titles, nav labels, logout) is passed in by each caller, so this file
 * never carries one principal's strings onto another's bundle. */
export const ADMIN_SHELL_TEXT = {
  openMenu: "פתיחת תפריט הניווט",
  closeMenu: "סגירת תפריט הניווט",
  navLabel: "ניווט ראשי",
} as const;
