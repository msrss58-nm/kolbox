// Stage 2 voting-role REAL UI proof. Runs against the voting-role harness
// (vite.harness.config.ts + scripts/harness/) - the real, unmodified
// ElectionDayPage component tree with only usePermissions swapped for a
// mock pinned to "voting" via the real hasPermission()/PERMISSIONS_BY_ROLE
// engine. No DB/migration/Supabase change - "voting" still cannot log in
// for real (see resolveEffectiveRole.ts), this is the way to exercise its
// rendered UI before that migration exists. Read-only: fetches the real
// dataset, never clicks a mutating button.
import { chromium } from "playwright";

const BASE = process.env.HARNESS_URL ?? "http://localhost:5174/scripts/harness/index.html";

const results = [];
const errors = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 });
await page.waitForSelector("text=שם מלא", { timeout: 20000 });

// ---- must NOT see: every admin/manager action ---------------------------
assert(
  (await page.locator('button:has-text("טען קובץ בוחרים")').count()) === 0,
  "voting: does NOT see Import",
);
assert(
  (await page.locator('button:has-text("מחק קובץ בוחרים")').count()) === 0,
  "voting: does NOT see clear-data",
);
assert(
  (await page.locator('button:has-text("ניהול אחראי הסעות")').count()) === 0,
  "voting: does NOT see manage-ride-coordinators",
);
assert(
  (await page.locator('button:has-text("ניהול הרשאות משתמשים")').count()) === 0,
  "voting: does NOT see manage-users",
);
assert(
  (await page.locator('button:has-text("שלח דוח תמונת מצב")').count()) === 0,
  "voting: does NOT see WhatsApp snapshot-report (export)",
);
assert(
  (await page.locator('button:has-text("ייצוא לאקסל")').count()) === 0 &&
    (await page.locator('button', { hasText: /ייצוא/ }).count()) === 0,
  "voting: does NOT see Excel export",
);
assert(
  (await page.locator('button[aria-label="קביעת יעד"]').count()) === 0,
  "voting: does NOT see countdown settings (deadline management)",
);
assert(
  (await page.locator("text=התקדמות לפי אחראי").count()) === 0,
  "voting: does NOT see the by-coordinator dashboard card",
);
assert(
  (await page.locator("text=תיאום הסעה").count()) === 0,
  "voting: does NOT see the ride-coordination dashboard card",
);

// ---- row/list columns: exactly the approved 6, nothing operational -----
const headerText = await page
  .locator("div.hidden.border-b.border-slate-100")
  .first()
  .innerText();
assert(headerText.includes("שם"), "voting: row header shows name");
assert(headerText.includes("רחוב"), "voting: row header shows street");
assert(headerText.includes("מס' בית"), "voting: row header shows house number");
assert(headerText.includes("עיר"), "voting: row header shows city");
assert(headerText.includes("טלפון"), "voting: row header shows phone");
assert(headerText.includes("סטטוס"), "voting: row header shows voted status");
assert(!headerText.includes("מס\"ד"), "voting: row header does NOT show masad");
assert(!headerText.includes("אחראי"), "voting: row header does NOT show coordinator");
assert(!headerText.includes("הערות"), "voting: row header does NOT show notes");

// ---- coordinator/status filters absent, city filter still present ------
assert(
  (await page.locator("text=כל האחראים").count()) === 0,
  "voting: coordinator filter dropdown absent",
);
assert(
  (await page.locator("text=כל הסטטוסים").count()) === 0,
  "voting: ride-status filter dropdown absent",
);
assert(
  (await page.locator("text=כל הערים").count()) > 0,
  "voting: city filter dropdown present (universal, approved)",
);

// ---- open a real contact's modal: check button-level gating ------------
await page.locator("button.block.w-full").first().click();
await page.waitForSelector('text=📍', { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(500);

assert(
  (await page.locator('button:has-text("סימון כהצביע")').count()) > 0 ||
    (await page.locator('button:has-text("בטל סימון הצבעה")').count()) > 0,
  "voting: contact modal shows the mark/unmark-voted button",
);
assert(
  (await page.locator('button:has-text("חיוג מהיר")').count()) > 0,
  "voting: contact modal shows the call button",
);
assert(
  (await page.locator("text=אחראי:").count()) === 0,
  "voting: contact modal does NOT show the coordinator line",
);
assert(
  (await page.locator("text=מס\"ד:").count()) === 0,
  "voting: contact modal does NOT show the masad line",
);
assert(
  (await page.locator("textarea").count()) === 0,
  "voting: contact modal does NOT show the notes textarea",
);
assert(
  (await page.locator('[aria-label="עריכת מספר טלפון"]').count()) === 0,
  "voting: contact modal does NOT show the phone-edit pencil",
);
assert(
  (await page.locator('button:has-text("הוסף מספר")').count()) === 0,
  "voting: contact modal does NOT show an add-phone button",
);
assert(
  (await page.locator('button', { hasText: /תזכורת/ }).count()) === 0,
  "voting: contact modal shows NO reminder buttons",
);
assert(
  (await page.locator('button', { hasText: /הסעה/ }).count()) === 0,
  "voting: contact modal shows NO ride-coordination buttons",
);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} console/page errors:`);
  for (const e of errors) console.log(" -", e);
}
if (failed.length > 0 || errors.length > 0) process.exit(1);
