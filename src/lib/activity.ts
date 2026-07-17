import { APP_CONFIG } from "../constants/config";
import type { ClassificationEvent } from "../types";

const WEEK_MS = 7 * 86_400_000;

export interface WeeklyActivityBucket {
  label: string;
  count: number;
}

/**
 * Buckets classification events into `APP_CONFIG.weeklyActivityWeeks` weekly
 * counts, oldest → newest ("השבוע" last). `now` must be captured by the
 * caller (e.g. `Date.now()` inside an async fetcher) - never computed here
 * during render, since this can be called from a memoized/pure context.
 */
export function binWeeklyActivity(
  events: ClassificationEvent[],
  now: number,
): WeeklyActivityBucket[] {
  const weeks = APP_CONFIG.weeklyActivityWeeks;
  const bins = [...Array(weeks)].map((_, i) => ({
    label: i === weeks - 1 ? "השבוע" : `-${weeks - 1 - i}ש'`,
    start: now - (weeks - i) * WEEK_MS,
    end: now - (weeks - 1 - i) * WEEK_MS,
    count: 0,
  }));
  for (const e of events) {
    const t = new Date(e.at).getTime();
    const bin = bins.find((b) => t >= b.start && t < b.end);
    if (bin) bin.count++;
  }
  return bins.map(({ label, count }) => ({ label, count }));
}
