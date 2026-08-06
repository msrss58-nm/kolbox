/** Formats a reminder's absolute time for display - just the time
 * ("בשעה 22:00") when the reminder fires today (local calendar date),
 * otherwise time + date ("ב-17/08/2026 בשעה 22:00") so a far-future
 * reminder is never ambiguous about which day it's for. Pure function - no
 * React, no implicit `Date.now()` (the caller passes `now` explicitly, e.g.
 * for tests), directly usable from `ELECTION_DAY_TEXT.reminder.activeLabel`/
 * `toast.setAt`. */
export function formatReminderDisplay(
  reminderAt: string,
  now: Date = new Date(),
): string {
  const at = new Date(reminderAt);
  const time = at.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  const isToday =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (isToday) return `בשעה ${time}`;
  const date = at.toLocaleDateString("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `ב-${date} בשעה ${time}`;
}
