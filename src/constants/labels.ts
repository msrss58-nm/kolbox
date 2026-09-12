/**
 * Hebrew display labels for domain enums. Kept separate from `types/index.ts`
 * so the type definitions stay pure and every UI string lives in `constants/`.
 */
import type { ActivistRank, Classification, UserRole } from "../types";

export const CLASSIFICATIONS: Classification[] = [
  "supporter",
  "potential",
  "opponent",
  "unclassified",
];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  supporter: "תומך",
  potential: "מתלבט",
  opponent: "מתנגד",
  unclassified: "לא מסווג",
};

export const RANK_LABELS: Record<ActivistRank, string> = {
  turai: "טוראי",
  rabat: 'רב"ט',
  samal: "סמל",
  rasar: 'רס"ר',
  segen: "סגן",
  seren: "סרן",
  aluf: "אלוף",
};

/** Platform Stage 9: product modules a workspace can be entitled to. Keys
 * mirror public.platform_modules.key. An unknown key renders as itself
 * (`moduleLabel`) rather than being hidden - the server is the authority on
 * which modules exist. */
export const MODULE_LABELS: Record<string, string> = {
  voter_management: "ניהול בוחרים",
  election_day: "ניהול יום הבחירות",
  budget: "ניהול תקציב",
};

export function moduleLabel(key: string): string {
  return MODULE_LABELS[key] ?? key;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  manager: "מנהל קמפיין",
  activist: "פעיל",
  observer: "משקיף",
};
