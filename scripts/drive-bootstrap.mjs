// Bootstrap-fix verification driver - proves the roster-empty "no session"
// window still shows exactly the manage-users button (never any other admin
// action), and that a non-empty roster still forces the login screen.
//
// Never touches the real roster: the `election_day_list_permission_users`
// RPC is intercepted client-side (page.route) and answered with a fake
// body before it ever reaches Supabase - the real 4-account roster is never
// read or written by this script. A fake session (when needed) is injected
// directly into localStorage, bypassing the login RPC entirely - no
// interaction with `election_day_login` either.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error("FAIL: VITE_SUPABASE_URL env var required (same value as .env)");
  process.exit(1);
}
const LIST_USERS_RPC = `${SUPABASE_URL}/rest/v1/rpc/election_day_list_permission_users`;

const results = [];
const errors = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();

async function mockRoster(page, rows) {
  await page.route(LIST_USERS_RPC, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }),
  );
}

async function injectSession(page, user) {
  await page.addInitScript(
    (u) => localStorage.setItem("kolbox:election-day-session-v1", JSON.stringify(u)),
    user,
  );
}

function attachErrorListeners(page, label) {
  page.on("console", (m) => m.type() === "error" && errors.push(`[${label}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[${label}] ${e.message}`));
}

// A real wait (not an instant isVisible() snapshot) - the two independent
// permissionUsers fetches (ElectionDayGuard's + useElectionDay's) each need
// a tick to resolve after navigation, so an instant check can race a still-
// mounting page. Absence checks run after this has already settled once.
async function waitVisible(page, selector, timeout = 10000) {
  return page
    .locator(selector)
    .first()
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

// ---- scenario 1: empty roster + no session -> isBootstrap=true ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  attachErrorListeners(page, "empty-roster/no-session");
  await mockRoster(page, []);

  await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });

  assert(
    !page.url().includes("/election-day/login"),
    "empty roster + no session: NOT redirected to login (screen stays open)",
  );
  assert(
    await waitVisible(page, 'button:has-text("ניהול הרשאות משתמשים")'),
    "empty roster + no session: manage-users button IS visible (the fix)",
  );
  for (const label of [
    "טען קובץ בוחרים",
    "מחק קובץ בוחרים",
    "ניהול אחראי הסעות",
    "שלח דוח תמונת מצב",
  ]) {
    assert(
      (await page.locator(`button:has-text("${label}")`).count()) === 0,
      `empty roster + no session: "${label}" stays hidden (bootstrap widens only manage-users)`,
    );
  }
  assert(
    (await page.locator('button[aria-label="קביעת יעד"]').count()) === 0,
    "empty roster + no session: countdown settings gear stays hidden",
  );

  await ctx.close();
}

// ---- scenario 2: non-empty roster + no session -> forced to /login ------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  attachErrorListeners(page, "non-empty-roster/no-session");
  await mockRoster(page, [{ id: "fake-1", name: "FakeExisting", role: "manager" }]);

  await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });
  await page.waitForURL("**/election-day/login", { timeout: 10000 }).catch(() => {});

  assert(
    page.url().includes("/election-day/login"),
    "non-empty roster + no session: redirected to /election-day/login",
  );
  assert(
    (await page.locator('button:has-text("ניהול הרשאות משתמשים")').count()) === 0,
    "non-empty roster + no session: manage-users button not reachable at all",
  );

  await ctx.close();
}

// ---- scenario 3: empty roster + an existing (stale) session -> isBootstrap=false,
// manage-users still visible, but via real permission - full manager access intact ----
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  attachErrorListeners(page, "empty-roster/manager-session");
  await mockRoster(page, []);
  await injectSession(page, { id: "fake-mgr", name: "FakeMgr", role: "manager" });

  await page.goto(BASE + "/election-day", { waitUntil: "networkidle" });

  assert(
    !page.url().includes("/election-day/login"),
    "empty roster + manager session: not redirected to login",
  );
  assert(
    await waitVisible(page, 'button:has-text("ניהול הרשאות משתמשים")'),
    "empty roster + manager session: manage-users visible via real permission",
  );
  assert(
    await waitVisible(page, 'button:has-text("טען קובץ בוחרים")'),
    "empty roster + manager session: Import also visible (full manager access, not just the bootstrap exception)",
  );

  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (errors.length > 0) {
  console.log(`\n${errors.length} console/page errors:`);
  for (const e of errors) console.log(" -", e);
} else {
  console.log("\n0 console/page errors");
}
if (failed.length > 0 || errors.length > 0) process.exit(1);
