// Budget Stage 6 - REAL-LOCAL UI suite for the dashboard and the reports.
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack,
// serves it with scripts/stage5/localServer.mjs (vercel.json rewrites -> the
// REAL bundled handlers) and drives headless Chromium: KPI drill-downs, queue
// counts = list counts, charts, alerts, recent expenses, the seven reports
// with filters / pagination / drill-down, permissions, a Budget-only
// workspace and 390px mobile. Synthetic *.invalid identities only.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/ui-budget-reports.mjs <outDir>
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { startLocalServer } from "../stage5/localServer.mjs";
import { admin, callHandler, check, installLocalnetGuard, loadStack, psql, section, tally } from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-budget-reports-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const PORT = 5198;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = BASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S6UI-${RUN}`;
const DOMAIN = `budget-reports-ui-${RUN}.invalid`;
const PW = "S6-Ui-Pw-4!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const CODE_A = mkCode();
const CODE_B = mkCode();
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];

section("BUILD the election surface against the scratch stack");
const dist = path.join(outDir, "dist-election");
execFileSync(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist,
  "--emptyOutDir", "--logLevel", "error"], {
  cwd: repoRoot,
  env: { ...process.env, VITE_APP_SURFACE: "election", VITE_SUPABASE_URL: stackEnv.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY },
  stdio: ["ignore", "ignore", "inherit"],
});
check("B1 election bundle built", fs.existsSync(path.join(dist, "index.html")));

section("SETUP (scratch stack only)");
psql(`update public.platform_modules set available = true where key = 'budget'; delete from public.election_day_login_attempts;`);
const ws = (label, c) => psql(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() + interval '5 days', '${c}') returning id;`);
const WA = ws("A", CODE_A);
const WB = ws("B budget-only", CODE_B);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}','election_day'), ('${WA}','budget'), ('${WB}','budget');`);
const role = (w, name, perms) => psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
user(WA, "r-full", role(WA, "full", [...ALL, "voter.viewName"]));
user(WA, "r-view", role(WA, "view", ["budget.view"]));
user(WB, "r-bonly", role(WB, "b full", ALL));

psql("delete from public.election_day_login_attempts;");
const lr = await callHandler(H.electionSession, { method: "POST", url: "/api/election-day/session", headers: { origin: BASE },
  body: { workspaceCode: CODE_A, name: "r-full", password: PW } });
const cookie = String(lr.headers?.["set-cookie"] ?? "").split(";")[0].split("=").slice(1).join("=");
const api = async (op, args) => (await callHandler(H.budget, { method: "POST", url: "/api/budget/actions", headers: { origin: BASE },
  body: { op, args }, cookies: { "__Host-kb_ed_session": cookie } })).body?.data;
const C1 = (await api("create_category", { name: "שילוט UI" })).id;
const C2 = (await api("create_category", { name: "אירועים UI" })).id;
await api("set_category_plan", { categoryId: C1, originalPlan: 1000000 });
await api("set_category_plan", { categoryId: C2, originalPlan: 100000 });
const SP = (await api("create_source", { name: "מפלגה UI", kind: "party", originalAmount: 5000000 })).id;
const SD = (await api("create_source", { name: "תרומות UI", kind: "donation", originalAmount: 2000000 })).id;
const SPE = (await api("create_source", { name: "עצמי UI", kind: "personal", originalAmount: 1000000 })).id;
const SUP = (await api("create_supplier", { businessName: "ספק דוחות UI" })).id;
const mk = async (desc, total, cat, allocs, status) => {
  const e = await api("create_expense", { description: desc, supplierId: SUP, categoryId: cat, total, expenseDate: "2026-09-10" });
  for (const [s, amount] of allocs) await api("set_allocation", { expenseId: e.id, sourceId: s, amount });
  if (status) await api("transition_expense", { expenseId: e.id, expectedVersion: (await api("get_expense", { expenseId: e.id })).version, toStatus: status });
  return e.id;
};
const E_GAP = await mk("שלטים עם פער UI", 500000, C1, [[SD, 300000]], "committed");
const E_AWAIT = await mk("הזמנת במה UI", 150000, C2, [[SP, 150000]], "committed");
const E_PAID = await mk("פרסום UI", 200000, C1, [[SPE, 200000]], "incurred");
const paid = await api("get_expense", { expenseId: E_PAID });
await api("record_payment", { allocationId: paid.allocations[0].id, amount: 200000, paymentDate: "2026-09-12", confirmationSource: "bank_transfer",
  idempotencyKey: crypto.randomUUID() });
// 55 more drafts so the expense report pages (50 per page).
psql(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${crypto.randomUUID()}","name":"fixture","workspace_id":"${WA}"}', false);
  insert into public.budget_expenses (workspace_id, reference_no, description, status)
  select '${WA}', 1000 + g, 'טיוטה UI ' || g, 'draft' from generate_series(1, 55) g;`);
check("S1 fixtures created (gap, awaiting prior approval, overrun category, paid expense, 58 expenses)", Boolean(E_GAP && E_AWAIT && E_PAID));

const server = await startLocalServer({
  distDir: dist, port: PORT,
  handlers: {
    "/api/health": H.health, "/api/platform/session": H.platformSession, "/api/election-day/session": H.electionSession,
    "/api/election-day/actions": H.actions, "/api/election-day/roles": H.roles, "/api/election-day/reauth": H.reauth,
    "/api/election-day/permission-users": H.permissionUsers, "/api/election-day/owner-actions": H.ownerActions,
    "/api/election-day/owner-roles": H.ownerRoles, "/api/election-day/owner-reauth": H.ownerReauth, "/api/budget/actions": H.budget,
  },
});

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1366, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, locale: "he-IL" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const seen = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true, () => false);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function workerLogin(p, codeValue, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${BASE}/election-day/login?w=${codeValue}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }).catch(() => {});
}
const listTotal = async (p) => {
  await p.getByTestId("expense-total").waitFor({ timeout: 15000 });
  return (await p.getByTestId("expense-total").innerText()).trim();
};

try {
  section("DASHBOARD");
  const pa = await newPage();
  await workerLogin(pa, CODE_A, "r-full");
  await pa.goto(`${BASE}/budget`);
  await pa.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
  check("D01 /budget opens the dashboard with the six KPI tiles", new URL(pa.url()).pathname === "/budget/dashboard" &&
    (await pa.getByTestId("dashboard-kpis").locator('[data-testid^="kpi-"][data-testid$="-link"]').count()) === 6);
  const kpiTotal = (await pa.getByTestId("kpi-totalExpenses-link").innerText()).split("\n").pop().trim();
  check("D02 total expenses with a commitments subline", await seen(pa.getByTestId("kpi-totalExpenses-sub")));
  await shot(pa, "01-dashboard");
  await pa.getByTestId("kpi-totalExpenses-link").click();
  const t1 = await listTotal(pa);
  check("D03 the 'total expenses' KPI drills into the list with the same amount", t1.includes(kpiTotal) &&
    await seen(pa.getByTestId("extra-filters")), `${kpiTotal} vs ${t1}`);
  await pa.goto(`${BASE}/budget/dashboard`);
  const qAwait = pa.getByTestId("queue-awaiting_preapproval");
  const qCount = (await qAwait.getByTestId("queue-count").innerText()).trim();
  await qAwait.locator("a").click();
  const t2 = await listTotal(pa);
  check("D04 a queue count equals its drill-down list count", qCount === "1" && t2.includes(": 1 ·"), `${qCount} / ${t2}`);
  await pa.goto(`${BASE}/budget/dashboard`);
  await pa.getByTestId("dashboard-kpis").waitFor({ timeout: 15000 });
  check("D05 a zero queue shows its empty state and is not a link", (await pa.getByTestId("queue-ready_to_submit").locator("a").count()) === 0 &&
    await seen(pa.getByTestId("queue-ready_to_submit").getByText("אין פריטים")));
  check("D06 charts render (category, source, plan vs actual, over time)",
    (await pa.getByTestId("chart-category").locator("svg").count()) > 0 && (await pa.getByTestId("chart-source").locator("svg").count()) > 0 &&
    (await pa.getByTestId("chart-plan").locator("svg").count()) > 0 && (await pa.getByTestId("chart-time").locator("svg").count()) > 0);
  check("D07 attention alerts: funding gap and the overrun category are listed",
    await seen(pa.getByTestId("dashboard-alerts").locator('[data-alert="unfunded"]')) &&
    await seen(pa.getByTestId("dashboard-alerts").locator('[data-alert="category_overrun"]')));
  await pa.getByTestId("dashboard-alerts").locator('[data-alert="unfunded"] a').click();
  check("D08 the funding-gap alert drills into the unfunded list", (await listTotal(pa)).includes(": 1 ·"));
  await pa.goto(`${BASE}/budget/dashboard`);
  await pa.getByTestId("dashboard-recent").locator("a").first().click();
  check("D09 a recent expense opens its expense file", await seen(pa.getByTestId("expense-file"), 20000));

  section("REPORTS");
  await pa.goto(`${BASE}/budget/reports`);
  await pa.getByTestId("report-tabs").waitFor({ timeout: 20000 });
  let tabsOk = true;
  for (const r of ["expenses", "categories", "sources", "suppliers", "party", "plan", "payments"]) {
    await pa.getByTestId("report-tabs").locator(`[data-report="${r}"]`).click();
    const okTab = await seen(pa.getByTestId("report-totals"), 15000);
    if (!okTab) tabsOk = false;
  }
  check("R01 all seven reports render their totals", tabsOk);
  await pa.getByTestId("report-tabs").locator('[data-report="expenses"]').click();
  // Wait for THIS report's pager (the previous tab's table may still be on
  // screen for a moment after the click).
  await pa.getByTestId("report-page").getByText("1–50 מתוך 58").waitFor({ timeout: 15000 }).catch(() => {});
  check("R02 expense report pages at 50 (58 rows)", (await pa.getByTestId("report-row").count()) === 50 &&
    (await pa.getByTestId("report-page").innerText()).includes("1–50 מתוך 58"));
  await pa.getByTestId("report-next").click();
  await pa.getByTestId("report-page").getByText("51–58 מתוך 58").waitFor({ timeout: 15000 }).catch(() => {});
  check("R03 next page shows the remaining 8 rows", (await pa.getByTestId("report-row").count()) === 8);
  await pa.locator('[data-filter="categoryId"]').selectOption({ label: "אירועים UI" });
  await pa.getByTestId("report-page").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  check("R04 a category filter narrows the report (one expense, no pager)", (await pa.getByTestId("report-row").count()) === 1);
  await shot(pa, "02-report-expenses");
  await pa.getByTestId("report-tabs").locator('[data-report="plan"]').click();
  await pa.getByTestId("report-table").waitFor({ timeout: 15000 });
  check("R05 plan vs actual shows the overrun state", await seen(pa.getByTestId("report-table").locator('[data-state="overrun"]')));
  await pa.getByTestId("report-table").getByRole("link", { name: "אירועים UI" }).click();
  check("R06 a plan row drills into that category's expenses", (await listTotal(pa)).includes(": 1 ·"));
  await pa.goto(`${BASE}/budget/reports?report=payments`);
  await pa.getByTestId("report-table").waitFor({ timeout: 15000 });
  check("R07 payment report lists the supplier payment", (await pa.getByTestId("report-row").count()) === 1);
  await shot(pa, "03-report-payments");

  section("PERMISSIONS + BUDGET-ONLY");
  const pv = await newPage();
  await workerLogin(pv, CODE_A, "r-view");
  await pv.goto(`${BASE}/budget/dashboard`);
  await pv.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
  check("P01 budget.view: dashboard works, no 'דוחות' in the menu, KPI links fall back to planning",
    (await pv.locator("aside").getByRole("link", { name: "דוחות" }).count()) === 0 &&
    (await pv.getByTestId("kpi-totalBudget-link").getAttribute("href")) === "/budget/planning");
  await pv.goto(`${BASE}/budget/reports`);
  check("P02 ... and the reports route shows the permission state (no data request)", await seen(pv.getByTestId("reports-forbidden")));
  const pb = await newPage();
  await workerLogin(pb, CODE_B, "r-bonly");
  await pb.waitForURL(/\/budget\/dashboard/, { timeout: 20000 }).catch(() => {});
  await pb.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 }).catch(() => {});
  check("B01 Budget-only workspace: lands on the dashboard, no Election Day section, empty-budget guidance",
    new URL(pb.url()).pathname === "/budget/dashboard" && (await pb.locator("aside nav").getByText("יום הבחירות").count()) === 0 &&
    await seen(pb.getByText("עוד לא הוגדר תקציב")));
  await pb.goto(`${BASE}/budget/reports?report=plan`);
  check("B02 Budget-only workspace: reports work (empty state)", await seen(pb.getByTestId("report-totals")));
  await shot(pb, "04-budget-only-dashboard");

  section("MOBILE");
  const pm = await newPage({ width: 390, height: 844 });
  await workerLogin(pm, CODE_A, "r-full");
  await pm.goto(`${BASE}/budget/dashboard`);
  await pm.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
  await pm.getByTestId("chart-time").waitFor({ timeout: 15000 });
  const mDash = await noOverflow(pm);
  await shot(pm, "05-mobile-dashboard");
  await pm.goto(`${BASE}/budget/reports?report=expenses`);
  await pm.getByTestId("report-cards").waitFor({ timeout: 20000 });
  const mRep = await noOverflow(pm);
  await shot(pm, "06-mobile-report");
  await pm.goto(`${BASE}/budget/reports?report=plan`);
  await pm.getByTestId("report-cards").waitFor({ timeout: 20000 });
  const mPlan = await noOverflow(pm);
  check("M01 no horizontal overflow at 390 (dashboard, expense report cards, plan report cards)", mDash && mRep && mPlan);
  check("M02 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e).slice(0, 300));
  let i = 0;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      i += 1;
      const text = await p.locator("body").innerText().catch(() => "");
      console.log(`  [diag] page ${i} url=${new URL(p.url()).pathname} text=${text.replace(/\s+/g, " ").slice(0, 200)}`);
      await shot(p, `zz-failure-${i}`).catch(() => undefined);
    }
  }
} finally {
  await browser.close();
  server.close();
  psql(`update public.platform_modules set available = false where key = 'budget';`);
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
process.exit(tally("BUDGET REPORTS UI") ? 1 : 0);
