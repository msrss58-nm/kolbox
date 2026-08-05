// Stage 2 UI-permission-wiring verification driver - manager + operations
// real login against the live dev server (same real Supabase project as
// production). Uses temporary PermissionUser accounts created/deleted via
// direct RPC (same methodology as prior production verification passes) -
// no mutation to any voter record, no click on any mutating button (mark
// voted / arrange ride / etc.) - visibility checks only.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const MGR_NAME = process.env.MGR_NAME;
const OPS_NAME = process.env.OPS_NAME;
const PASS = process.env.PASS;
if (!MGR_NAME || !OPS_NAME || !PASS) {
  console.error("FAIL: MGR_NAME/OPS_NAME/PASS env vars required");
  process.exit(1);
}

const errors = [];
const results = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();

async function login(page, name, password) {
  await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });
  // Roster is non-empty (real accounts + our temp accounts exist), so the
  // login screen must appear.
  await page.waitForSelector("text=התחברות - חמ\"ל בחירות", { timeout: 15000 });
  await page.getByLabel("שם משתמש").fill(name);
  await page.locator('input[type="password"]').fill(password);
  await page.click('button:has-text("התחברות")');
  // /election-day/login is a top-level route (no AppLayout, no <nav>) -
  // wait for the actual post-login URL, not just a text substring (the
  // login screen's own title "התחברות - חמ"ל בחירות" contains the same
  // "חמ"ל בחירות" substring the post-login page uses, so a text-only wait
  // could resolve against the stale login screen before the redirect).
  await page.waitForURL("**/election-day", { timeout: 15000 });
  await page.waitForSelector("aside nav", { timeout: 15000 });
}

// ---- MANAGER: regression - everything that existed before must still ---
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[manager] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[manager] ${e.message}`));

  await login(page, MGR_NAME, PASS);
  await page.waitForSelector('text=טען קובץ בוחרים', { timeout: 15000 });

  assert(
    await page.locator('button:has-text("טען קובץ בוחרים")').isVisible(),
    "manager: sees Import button",
  );
  assert(
    await page.locator('button:has-text("מחק קובץ בוחרים")').isVisible(),
    "manager: sees clear-data button",
  );
  assert(
    await page.locator('button:has-text("ניהול אחראי הסעות")').isVisible(),
    "manager: sees manage-ride-coordinators button",
  );
  assert(
    await page.locator('button:has-text("ניהול הרשאות משתמשים")').isVisible(),
    "manager: sees manage-users button",
  );
  assert(
    await page.locator('button:has-text("שלח דוח תמונת מצב")').isVisible(),
    "manager: sees WhatsApp snapshot-report button",
  );
  assert(
    await page.locator('button[aria-label="קביעת יעד"]').isVisible(),
    "manager: sees countdown settings gear",
  );

  // Main-app nav must NOT be restricted for manager.
  const dashboardLink = page.locator('nav a[href="/"]').first();
  assert(
    (await dashboardLink.count()) > 0,
    "manager: main-app dashboard nav item is a real link (not disabled)",
  );

  // Search/filters row (full unfiltered dataset -> definitely has data)
  await page.waitForSelector('input[placeholder]', { timeout: 10000 }).catch(() => {});
  const coordinatorFilterVisible = await page
    .locator("text=אחראי")
    .first()
    .isVisible()
    .catch(() => false);
  assert(coordinatorFilterVisible, "manager: coordinator filter area present");

  await ctx.close();
}

// ---- OPERATIONS (real login=user, mapped to operations): data-independent
// checks - no scoped voters for this synthetic coordinator name, so the
// search/filter/dashboard rows never render at all (data-gated, not a
// permission bug - documented limitation, see report).
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on(
    "console",
    (m) => m.type() === "error" && errors.push(`[operations] ${m.text()}`),
  );
  page.on("pageerror", (e) => errors.push(`[operations] ${e.message}`));

  await login(page, OPS_NAME, PASS);

  assert(
    (await page.locator('button:has-text("טען קובץ בוחרים")').count()) === 0,
    "operations: does NOT see Import button",
  );
  assert(
    (await page.locator('button:has-text("מחק קובץ בוחרים")').count()) === 0,
    "operations: does NOT see clear-data button",
  );
  assert(
    (await page.locator('button:has-text("ניהול אחראי הסעות")').count()) === 0,
    "operations: does NOT see manage-ride-coordinators button",
  );
  assert(
    (await page.locator('button:has-text("ניהול הרשאות משתמשים")').count()) === 0,
    "operations: does NOT see manage-users button",
  );
  assert(
    (await page.locator('button[aria-label="קביעת יעד"]').count()) === 0,
    "operations: does NOT see countdown settings gear",
  );

  // Main-app nav MUST be restricted: other nav items are inert <span>s,
  // not real <a> links.
  const dashboardRealLink = await page.locator('nav a[href="/"]').count();
  assert(
    dashboardRealLink === 0,
    "operations: main-app dashboard nav item is NOT a real link (restricted)",
  );
  const electionDayRealLink = await page.locator(`nav a[href="/election-day"]`).count();
  assert(
    electionDayRealLink > 0,
    "operations: /election-day itself remains a real, clickable link",
  );

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} console/page errors:`);
  for (const e of errors) console.log(" -", e);
}
if (failed.length > 0 || errors.length > 0) process.exit(1);
