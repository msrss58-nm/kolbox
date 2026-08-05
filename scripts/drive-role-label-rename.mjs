// Verifies the "voting" role's UI label rename (הצבעה -> נציג קלפי) end-to-end
// through the real PermissionUsersModal - not just login (already covered by
// drive-voting-login.mjs), but the actual create-via-checkbox flow, which had
// never been exercised live before (Stage 4 created its temp voting account
// via direct RPC). Uses a temporary manager account created/deleted via
// direct RPC (same methodology as prior scripts) - no mutation to any voter
// record. `ApiClient` has no "edit PermissionUser" method (only
// add/delete/list/verifyLogin - confirmed in services/api/types.ts), so this
// covers create + delete, the actual full CRUD surface that exists.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const MGR_NAME = process.env.MGR_NAME;
const PASS = process.env.PASS;
const NEW_VOTER_NAME = process.env.NEW_VOTER_NAME ?? "_rename_test_voting_ui";
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
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });
await page.waitForSelector('text=התחברות - חמ"ל בחירות', { timeout: 15000 });
await page.getByLabel("שם משתמש").fill(MGR_NAME);
await page.locator('input[type="password"]').fill(PASS);
await page.click('button:has-text("התחברות")');
await page.waitForURL("**/election-day", { timeout: 15000 });
await page.waitForSelector("aside nav", { timeout: 15000 });

await page.click('button:has-text("ניהול הרשאות משתמשים")');
await page.waitForSelector("text=הוסף משתמש", { timeout: 10000 });

// The old label must be gone everywhere in the modal (role picker + roster list).
assert(
  (await page.locator("text=הצבעה").count()) === 0,
  'modal: old label "הצבעה" does not appear anywhere',
);
assert(
  await page.locator("text=נציג קלפי").first().isVisible(),
  'modal: role picker shows the new "נציג קלפי" checkbox label',
);

// ---- create via the real form, selecting the renamed checkbox ------------
await page.getByPlaceholder("שם המשתמש").fill(NEW_VOTER_NAME);
await page.getByPlaceholder("סיסמה").fill("RenameUiTest123!");
await page.click('label:has-text("נציג קלפי") input[type="checkbox"]');
await page.click('button:has-text("הוספה")');

const rosterRowVisible = await page
  .waitForSelector(`text=${NEW_VOTER_NAME}`, { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
assert(rosterRowVisible, "create: new voting user appears in the roster list");

// The roster row for this new user must show the new label, not the old one.
const row = page.locator("li", { hasText: NEW_VOTER_NAME });
assert(
  await row.locator("text=נציג קלפי").isVisible().catch(() => false),
  'create: roster row for the new user shows "נציג קלפי"',
);
assert(
  (await row.locator("text=הצבעה").count()) === 0,
  'create: roster row for the new user does NOT show the old "הצבעה" label',
);

// ---- delete it (cleanup + proves delete still works post-rename) ---------
await row.locator('button[aria-label="מחיקת משתמש"]').click();
const rosterRowGoneAfterDelete = await page
  .locator(`text=${NEW_VOTER_NAME}`)
  .waitFor({ state: "detached", timeout: 10000 })
  .then(() => true)
  .catch(() => false);
assert(rosterRowGoneAfterDelete, "delete: the new voting user is removed from the roster list");

await ctx.close();
await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} console/page errors:`);
  for (const e of errors) console.log(" -", e);
}
if (failed.length > 0 || errors.length > 0) process.exit(1);
