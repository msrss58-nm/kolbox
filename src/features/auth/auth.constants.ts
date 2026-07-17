import { Megaphone, Users, type LucideIcon } from "lucide-react";

export const AUTH_TEXT = {
  brandHeadline: "כל קול נספר.",
  brandSubheadline: "כל תומך מגיע לקלפי.",
  brandBody:
    "קולבוקס הופכת את פנקס הבוחרים למכונת שטח: סיווג תומכים, ניהול פעילים ומעקב בזמן אמת - עד הקול האחרון.",

  emailStep: {
    title: "כניסה לקולבוקס",
    subtitle: "הזינו את כתובת האימייל שלכם",
    emailLabel: "אימייל",
    submit: "שליחת קוד",
  },

  codeStep: {
    title: "הזינו את הקוד",
    subtitle: (email: string) => `שלחנו קוד בן 6 ספרות לכתובת ${email}`,
    codeLabel: "קוד",
    submit: "אימות והתחברות",
    back: "כתובת אימייל אחרת",
    resend: "שליחת קוד חדש",
  },

  pending: {
    title: "החשבון ממתין לאישור",
    hint: "החשבון שלכם קיים אך טרם שויך לתפקיד בקמפיין. פנו למנהל הקמפיין שלכם.",
    signOut: "התנתקות",
  },

  errors: {
    emailNotFound: "האימייל לא נמצא במערכת. פנו למנהל הקמפיין שלכם.",
    rateLimited: "נשלחו יותר מדי קודים לכתובת הזו. נסו שוב בעוד כמה דקות.",
    invalidCode: "הקוד שגוי או שפג תוקפו",
    generic: "משהו השתבש, נסו שוב",
  },
} as const;

/**
 * Dev-only shortcut: entering this email skips the real OTP flow entirely
 * and signs in locally as a manager. Guarded by `import.meta.env.DEV` at
 * every call site, so it never compiles into a production build.
 */
export const DEV_BYPASS_EMAIL = "111@gmail.com";

export const BRAND_HIGHLIGHTS: { icon: LucideIcon; text: string }[] = [
  { icon: Users, text: "ניהול אלפי בוחרים בחיפוש מיידי" },
  { icon: Megaphone, text: "פעילי שטח עם דירוגים ותחרות" },
];
