// Coordinator add-form regression coverage (2026-08-22): proves the
// add-coordinator form's open/closed/cancel behavior for BOTH
// CoordinatorRosterEditor consumers - the Setup wizard's "אחראים" step
// (`CoordinatorAllocationSetup.tsx`, `collapsibleAddForm` prop) and the
// live/day-of view's "➕ הוסף אחראי" panel (`CoordinatorAllocationLive.tsx`).
//
// Extended 2026-08-23 with 2 additive regression blocks (after the original
// 2 above) guarding the removed "קשר לאחראי הזה"/"עדכן קישור" link-suggestion
// banner (`useCoordinatorRowActions.ts`, `CoordinatorRow.tsx`,
// `CoordinatorLiveRow.tsx`): each seeds a coordinator whose
// linked_assignment_name is null alongside a raw-imported voter whose
// `coordinator` text matches that coordinator's display_name exactly - the
// precise condition that, pre-removal, made the banner appear
// unconditionally for every import-auto-synced coordinator. Covers both
// consumers (CoordinatorRow/Setup via a forced-setup-phase unassigned voter,
// CoordinatorLiveRow/Live) per CLAUDE.md's "Shared component/UX change
// checklist" - a shared component with 2 consumers needs 2 verification
// passes, never one standing in for both.
//
// Rewritten 2026-08-30 for the Phase 3 Contract's tooling-closure step: the
// original fixture faked the whole roster via `page.route()` JSON mocks
// (client-side GET intercepts of a raw Supabase REST URL) and injected a
// fake session directly into localStorage. Both are now architecturally
// obsolete - Coordinator/Allocation's roster read moved to the trusted v3
// HTTP endpoint (no more raw Supabase REST GET on election_day_coordinators
// to intercept), and Phase 3B moved session identity onto a server-verified
// HttpOnly cookie the app resolves via a real GET to
// /api/election-day/session - a client-injected localStorage key is now
// silently ignored entirely, so the old fixture no longer authenticates
// anything at all. This version performs a REAL login through the actual
// login form (name+password typed in, real submit, real
// POST /api/election-day/session, real cookie) against a disposable local
// PermissionUser account, and seeds real (never mocked) disposable rows
// directly into the local, never-Production Supabase instance for each
// scenario's coordinator/voter data - the roster and voter reads the app
// performs are the real ones, not faked responses.
//
// Requires: local Supabase running (`supabase start`), the local dev server
// proxying /api/election-day/* to a locally-running copy of the real,
// unmodified `api/election-day/*.ts` handlers (session.ts, coordinator-
// allocation.ts - see this repo's own local-harness convention for the
// production-safe pattern; VITE_SUPABASE_URL must point at the local stack,
// never Production), and SUPABASE_LOCAL_SERVICE_ROLE_KEY for the one-time
// local-only role lookup and fixture seeding. Never touches Production -
// besides pointing at a local API base URL, every outbound request this
// script's browser makes is also defensively checked against the known
// Production Supabase host and hard-failed if one ever appears.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error("FAIL: VITE_SUPABASE_URL env var required (the LOCAL Supabase stack's URL)");
  process.exit(1);
}
if (SUPABASE_URL.includes("nbymfgphnsounqncfjgl")) {
  console.error("FAIL: VITE_SUPABASE_URL points at Production - refusing to run.");
  process.exit(1);
}
const SUPABASE_LOCAL_SERVICE_ROLE_KEY = process.env.SUPABASE_LOCAL_SERVICE_ROLE_KEY;
if (!SUPABASE_LOCAL_SERVICE_ROLE_KEY) {
  console.error("FAIL: SUPABASE_LOCAL_SERVICE_ROLE_KEY env var required (local service-role key)");
  process.exit(1);
}

// Phase 3 Contract: the manage-coordinators mutation no longer calls Supabase
// directly from the browser - it goes through the trusted, session-derived
// v3 HTTP endpoint (api/election-day/coordinator-allocation.ts,
// electionDayTrustedCoordinatorAllocationClient.ts), one shared endpoint for
// all 4 allocation mutations distinguished by a JSON body `op` field. The
// legacy election_day_manage_coordinators_v2 RPC this used to intercept was
// retired in the same Contract.
const COORDINATOR_ALLOCATION_ENDPOINT = `${BASE}/api/election-day/coordinator-allocation`;

// ---------------------------------------------------------------------------
// Local-only SQL runner (fixture seeding + the one role-id lookup) - reuses
// the same shell-free npx-invocation technique scripts/lib/supabaseCliQuery.ts
// documents and uses for the exact same reason (bare execFileSync("npx", ...)
// fails on Windows without shell:true, which reopens a quoting/injection
// surface this SQL-carrying call should never have). SQL is always written
// to a temp file, never passed as a positional argv element.
// ---------------------------------------------------------------------------
function resolveNpxInvocation() {
  const npxCliJs = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  if (existsSync(npxCliJs)) {
    return { command: process.execPath, prefixArgs: [npxCliJs] };
  }
  return { command: "npx", prefixArgs: [] };
}

function runSql(sql) {
  const tmpPath = join(tmpdir(), `kolbox-smoke-coord-form-${randomUUID()}.sql`);
  writeFileSync(tmpPath, sql, { encoding: "utf8", mode: 0o600 });
  const { command, prefixArgs } = resolveNpxInvocation();
  let out;
  try {
    out = execFileSync(
      command,
      [
        ...prefixArgs,
        "supabase",
        "db",
        "query",
        "--local",
        "--file",
        tmpPath,
        "--output-format",
        "json",
        "--agent",
        "yes",
      ],
      { encoding: "utf8", shell: false },
    );
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup for this local-only, non-secret-bearing temp file
    }
  }
  const jsonStart = out.indexOf("{");
  if (jsonStart === -1) throw new Error("runSql: no JSON object found in supabase db query output");
  const parsed = JSON.parse(out.slice(jsonStart));
  if (!Array.isArray(parsed.rows)) throw new Error("runSql: no rows array in supabase db query output");
  return parsed.rows;
}

// ---------------------------------------------------------------------------
// Fixture: one disposable local workspace + one disposable local
// PermissionUser account (real bcrypt hash via pgcrypto, real login-able),
// pointed at the real, pre-existing local "מנהל" role (grants
// electionDay.manageCoordinatorAllocation).
// ---------------------------------------------------------------------------
const RUN_ID = randomUUID().slice(0, 8);
const FIXTURE_PASSWORD = "SmokeTest1234!";
const FIXTURE_USER_NAME = `SMOKE_coord_form_${RUN_ID}`;

const [{ id: managerRoleId }] = runSql(
  `select id from election_day_roles where name = 'מנהל' limit 1;`,
);
if (!managerRoleId) {
  console.error('FAIL: no local "מנהל" role found - is the local stack seeded?');
  process.exit(1);
}

const [{ id: workspaceId }] = runSql(`
  insert into election_workspaces (name, election_end_at)
  values ('SMOKE_coord_form_ws_${RUN_ID}', now() + interval '1 day')
  returning id;
`);

// election_day_list_roles_v3 (the trusted v3 role-catalog read the app's
// permission engine actually calls) filters strictly by
// `r.workspace_id = <session-resolved workspace>` - no fallback for a
// global/unscoped (workspace_id IS NULL) built-in role. The one real
// Production workspace got its usable roles via exactly this mechanism (see
// the historical-backfill migration's own `update election_day_roles set
// workspace_id = ...`), not a clone - mirrored here for this disposable
// local workspace so the fixture's session resolves a real, workspace-
// scoped role the same way a real workspace does.
runSql(`update election_day_roles set workspace_id = '${workspaceId}' where id = '${managerRoleId}' returning id;`);

runSql(`
  insert into election_day_permission_users (name, password_hash, role_id, workspace_id)
  values (
    '${FIXTURE_USER_NAME}',
    crypt('${FIXTURE_PASSWORD}', gen_salt('bf')),
    '${managerRoleId}',
    '${workspaceId}'
  )
  returning id;
`);

function insertCoordinatorSql(displayName) {
  return `
    insert into election_day_coordinators (display_name, status, workspace_id)
    values ('${displayName}', 'active', '${workspaceId}')
    returning id;
  `;
}

function insertVoterSql(coordinatorName, idSuffix) {
  return `
    insert into election_day_voters (
      masad, first_name, last_name, street, house_number, city, coordinator, workspace_id
    ) values (
      '', 'SMOKE', 'voter_${idSuffix}', '', 0, '', '${coordinatorName}', '${workspaceId}'
    )
    returning id;
  `;
}

// ---------------------------------------------------------------------------
// Playwright
// ---------------------------------------------------------------------------
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

// Defense-in-depth: even though VITE_SUPABASE_URL is checked above to be
// local-only, hard-block any request that somehow still targets Production
// Supabase, for every context this script opens.
let prodHits = 0;
async function blockProductionSupabase(page, label) {
  await page.route("**nbymfgphnsounqncfjgl.supabase.co**", (route) => {
    prodHits++;
    console.error(`BLOCKED production-bound request [${label}]: ${route.request().url()}`);
    return route.abort();
  });
}

// Real login through the actual login form - no localStorage injection, no
// fake session. Waits for the real POST /api/election-day/session (via the
// local API harness) to resolve and for the app to navigate off the login
// screen.
async function realLogin(page, label) {
  await page.goto(`${BASE}/election-day/login`, { waitUntil: "networkidle" });
  const nameInput = page.locator("form input").first();
  const passwordInput = page.locator('form input[type="password"]');
  await nameInput.fill(FIXTURE_USER_NAME);
  await passwordInput.fill(FIXTURE_PASSWORD);
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/api/election-day/session") && res.request().method() === "POST",
    ),
    page.locator('form button[type="submit"]').click(),
  ]);
  assert(response.status() === 200, `${label}: real login POST /api/election-day/session returned 200`);
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 10000 });
}

async function openAllocationScreen(page) {
  await page.goto(`${BASE}/election-day/files`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=ניהול הקצאות", { timeout: 15000 }).catch(() => {});
  await page.locator("text=ניהול הקצאות").first().click();
  await page.waitForTimeout(700);
}

function watchMutation(page) {
  const state = { fired: false };
  page.route(COORDINATOR_ALLOCATION_ENDPOINT, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        if (JSON.parse(req.postData() ?? "{}").op === "manage_coordinators") {
          state.fired = true;
        }
      } catch {
        // malformed body - not a manage_coordinators call we care about
      }
    }
    return route.continue();
  });
  return state;
}

// =====================================================================
// SETUP MODE - real workspace with 0 coordinators/voters at this point in
// the run -> resolveCoordinatorAllocationPhase resolves to "setup".
// =====================================================================
{
  const label = "setup";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await blockProductionSupabase(page, label);
  await realLogin(page, label);
  const mutation = watchMutation(page);

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
  assert(!mutation.fired, `${label}: cancel on an empty form fired no mutation RPC`);

  await addToggle.click();
  await page.waitForTimeout(300);
  await page.locator('input[placeholder="שם האחראי"]').first().fill("SMOKE_should_not_save");
  await page.locator('input[placeholder="050-1234567"]').first().fill("0501234567");
  await page.locator('button:has-text("ביטול")').first().click();
  await page.waitForTimeout(300);
  assert(!mutation.fired, `${label}: cancel with partial name+phone fired no mutation RPC`);
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

// Seed a real, active coordinator with zero voters yet for the Live block.
runSql(insertCoordinatorSql("SMOKE_live_coordinator"));

// =====================================================================
// LIVE MODE - 1 real coordinator now exists in this workspace -> resolves
// to "live".
// =====================================================================
{
  const label = "live";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await blockProductionSupabase(page, label);
  await realLogin(page, label);
  const mutation = watchMutation(page);

  await openAllocationScreen(page);

  const bodyText = await page.locator("body").innerText();
  assert(
    bodyText.includes("אחראים פעילים") || bodyText.includes('סה"כ בוחרים'),
    `${label}: resolves to the Live view (real coordinator present)`,
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
  assert(!mutation.fired, `${label}: cancel with partial data fired no mutation RPC`);
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

// Seed a real voter whose `coordinator` text matches the live coordinator's
// display_name exactly - the exact condition that, pre-2026-08-23, always
// triggered the (now-removed) "קשר לאחראי הזה" link-suggestion banner.
runSql(insertVoterSql("SMOKE_live_coordinator", "1"));

// =====================================================================
// REGRESSION: removed link-suggestion banner ("קשר לאחראי הזה" / "עדכן
// קישור") must never reappear, in either consumer, even in the exact
// condition that used to trigger it unconditionally - a coordinator whose
// linked_assignment_name is null and who has a raw-matching voter (see
// useCoordinatorRowActions.ts's 2026-08-23 removal comment).
// =====================================================================
{
  const label = "live-with-matching-voter";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await blockProductionSupabase(page, label);
  await realLogin(page, label);
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

// Seed a second real coordinator plus its own matching voter, plus one
// unassigned voter (coordinator: "") which forces
// resolveCoordinatorAllocationPhase to "setup" regardless of either
// coordinator above - exercises CoordinatorRow (Setup's list), not
// CoordinatorLiveRow.
runSql(insertCoordinatorSql("SMOKE_setup_coordinator"));
runSql(insertVoterSql("SMOKE_setup_coordinator", "2"));
runSql(insertVoterSql("", "3"));

{
  const label = "setup-with-existing-coordinator-and-matching-voter";
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  attachErrorListeners(page, label);
  await blockProductionSupabase(page, label);
  await realLogin(page, label);
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

assert(errors.length === 0, `no console/page errors across all scenarios (found ${errors.length})`);
if (errors.length > 0) for (const e of errors) console.log(" -", e);
assert(prodHits === 0, `zero requests were ever attempted against Production Supabase (found ${prodHits})`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
