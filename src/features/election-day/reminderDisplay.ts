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

/** Formats how long a DUE reminder has been waiting, in natural Hebrew -
 * "12 דקות" / "שעה ו־20 דקות" / "3 שעות". Deliberately never uses the word
 * "מאחר" (Manager Dashboard Reminders' own product requirement - this
 * describes elapsed wait time, not lateness/blame). Pure function, `now`
 * passed explicitly (same convention as `formatReminderDisplay`) so a
 * ticking caller controls its own re-render cadence. */
export function formatWaitingDuration(
  reminderAt: string,
  now: Date = new Date(),
): string {
  const totalMinutes = Math.max(
    0,
    Math.floor((now.getTime() - new Date(reminderAt).getTime()) / 60_000),
  );
  if (totalMinutes < 1) return "פחות מדקה";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const minutesPart = minutes === 1 ? "דקה" : `${minutes} דקות`;

  if (hours === 0) return minutesPart;
  const hoursPart = hours === 1 ? "שעה" : `${hours} שעות`;
  return minutes === 0 ? hoursPart : `${hoursPart} ו־${minutesPart}`;
}
