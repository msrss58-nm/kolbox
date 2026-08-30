// Coordinator add-form regression coverage (2026-08-22): proves the
// add-coordinator form's open/closed/cancel behavior for BOTH
// CoordinatorRosterEditor consumers - the Setup wizard's "אחראים" step
// (`CoordinatorAllocationSetup.tsx`, `collapsibleAddForm` prop) and the
// live/day-of view's "➕ הוסף אחראי" panel (`CoordinatorAllocationLive.tsx`).
//
// Extended 2026-08-23 with 2 additive regression blocks (after the original
// 2 above) guarding the removed "קשר לאחראי הזה"/"עדכן קישור" link-suggestion
// banner (`useCoordinatorRowActions.ts`, `CoordinatorRow.tsx`,
// `CoordinatorLiveRow.tsx`): each mocks a coordinator whose linked_assignment_name
// is null alongside a raw-imported voter whose `coordinator` text matches
// that coordinator's display_name exactly - the precise condition that, pre-
// removal, made the banner appear unconditionally for every import-auto-
// synced coordinator. Covers both consumers (CoordinatorRow/Setup via a
// forced-setup-phase unassigned voter, CoordinatorLiveRow/Live) per CLAUDE.md's
// "Shared component/UX change checklist" - a shared component with 2
// consumers needs 2 verification passes, never one standing in for both.
//
// Root cause the original 2 blocks guard against: the same shared component/
// UX pattern had two distinct consumers in two distinct application states
// (Setup vs Live), but a UX change was only manually verified in Live - a
// later, unrelated fixture cleanup then changed local state from Live back
// to Setup and exposed that the Setup consumer had never actually been
// fixed. See CLAUDE.md's "Shared component/UX change checklist" for the
// permanent rule this test exists to satisfy.
//
// Never touches real coordinator/voter data: `election_day_coordinators`
// and `election_day_voters` GET requests are intercepted client-side
// (page.route) and answered with a fixed fake body before they ever reach
// Supabase - which application state (Setup vs Live) renders is entirely
// mock-controlled, never dependent on whatever real/disposable fixtures
// happen to exist locally at run time. The session is injected directly
// into localStorage using the real, pre-existing "מנהל" role id (which
// already grants `electionDay.manageCoordinatorAllocation` in this local
// Docker project) - no real login RPC call, no real roster read/write. The
// original 2 scenarios only ever click ביטול, never a real "add" - so the
// coordinator-mutation RPC is asserted to never fire at all; the 2 new
// regression blocks perform no mutation at all (read-only navigation and
// text assertions only).
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
// Phase 3 Contract: the manage-coordinators mutation no longer calls Supabase
// directly from the browser - it goes through the trusted, session-derived
// v3 HTTP endpoint (api/election-day/coordinator-allocation.ts,
// electionDayTrustedCoordinatorAllocationClient.ts), one shared endpoint for
// all 4 allocation mutations distinguished by a JSON body `op` field. The
// legacy election_day_manage_coordinators_v2 RPC this used to intercept was
// retired in the same Contract.
const COORDINATOR_ALLOCATION_ENDPOINT = `${BASE}/api/election-day/coordinator-allocation`;

// The local "מנהל" (manager) role, seeded with electionDay.
// manageCoordinatorAllocation - `election_day_roles.id` defaults to
// gen_random_uuid() (see 20260805181806_election_day_dynamic_roles_phase0.sql),
// so it is NOT stable across a `supabase db reset`/fresh disposable project;
// looked up live by name against the local stack instead of hardcoded.
// election_day_roles has no anon-readable RLS policy (unlike the permissive
// voter/ride tables), so this lookup - local-only, never Production - needs
// the local service-role key (not a secret: a fixed, publicly-documented
// demo JWT baked into every `supabase start`, never Production's).
const SUPABASE_LOCAL_SERVICE_ROLE_KEY = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY;
if (!SUPABASE_LOCAL_SERVICE_ROLE_KEY) {
  console.error("FAIL: SUPABASE_LOCAL_SERVICE_ROLE_KEY env var required (local service-role key)");
  process.exit(1);
}
async function lookupManagerRoleId() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/election_day_roles?select=id&name=eq.${encodeURIComponent("מנהל")}`,
    {
      headers: {
        apikey: SUPABASE_LOCAL_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_LOCAL_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!res.ok) throw new Error(`role lookup failed: HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.id) {
    throw new Error('no local "מנהל" role found - is the local stack seeded?');
  }
  return rows[0].id;
}
const MANAGER_ROLE_ID = await lookupManagerRoleId();

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

async function mockVoters(page, rows = []) {
  await page.route(VOTERS_URL, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
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

// A raw imported voter row whose `coordinator` text matches a coordinator's
// display_name exactly - the exact condition that, pre-2026-08-23, always
// triggered the (now-removed) "קשר לאחראי הזה" link-suggestion banner for
// every coordinator created by the 2026-08-20 import auto-sync (its
// display_name is always seeded from this same raw string). Used below to
// prove the banner cannot reappear.
function fakeVoterRow(coordinatorName, overrides = {}) {
  return {
    id: "smoke-voter-1",
    masad: "",
    first_name: "SMOKE",
    last_name: "voter",
    street: "",
    house_number: 0,
    city: "",
    phone: null,
    coordinator: coordinatorName,
    notes: null,
    ride_requested: false,
    ride_requested_at: null,
    ride_arranged: false,
    ride_arranged_at: null,
    ride_completed: false,
    ride_completed_at: null,
    reminder_at: null,
    reminder_closed_at: null,
    reminder_closed_reason: null,
    reminder_closed_by: null,
    voted: false,
    voted_at: null,
    not_voting_reason_id: null,
    not_voting_reason_set_at: null,
    not_voting_reason_set_by: null,
    call_attempts: 0,
    call_attempts_threshold: null,
    last_call_attempt_at: null,
    no_answer_streak: 0,
    no_answer_streak_threshold: null,
    pending_call_id: null,
    ...overrides,
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
  await page.route(COORDINATOR_ALLOCATION_ENDPOINT, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        if (JSON.parse(req.postData() ?? "{}").op === "manage_coordinators") {
          mutationFired = true;
        }
      } catch {
        // malformed body - not a manage_coordinators call we care about
      }
    }
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
  await page.route(COORDINATOR_ALLOCATION_ENDPOINT, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        if (JSON.parse(req.postData() ?? "{}").op === "manage_coordinators") {
          mutationFired = true;
        }
      } catch {
        // malformed body - not a manage_coordinators call we care about
      }
    }
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

// =====================================================================
// REGRESSION: removed link-suggestion banner ("קשר לאחראי הזה" / "עדכן
// קישור") must never reappear, in either consumer, even in the exact
// condition that used to trigger it unconditionally - a coordinator whose
// linked_assignment_name is null and who has a raw-matching voter (see
// useCoordinatorRowActions.ts's 2026-08-23 removal comment). Both blocks
// below are purely additive - they open their own fresh browser context and
// assert nothing the pre-existing Setup/Live blocks above already assert,
// so they cannot interact with or weaken those checks.
// =====================================================================
{
  const label = "live-with-matching-voter";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await mockVoters(page, [fakeVoterRow("SMOKE_live_coordinator")]);
  await mockCoordinators(page, [fakeCoordinatorRow("SMOKE_live_coordinator")]);
  await injectSession(page);
  await openAllocationScreen(page);

  const bodyText = await page.locator("body").innerText();
  assert(
    !bodyText.includes("קשר לאחראי הזה"),
    `${label}: removed link-suggestion button text does not appear`,
  );
  assert(
    !bodyText.includes("עדכן קישור"),
    `${label}: removed relink-suggestion button text does not appear`,
  );

  const coordRow = page.locator("li", { hasText: "SMOKE_live_coordinator" });
  assert(
    (await coordRow.locator('button:has-text("הסר אחראי")').count()) > 0,
    `${label}: unrelated action הסר אחראי still renders`,
  );
  assert(
    (await coordRow.locator("text=העבר הקצאות").count()) > 0,
    `${label}: unrelated action העבר הקצאות still renders`,
  );
  assert(
    (await coordRow.locator("text=סיום פעילות").count()) > 0,
    `${label}: unrelated action סיום פעילות still renders`,
  );

  await context.close();
}

{
  const label = "setup-with-existing-coordinator-and-matching-voter";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  // One unassigned voter (coordinator: "") forces resolveCoordinatorAllocationPhase
  // to "setup" regardless of the coordinator below, so this exercises
  // CoordinatorRow (Setup's list), not CoordinatorLiveRow.
  await mockVoters(page, [
    fakeVoterRow("SMOKE_setup_coordinator"),
    fakeVoterRow("", { id: "smoke-voter-2" }),
  ]);
  await mockCoordinators(page, [fakeCoordinatorRow("SMOKE_setup_coordinator")]);
  await injectSession(page);
  await openAllocationScreen(page);

  const bodyText = await page.locator("body").innerText();
  assert(
    bodyText.includes("SMOKE_setup_coordinator"),
    `${label}: resolves to the Setup view with the existing coordinator listed`,
  );
  assert(
    !bodyText.includes("קשר לאחראי הזה"),
    `${label}: removed link-suggestion button text does not appear`,
  );
  assert(
    !bodyText.includes("עדכן קישור"),
    `${label}: removed relink-suggestion button text does not appear`,
  );

  await context.close();
}

await browser.close();

assert(errors.length === 0, `no console/page errors across both scenarios (found ${errors.length})`);
if (errors.length > 0) for (const e of errors) console.log(" -", e);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
