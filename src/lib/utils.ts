import { clsx, type ClassValue } from "clsx";

/** Tailwind-friendly conditional class join. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** 12,345 → "12,345" with Hebrew locale grouping. */
export function fmtNum(n: number): string {
  return n.toLocaleString("he-IL");
}

/** Voting-turnout percentage display rule: below 10% a whole-number round
 * hides real movement (8/1928 → "0%"), so under 10% shows one decimal
 * (0.4%) and 10%+ shows a whole number (42%). Zero always shows as a plain
 * "0%", never "0.0%". Business calculation (the raw ratio) is untouched -
 * this only controls how that number is rendered. */
export function fmtVotedPct(pct: number): string {
  if (pct === 0) return "0%";
  if (pct < 10) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** ISO → "לפני 3 ימים" style relative time. */
export function fmtRelative(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const rtf = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return rtf.format(-mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return new Date(isoDate).toLocaleDateString("he-IL");
}

export function fmtDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("he-IL", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
