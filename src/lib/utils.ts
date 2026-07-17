import { clsx, type ClassValue } from "clsx";

/** Tailwind-friendly conditional class join. */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/** 12,345 → "12,345" with Hebrew locale grouping. */
export function fmtNum(n: number): string {
  return n.toLocaleString("he-IL");
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
