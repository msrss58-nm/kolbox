// Coordinator add-form regression coverage (2026-08-22): proves the
// add-coordinator form's open/closed/cancel behavior for BOTH
// CoordinatorRosterEditor consumers - the Setup wizard's "אחראים" step
// (`CoordinatorAllocationSetup.tsx`, `collapsibleAddForm` prop) and the
// live/day-of view's "➕ הוסף אחראי" panel (`CoordinatorAllocationLive.tsx`).
//
// Root cause this guards against: the same shared component/UX pattern had
// two distinct consumers in two distinct application states (Setup vs
// Live), but a UX change was only manually verified in Live - a later,
// unrelated fixture cleanup then changed local state from Live back to
// Setup and exposed that the Setup consumer had never actually been fixed.
// See CLAUDE.md's "Shared component/UX change checklist" for the permanent
// rule this test exists to satisfy.
//
// Never touches real coordinator/voter data: `election_day_coordinators`
// and `election_day_voters` GET requests are intercepted client-side
// (page.route) and answered with a fixed fake body before they ever reach
// Supabase - which application state (Setup vs Live) renders is entirely
// mock-controlled (0 vs 1 mocked coordinators; voters always mocked to `[]`
// so `unassignedCount` is deterministically 0 regardless of the real local
// dataset), never dependent on whatever real/disposable fixtures happen to
// exist locally at run time. The session is injected directly into
// localStorage using the real, pre-existing "מנהל" role id (which already
// grants `electionDay.manageCoordinatorAllocation` in this local Docker
// project) - no real login RPC call, no real roster read/write. Every
// scenario below only ever clicks ביטול, never a real "add" - so the
// coordinator-mutation RPC is asserted to never fire at all.
//
// Requires the local dev server (`npm run dev`, default localhost:5173) and
// local Supabase Docker running - unlike the pure-logic `smoke-*.ts` suite,
// this exercises real React rendering, so it needs both up.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error("FAIL: VITE_SUPABASE_URL env var required (same value as .env.development.local)");
  process.exit(1);
}
const COORDINATORS_URL = `${SUPABASE_URL}/rest/v1/election_day_coordinators*`;
const VOTERS_URL = `${SUPABASE_URL}/rest/v1/election_day_voters*`;
const MANAGE_COORDINATORS_RPC = `${SUPABASE_URL}/rest/v1/rpc/election_day_manage_coordinators_v2`;

// The real, pre-existing local "מנהל" (manager) role - already granted
// electionDay.manageCoordinatorAllocation in this project's seed data.
// Not a secret, not Production - a local Docker project id only.
const MANAGER_ROLE_ID = "18916a2e-aa8f-4a65-9c11-4ee37c7ce3a1";

const results = [];
const errors = [];
const assert = (cond, msg) => {
  results.push({ pass: !!cond, msg });
  console.log(cond ? "ok:" : "FAIL:", msg);
};

const browser = await chromium.launch();

function attachErrorListeners(page, label) {
  page.on("console", (m) => m.type() === "error" && errors.push(`[${label}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[${label}] ${e.message}`));
}

async function injectSession(page) {
  await page.addInitScript(
    (u) => localStorage.setItem("kolbox:election-day-session-v1", JSON.stringify(u)),
    { id: "smoke-manager", name: "SMOKE_manager", roleId: MANAGER_ROLE_ID },
  );
}

async function mockCoordinators(page, rows) {
  await page.route(COORDINATORS_URL, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
  });
}

async function mockVoters(page) {
  await page.route(VOTERS_URL, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });
}

function fakeCoordinatorRow(name) {
  return {
    id: "smoke-coord-1",
    display_name: name,
    status: "active",
    linked_assignment_name: null,
    created_at: new Date().toISOString(),
    ended_at: null,
    phone: null,
  };
}

async function openAllocationScreen(page) {
  await page.goto(`${BASE}/election-day/files`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=ניהול הקצאות", { timeout: 15000 }).catch(() => {});
  await page.locator("text=ניהול הקצאות").first().click();
  await page.waitForTimeout(700);
}

// =====================================================================
// SETUP MODE - 0 mocked coordinators -> resolveCoordinatorAllocationPhase
// resolves to "setup" regardless of real ambient data.
// =====================================================================
{
  const label = "setup";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await mockVoters(page);
  await mockCoordinators(page, []);
  await injectSession(page);

  let mutationFired = false;
  await page.route(MANAGE_COORDINATORS_RPC, (route) => {
    mutationFired = true;
    return route.continue();
  });

  await openAllocationScreen(page);

  assert(
    (await page.locator('input[placeholder="שם האחראי"]').count()) === 0,
    `${label}: add form CLOSED by default`,
  );
  const addToggle = page.locator('button:has-text("הוסף אחראי")').first();
  assert((await addToggle.count()) > 0, `${label}: + הוסף אחראי toggle visible`);

  await addToggle.click();
  await page.waitForTimeout(300);
  assert(
    (await page.locator('input[placeholder="שם האחראי"]').count()) > 0,
    `${label}: clicking the toggle opens the name field`,
  );
  assert(
    (await page.locator('input[placeholder="050-1234567"]').count()) > 0,
    `${label}: clicking the toggle opens the phone field`,
  );
  assert(
    (await page.locator('button:has-text("הוספת אחראי")').count()) > 0,
    `${label}: add button present`,
  );
  const cancelBtn = page.locator('button:has-text("ביטול")').first();
  assert((await cancelBtn.count()) > 0, `${label}: ביטול present`);

  await cancelBtn.click();
  await page.waitForTimeout(300);
  assert(
    (await page.locator('input[placeholder="שם האחראי"]').count()) === 0,
    `${label}: cancel on an empty form closes it`,
  );
  assert(!mutationFired, `${label}: cancel on an empty form fired no mutation RPC`);

  await addToggle.click();
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="שם האחראי"]').first().fill("SMOKE_should_not_save");
  await page.locator('input[placeholder="050-1234567"]').first().fill("0501234567");
  await page.locator('button:has-text("ביטול")').first().click();
  await page.waitForTimeout(300);
  assert(!mutationFired, `${label}: cancel with partial name+phone fired no mutation RPC`);
  assert(
    !(await page.locator("body").innerText()).includes("SMOKE_should_not_save"),
    `${label}: discarded name never appears anywhere`,
  );

  await addToggle.click();
  await page.waitForTimeout(300);
  const reopenedName = await page.locator('input[placeholder="שם האחראי"]').first().inputValue();
  const reopenedPhone = await page.locator('input[placeholder="050-1234567"]').first().inputValue();
  assert(
    reopenedName === "" && reopenedPhone === "",
    `${label}: reopening the form shows empty name+phone`,
  );

  await context.close();
}

// =====================================================================
// LIVE MODE - 1 mocked coordinator -> resolves to "live".
// =====================================================================
{
  const label = "live";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await mockVoters(page);
  await mockCoordinators(page, [fakeCoordinatorRow("SMOKE_live_coordinator")]);
  await injectSession(page);

  let mutationFired = false;
  await page.route(MANAGE_COORDINATORS_RPC, (route) => {
    mutationFired = true;
    return route.continue();
  });

  await openAllocationScreen(page);

  const bodyText = await page.locator("body").innerText();
  assert(
    bodyText.includes("אחראים פעילים") || bodyText.includes('סה"כ בוחרים'),
    `${label}: resolves to the Live view (mocked coordinator present)`,
  );

  const addToggle = page.locator('button:has-text("הוסף אחראי")').first();
  await addToggle.click();
  await page.waitForTimeout(300);
  assert(
    (await page.locator('input[placeholder="שם האחראי"]').count()) > 0,
    `${label}: ➕ הוסף אחראי opens the add-only form`,
  );
  const cancelBtn = page.locator('button:has-text("ביטול")').first();
  assert((await cancelBtn.count()) > 0, `${label}: ביטול present in the add panel`);

  await page.locator('input[placeholder="שם האחראי"]').first().fill("SMOKE_live_should_not_save");
  await page.locator('input[placeholder="050-1234567"]').first().fill("0509998888");
  await cancelBtn.click();
  await page.waitForTimeout(300);
  assert(!mutationFired, `${label}: cancel with partial data fired no mutation RPC`);
  assert(
    (await page.locator('input[placeholder="שם האחראי"]').count()) === 0,
    `${label}: cancel closes the add panel`,
  );

  await addToggle.click();
  await page.waitForTimeout(300);
  const reopenedName = await page.locator('input[placeholder="שם האחראי"]').first().inputValue();
  assert(reopenedName === "", `${label}: reopening starts with an empty name field`);
  await addToggle.click();
  await page.waitForTimeout(300);

  const coordRow = page.locator("li", { hasText: "SMOKE_live_coordinator" });
  assert(
    (await coordRow.locator('button:has-text("הסר אחראי")').count()) > 0,
    `${label}: existing coordinator row still shows הסר אחראי`,
  );
  assert(
    (await coordRow.locator("text=העבר הקצאות").count()) > 0,
    `${label}: existing coordinator row still shows העבר הקצאות`,
  );
  assert(
    (await coordRow.locator("text=סיום פעילות").count()) > 0,
    `${label}: existing coordinator row still shows סיום פעילות`,
  );

  await context.close();
}

await browser.close();

assert(errors.length === 0, `no console/page errors across both scenarios (found ${errors.length})`);
if (errors.length > 0) for (const e of errors) console.log(" -", e);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
