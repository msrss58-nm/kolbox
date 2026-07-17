import type { ActivistRank } from "../types";

/** Gamified rank thresholds by classification (tag) count, ascending. */
export const RANK_THRESHOLDS: { rank: ActivistRank; min: number }[] = [
  { rank: "turai", min: 0 },
  { rank: "rabat", min: 5 },
  { rank: "samal", min: 15 },
  { rank: "rasar", min: 40 },
  { rank: "segen", min: 80 },
  { rank: "seren", min: 150 },
  { rank: "aluf", min: 300 },
];

export function getRank(tagCount: number): ActivistRank {
  let current: ActivistRank = "turai";
  for (const { rank, min } of RANK_THRESHOLDS) {
    if (tagCount >= min) current = rank;
  }
  return current;
}

/** Tags remaining until the next rank, or null at the top rank. */
export function nextRankProgress(
  tagCount: number,
): { next: ActivistRank; remaining: number; pct: number } | null {
  const idx = RANK_THRESHOLDS.findIndex(({ min }, i) => {
    const nextMin = RANK_THRESHOLDS[i + 1]?.min ?? Infinity;
    return tagCount >= min && tagCount < nextMin;
  });
  const next = RANK_THRESHOLDS[idx + 1];
  if (!next) return null;
  const prevMin = RANK_THRESHOLDS[idx].min;
  return {
    next: next.rank,
    remaining: next.min - tagCount,
    pct: Math.round(((tagCount - prevMin) / (next.min - prevMin)) * 100),
  };
}
