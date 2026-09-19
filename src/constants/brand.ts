import { Megaphone, Users, type LucideIcon } from "lucide-react";

/**
 * The KOLBOX sign-in brand panel's copy.
 *
 * Cross-cutting rather than feature-local (`src/constants/`, per the project's
 * constants convention) because the branded sign-in shell it belongs to is now
 * shared: it is rendered both by the dedicated Auth origin's entry screen and
 * by the legacy main-app login page. Keeping the copy here is what lets those
 * two render the SAME panel instead of two drifting copies of it.
 */
export const BRAND_PANEL_TEXT = {
  headline: "כל קול נספר.",
  subheadline: "כל תומך מגיע לקלפי.",
  body: "קולבוקס הופכת את פנקס הבוחרים למכונת שטח: סיווג תומכים, ניהול פעילים ומעקב בזמן אמת - עד הקול האחרון.",
} as const;

export const BRAND_HIGHLIGHTS: { icon: LucideIcon; text: string }[] = [
  { icon: Users, text: "ניהול אלפי בוחרים בחיפוש מיידי" },
  { icon: Megaphone, text: "פעילי שטח עם דירוגים ותחרות" },
];
