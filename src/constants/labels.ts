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

export const ROLE_LABELS: Record<UserRole, string> = {
  manager: "מנהל קמפיין",
  activist: "פעיל",
  observer: "משקיף",
};
