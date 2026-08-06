/** Custom Reminder Time feature - unit test for the pure display-formatting
 * helper. Run via: npx esbuild scripts/smoke-reminder-display.ts --bundle --format=cjs --outfile=scripts/smoke-reminder-display.cjs && node scripts/smoke-reminder-display.cjs
 *
 * `formatReminderDisplay` (`src/features/election-day/reminderDisplay.ts`)
 * is the one place a reminder's absolute `reminderAt` becomes the Hebrew
 * string shown in the UI/toasts - today's reminders show only the time
 * (unchanged wording from before this feature), any other date also shows
 * the date, so a far-future custom reminder is never ambiguous about which
 * day it's for.
 *
 * Every Date below is built via the local-time constructor
 * (`new Date(year, monthIndex, day, hour, minute)`), never an ISO/UTC string
 * literal - `formatReminderDisplay` compares calendar fields via local
 * getters (`getFullYear`/`getMonth`/`getDate`), so a UTC literal's "same
 * day" status would silently depend on whichever timezone this test happens
 * to run in. Local constructors make every case correct regardless of the
 * runner's timezone.
 */
import { formatReminderDisplay } from "../src/features/election-day/reminderDisplay";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const NOW = new Date(2026, 7, 6, 20, 0); // fixed reference "now": 6 Aug 2026, 20:00 local

// ---- same calendar day as `now` -> time only, no date ------------------
const laterToday = new Date(2026, 7, 6, 22, 0);
assert(
  formatReminderDisplay(laterToday.toISOString(), NOW) ===
    `בשעה ${laterToday.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`,
  "a reminder later today shows only the time, no date",
);

const earlierToday = new Date(2026, 7, 6, 14, 0);
assert(
  formatReminderDisplay(earlierToday.toISOString(), NOW) ===
    `בשעה ${earlierToday.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`,
  "a reminder earlier today (already-passed time) still shows only the time - formatting doesn't care whether it's in the past",
);

// ---- a different calendar day -> date + time ----------------------------
const tomorrow = new Date(2026, 7, 7, 9, 0);
const tomorrowFormatted = formatReminderDisplay(tomorrow.toISOString(), NOW);
assert(tomorrowFormatted.startsWith("ב-"), 'a reminder on a different day is prefixed with "ב-"');
assert(
  tomorrowFormatted.includes(
    tomorrow.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }),
  ),
  "a reminder on a different day still includes the correct time",
);
assert(
  tomorrowFormatted.includes(
    tomorrow.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" }),
  ),
  "a reminder on a different day includes the date",
);

const nextWeek = new Date(2026, 7, 13, 10, 30);
const nextWeekFormatted = formatReminderDisplay(nextWeek.toISOString(), NOW);
assert(
  nextWeekFormatted.includes(
    nextWeek.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" }),
  ),
  "a week-out reminder includes the correct date",
);

// ---- year boundary: same month/day, different year is NOT "today" ------
const sameDayNextYear = new Date(2027, 7, 6, 22, 0);
assert(
  formatReminderDisplay(sameDayNextYear.toISOString(), NOW).startsWith("ב-"),
  'same month/day but a different year is never mistaken for "today"',
);

// ---- default `now` parameter (no explicit second arg) still works -------
const inOneHour = new Date(Date.now() + 60 * 60 * 1000);
assert(
  formatReminderDisplay(inOneHour.toISOString()) ===
    `בשעה ${inOneHour.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`,
  "omitting `now` defaults to the real current time - a same-day reminder still formats as time-only",
);

if (process.exitCode) {
  console.error("\nsmoke-reminder-display: FAILED");
} else {
  console.log("\nsmoke-reminder-display: all checks passed");
}
