// Stage 4 verification: real login as a real, DB-backed "voting" PermissionUser
// (previously only reachable via the dev-only harness, since no DatabaseRole
// mapped onto "voting" before the election_day_voting_role migration). Uses a
// temporary PermissionUser account created/deleted via direct RPC (same
// methodology as drive-permissions.mjs) - no mutation to any voter record.
//
// This account's name isn't a real coordinator in the live ride-list, so
// scopedContacts resolves to an empty list for it - the same data-independent
// limitation already documented in drive-permissions.mjs's operations block.
// Field-level permission differences between voting and operations (e.g.
// voter.manageReminder/manageRide/editPhone/editNotes) are exhaustively
// covered by the pure-logic smoke-permissions.ts suite instead; this script's
// job is to prove the real login/DB/RPC pipeline works end-to-end for voting,
// not to re-derive the permission matrix.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const VOTING_NAME = process.env.VOTING_NAME;
const PASS = process.env.PASS;
if (!VOTING_NAME || !PASS) {
  console.error("FAIL: VOTING_NAME/PASS env vars required");
  process.exit(1);
}

const errors = [];
const results = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });
await page.waitForSelector('text=התחברות - חמ"ל בחירות', { timeout: 15000 });
await page.getByLabel("שם משתמש").fill(VOTING_NAME);
await page.locator('input[type="password"]').fill(PASS);
await page.click('button:has-text("התחברות")');
await page.waitForURL("**/election-day", { timeout: 15000 });
await page.waitForSelector("aside nav", { timeout: 15000 });

assert(true, "voting: real login succeeded (previously impossible - no DatabaseRole mapped onto voting)");

// Role label proves resolveEffectiveRole + roleOptions.voting render
// end-to-end for a REAL voting DatabaseRole coming back from the DB/RPC -
// not just the dev-only harness's mocked usePermissions. Uses waitForSelector
// (polls) rather than a one-shot isVisible() - the session-info block paints
// slightly after the initial post-login render settles.
const roleLabelVisible = await page
  .waitForSelector(`text=${VOTING_NAME} · נציג קלפי`, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
assert(
  roleLabelVisible,
  'voting: session label shows "<name> · נציג קלפי" (real DatabaseRole -> EffectiveRole -> UI label, full pipeline)',
);

// Same admin-surface restrictions as operations (voting has zero admin
// permissions, same as operations - see smoke-permissions.ts's EXPECTED table).
assert(
  (await page.locator('button:has-text("טען קובץ בוחרים")').count()) === 0,
  "voting: does NOT see Import button",
);
assert(
  (await page.locator('button:has-text("מחק קובץ בוחרים")').count()) === 0,
  "voting: does NOT see clear-data button",
);
assert(
  (await page.locator('button:has-text("ניהול אחראי הסעות")').count()) === 0,
  "voting: does NOT see manage-ride-coordinators button",
);
assert(
  (await page.locator('button:has-text("ניהול הרשאות משתמשים")').count()) === 0,
  "voting: does NOT see manage-users button",
);
assert(
  (await page.locator('button[aria-label="קביעת יעד"]').count()) === 0,
  "voting: does NOT see countdown settings gear",
);

// Main-app nav restricted, same as operations (app.accessFullNavigation: false).
const dashboardRealLink = await page.locator('nav a[href="/"]').count();
assert(
  dashboardRealLink === 0,
  "voting: main-app dashboard nav item is NOT a real link (restricted)",
);
const electionDayRealLink = await page.locator(`nav a[href="/election-day"]`).count();
assert(
  electionDayRealLink > 0,
  "voting: /election-day itself remains a real, clickable link",
);

await ctx.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} console/page errors:`);
  for (const e of errors) console.log(" -", e);
}
if (failed.length > 0 || errors.length > 0) process.exit(1);
