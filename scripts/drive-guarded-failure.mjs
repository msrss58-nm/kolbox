// Stage 3 verification: proves ConfirmDialog/form-reset only treat a
// mutation as successful when guardedAction's wrapped result is genuinely
// non-undefined - the same `undefined` shape a permission denial returns.
// Uses a real, fully-permitted manager account (no permission block
// involved) but injects a network-level failure via page.route so the
// underlying request is intercepted and NEVER reaches Supabase - 0 risk to
// the real 1928-voter dataset or the real PermissionUser roster, since the
// DELETE/RPC call is answered locally by Playwright, not by Supabase.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const MGR_NAME = process.env.MGR_NAME;
const PASS = process.env.PASS;
if (!SUPABASE_URL || !MGR_NAME || !PASS) {
  console.error("FAIL: VITE_SUPABASE_URL/MGR_NAME/PASS env vars required");
  process.exit(1);
}

const results = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
// "Failed to load resource: ... 500" is the browser's own automatic log for
// the 500s this script deliberately injects below - expected noise from the
// simulated failure, not an app defect (the assertions below are what
// actually prove the app handled it correctly).
page.on(
  "console",
  (m) =>
    m.type() === "error" &&
    !/failed to load resource/i.test(m.text()) &&
    errors.push(m.text()),
);
page.on("pageerror", (e) => errors.push(e.message));

let clearDataCalls = 0;
await page.route(`${SUPABASE_URL}/rest/v1/election_day_voters*`, (route) => {
  if (route.request().method() === "DELETE") {
    clearDataCalls++;
    return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  }
  return route.continue();
});
let addUserCalls = 0;
await page.route(
  `${SUPABASE_URL}/rest/v1/rpc/election_day_create_permission_user`,
  (route) => {
    addUserCalls++;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ message: "simulated failure" }),
    });
  },
);

await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });
await page.waitForSelector('text=התחברות - חמ"ל בחירות', { timeout: 15000 });
await page.getByLabel("שם משתמש").fill(MGR_NAME);
await page.locator('input[type="password"]').fill(PASS);
await page.click('button:has-text("התחברות")');
await page.waitForURL("**/election-day", { timeout: 15000 });
await page.waitForSelector("aside nav", { timeout: 15000 });

// ---- clear-data: injected failure must keep the ConfirmDialog open -------
await page.waitForSelector('button:has-text("מחק קובץ בוחרים")', { timeout: 15000 });
await page.click('button:has-text("מחק קובץ בוחרים")');
await page.waitForSelector("text=מחיקת קובץ הבוחרים", { timeout: 10000 });
await page.click('button:has-text("מחקו")');
await page.waitForTimeout(1500);
assert(clearDataCalls > 0, "clear-data: the (intercepted) DELETE request was actually attempted");
assert(
  await page
    .locator("text=מחיקת קובץ הבוחרים")
    .isVisible()
    .catch(() => false),
  "clear-data: ConfirmDialog stayed OPEN after the injected failure (did not close as if it succeeded)",
);
await page.keyboard.press("Escape").catch(() => {});
await page.waitForTimeout(300);

// ---- add-permission-user: injected failure must NOT reset the form -------
await page.click('button:has-text("ניהול הרשאות משתמשים")');
await page.waitForSelector("text=הוסף משתמש", { timeout: 10000 });
const probeName = "_probe_should_not_be_cleared";
await page.getByPlaceholder("שם המשתמש").fill(probeName);
await page.getByPlaceholder("סיסמה").fill("ProbePass123");
await page.click('button:has-text("הוספה")');
await page.waitForTimeout(1500);
assert(
  addUserCalls > 0,
  "add-permission-user: the (intercepted) create RPC was actually attempted",
);
assert(
  (await page.getByPlaceholder("שם המשתמש").inputValue()) === probeName,
  "add-permission-user: name field was NOT reset after the injected failure",
);
assert(
  (await page.getByPlaceholder("סיסמה").inputValue()) === "ProbePass123",
  "add-permission-user: password field was NOT reset after the injected failure",
);

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(
  errors.length === 0 ? "0 console/page errors" : `${errors.length} errors: ${errors.join(" | ")}`,
);
if (failed.length > 0 || errors.length > 0) process.exit(1);
