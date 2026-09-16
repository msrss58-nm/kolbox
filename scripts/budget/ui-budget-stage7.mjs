// Budget Stage 7A - REAL-LOCAL UI suite for release readiness: navigation /
// routing integration (every menu item, deep links, refresh on nested routes,
// back / forward), the entitlement states, UI hiding per Budget permission, the
// Election Owner's deletion export (end to end through the real handlers and
// Storage, the folder picker replaced by an in-memory stub), 390px on every
// primary page, and basic accessibility (names, labels, dialog focus, focus
// visibility, RTL).
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack,
// serves it with scripts/stage5/localServer.mjs (vercel.json rewrites -> the
// REAL bundled handlers) and drives headless Chromium. Synthetic *.invalid
// identities only.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/ui-budget-stage7.mjs <outDir>
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-budget-stage7-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const PORT = 5201;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = BASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S7UI-${RUN}`;
const DOMAIN = `budget-stage7-ui-${RUN}.invalid`;
const PW = "S7-Ui-Pw-8!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const CODE_A = mkCode();
const CODE_B = mkCode();
const CODE_C = mkCode();
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const ED_VIEW = ["voter.viewName", "voter.viewAddress", "voter.viewPhone", "voter.viewVotedStatus"];
const BUDGET_ROUTES = ["/budget/dashboard", "/budget/planning", "/budget/expenses", "/budget/suppliers", "/budget/reports", "/budget/settings"];

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
const WC = ws("C election-day-only", CODE_C);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values
  ('${WA}','election_day'), ('${WA}','budget'), ('${WB}','budget'), ('${WC}','election_day');`);
const role = (w, name, perms) => psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
const SINGLE = {
  view: [], exp: ["budget.manageExpenses"], sub: ["budget.manageFunderSubmissions"], sup: ["budget.manageSuppliers"],
  plan: ["budget.managePlan"], rep: ["budget.viewReports"], set: ["budget.manageSettings"],
};
user(WA, "a-full", role(WA, "full", [...ALL, ...ED_VIEW]));
for (const [k, p] of Object.entries(SINGLE)) user(WA, `a-${k}`, role(WA, k, ["budget.view", ...p, ...ED_VIEW]));
user(WB, "b-full", role(WB, "b full", ALL));
user(WC, "c-full", role(WC, "c full", [...ALL, ...ED_VIEW]));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner S7', '${ownerEmail}');`);

psql("delete from public.election_day_login_attempts;");
const lr = await callHandler(H.electionSession, { method: "POST", url: "/api/election-day/session", headers: { origin: BASE },
  body: { workspaceCode: CODE_A, name: "a-full", password: PW } });
const cookie = String(lr.headers?.["set-cookie"] ?? "").split(";")[0].split("=").slice(1).join("=");
const api = async (op, args) => (await callHandler(H.budget, { method: "POST", url: "/api/budget/actions", headers: { origin: BASE },
  body: { op, args }, cookies: { "__Host-kb_ed_session": cookie } })).body?.data;
const C1 = (await api("create_category", { name: "שילוט S7" })).id;
await api("set_category_plan", { categoryId: C1, originalPlan: 1000000 });
const SP = (await api("create_source", { name: "מפלגה S7", kind: "party", originalAmount: 5000000 })).id;
const SD = (await api("create_source", { name: "תרומות S7", kind: "donation", originalAmount: 1000000 })).id;
const SUP = (await api("create_supplier", { businessName: "ספק S7" })).id;
const EXP = (await api("create_expense", { description: "הזמנת שלטים S7", supplierId: SUP, categoryId: C1, total: 120000, expenseDate: "2026-09-10" })).id;
await api("set_allocation", { expenseId: EXP, sourceId: SP, amount: 100000 });
await api("set_allocation", { expenseId: EXP, sourceId: SD, amount: 20000 });
await api("transition_expense", { expenseId: EXP, expectedVersion: (await api("get_expense", { expenseId: EXP })).version, toStatus: "committed" });
const types = Object.fromEntries((await api("get_settings")).documentTypes.map((t) => [t.key, t.id]));
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n%synthetic S7\n"), crypto.randomBytes(3000)]);
const start = await api("document_upload_start", { purpose: "expense", expenseId: EXP, documentTypeId: types.quotation,
  fileName: "הצעת מחיר.pdf", mimeType: "application/pdf", sizeBytes: pdf.length });
await fetch(start.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: pdf });
const done = await api("document_upload_complete", { uploadId: start.uploadId });
check("S1 fixtures: 3 workspaces, 9 roles, Owner, a committed split-funded party expense with a stored document",
  Boolean(WA && WB && WC && EXP && done?.documents?.length));

const server = await startLocalServer({
  distDir: dist, port: PORT,
  handlers: {
    "/api/health": H.health, "/api/platform/session": H.platformSession, "/api/election-day/session": H.electionSession,
    "/api/election-day/actions": H.actions, "/api/election-day/roles": H.roles, "/api/election-day/reauth": H.reauth,
    "/api/election-day/permission-users": H.permissionUsers, "/api/election-day/owner-actions": H.ownerActions,
    "/api/election-day/owner-roles": H.ownerRoles, "/api/election-day/owner-reauth": H.ownerReauth, "/api/budget/actions": H.budget,
  },
});

// The folder picker (File System Access API) cannot be driven headless: this
// stub hands the page an in-memory directory and records every file written
// (size + sha256; the text of the two JSON summaries).
const FOLDER_STUB = () => {
  window.__exportFiles = {};
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const dir = (prefix) => ({
    kind: "directory",
    async getDirectoryHandle(name) { return dir(prefix ? `${prefix}/${name}` : name); },
    async getFileHandle(name) {
      const filePath = prefix ? `${prefix}/${name}` : name;
      return {
        kind: "file",
        async createWritable() {
          const chunks = [];
          return {
            async write(data) {
              chunks.push(typeof data === "string" ? new TextEncoder().encode(data)
                : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
            },
            async close() {
              const size = chunks.reduce((s, c) => s + c.byteLength, 0);
              const all = new Uint8Array(size);
              let o = 0;
              for (const c of chunks) { all.set(c, o); o += c.byteLength; }
              const keepText = /(^|\/)(manifest|verification)\.json$/.test(filePath);
              window.__exportFiles[filePath] = { size, sha: hex(await crypto.subtle.digest("SHA-256", all)),
                text: keepText ? new TextDecoder().decode(all) : null };
            },
          };
        },
      };
    },
  });
  window.showDirectoryPicker = async () => dir("");
};

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1366, height: 900 }, { folder = false, noFolderApi = false } = {}) => {
  const ctx = await browser.newContext({ viewport, locale: "he-IL" });
  if (folder) await ctx.addInitScript(FOLDER_STUB);
  // Chromium ships the File System Access API; this simulates a browser that
  // does not (Firefox / Safari / mobile).
  if (noFolderApi) await ctx.addInitScript(() => { Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true }); });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const seen = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true, () => false);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const path0 = (p) => new URL(p.url()).pathname;
async function workerLogin(p, codeValue, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${BASE}/election-day/login?w=${codeValue}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }).catch(() => {});
}
async function ownerLogin(p) {
  await p.goto(`${BASE}/election-day/owner-login`);
  await p.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await p.locator('input[type="email"]').fill(ownerEmail);
  await p.locator('input[autocomplete="current-password"]').fill(PW);
  await p.getByRole("button", { name: "התחברות" }).click();
  // Owner sidebar accordion: the Budget module section starts collapsed.
  await p.getByRole("button", { name: "ניהול תקציב" }).first().waitFor({ timeout: 20000 });
  await p.getByRole("button", { name: "ניהול תקציב" }).first().click();
  await p.getByRole("link", { name: "הגדרות תקציב" }).first().click();
  await p.getByTestId("budget-export-card").waitFor({ timeout: 20000 });
}
const PAGE_ROOT = {
  "/budget/dashboard": "dashboard-kpis", "/budget/planning": "planning-summary", "/budget/expenses": "expense-total",
  "/budget/suppliers": "supplier-list", "/budget/reports": "report-tabs", "/budget/settings": "budget-settings",
};
/** Basic accessibility over the visible page: interactive elements without an
 * accessible name, form fields without a label. */
const a11y = (p) => p.evaluate(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const named = (el) => Boolean((el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || "").trim() ||
    el.getAttribute("aria-labelledby"));
  const unnamed = [...document.querySelectorAll('button, [role="button"], a[href]')].filter(visible).filter((el) => !named(el));
  const unlabeled = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible)
    .filter((el) => !(el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")));
  return { unnamed: unnamed.map((el) => el.outerHTML.slice(0, 90)), unlabeled: unlabeled.map((el) => el.outerHTML.slice(0, 90)) };
});

try {
  section("NAVIGATION / ROUTING INTEGRATION (Election Day + Budget worker)");
  const pa = await newPage();
  await workerLogin(pa, CODE_A, "a-full");
  await pa.goto(`${BASE}/budget/dashboard`);
  await pa.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
  const budgetHrefs = await pa.locator("aside a[href^='/budget/']").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  check("N01 'ניהול תקציב' menu = exactly the approved six, in order (דשבורד, תקציב ותכנון, הוצאות, ספקים, דוחות, הגדרות)",
    JSON.stringify(budgetHrefs) === JSON.stringify(BUDGET_ROUTES) &&
    (await pa.locator("aside nav").getByText("ניהול תקציב", { exact: true }).count()) === 1, budgetHrefs.join(" "));
  check("N02 the Election Day section is shown too (both modules entitled)", (await pa.locator("aside nav").getByText("יום הבחירות").count()) >= 1);
  let dead = [];
  for (const route of BUDGET_ROUTES) {
    await pa.locator(`aside a[href="${route}"]`).click();
    const okPage = path0(pa) === route && await seen(pa.getByTestId(PAGE_ROOT[route]), 20000);
    if (!okPage) dead.push(route);
  }
  check("N03 every menu item opens a working page (no dead link, no inaccessible screen)", dead.length === 0, dead.join(",") || "6/6");
  await pa.goto(`${BASE}/budget/expenses/${EXP}`);
  const deep = await seen(pa.getByTestId("expense-file"), 20000);
  await pa.reload();
  const refreshed = await seen(pa.getByTestId("expense-file"), 20000);
  await pa.goto(`${BASE}/budget/reports?report=payments`);
  await pa.reload();
  const repRefresh = await seen(pa.getByTestId("report-totals"), 20000) && new URL(pa.url()).searchParams.get("report") === "payments";
  check("N04 direct URL + refresh on nested routes (an expense file, a report with its query) keep their page", deep && refreshed && repRefresh);
  await pa.goto(`${BASE}/budget/dashboard`);
  await pa.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
  await pa.getByTestId("kpi-totalExpenses-link").click();
  await pa.getByTestId("expense-total").waitFor({ timeout: 20000 });
  const drilled = path0(pa);
  await pa.goBack();
  const back = await seen(pa.getByTestId("dashboard-kpis"), 15000) && path0(pa) === "/budget/dashboard";
  await pa.goForward();
  const fwd = await seen(pa.getByTestId("expense-total"), 15000) && path0(pa) === drilled;
  check("N05 drill-down, then browser back / forward return to the right pages", drilled === "/budget/expenses" && back && fwd, `${drilled} ${back} ${fwd}`);
  await pa.getByTestId("expense-total").waitFor({ timeout: 15000 });
  // The list renders every row twice (mobile card + desktop table): the visible one.
  await pa.locator(`a[href="/budget/expenses/${EXP}"]:visible`).first().click();
  await pa.getByTestId("expense-file").waitFor({ timeout: 20000 });
  await pa.goBack();
  check("N06 list -> expense file -> back returns to the list", await seen(pa.getByTestId("expense-total"), 15000));
  check("N07 Hebrew RTL document (lang=he, dir=rtl)", await pa.evaluate(() => document.documentElement.lang === "he" && document.documentElement.dir === "rtl"));
  await shot(pa, "01-navigation");

  section("ENTITLEMENT + SESSION STATES");
  const pc = await newPage();
  await workerLogin(pc, CODE_C, "c-full");
  await pc.waitForURL(/\/election-day/, { timeout: 20000 }).catch(() => {});
  await pc.locator("aside").first().waitFor({ timeout: 20000 }).catch(() => {});
  const noBudgetMenu = (await pc.locator("aside a[href^='/budget']").count()) === 0;
  await pc.goto(`${BASE}/budget/expenses`);
  check("E01 Election Day only: no Budget menu; a direct Budget URL shows 'המודול אינו זמין' (server-decided)",
    noBudgetMenu && await seen(pc.getByText("המודול אינו זמין"), 20000));
  const pb = await newPage();
  await workerLogin(pb, CODE_B, "b-full");
  await pb.waitForURL(/\/budget\/dashboard/, { timeout: 20000 }).catch(() => {});
  check("E02 Budget only: lands on the dashboard; no Election Day section", path0(pb) === "/budget/dashboard" &&
    (await pb.locator("aside nav").getByText("יום הבחירות").count()) === 0);
  await pb.goto(`${BASE}/election-day/dashboard`);
  await pb.waitForTimeout(2500);
  check("E03 Budget only: an Election Day URL never shows Election Day data (lands on its sign-in - documented residual)",
    /\/election-day\/login/.test(path0(pb)) || await seen(pb.locator('input[name="election-day-username"]'), 5000), path0(pb));
  psql(`update public.platform_modules set available = false where key = 'budget';`);
  await pa.goto(`${BASE}/budget/dashboard`);
  const killed = await seen(pa.getByText("המודול אינו זמין"), 20000);
  psql(`update public.platform_modules set available = true where key = 'budget';`);
  await pa.reload();
  check("E04 kill switch off -> the module is unavailable; restored -> back", killed && await seen(pa.getByTestId("dashboard-kpis"), 20000));
  const pn = await newPage();
  await pn.goto(`${BASE}/budget/reports`);
  await pn.waitForURL(/\/election-day\/login/, { timeout: 20000 }).catch(() => {});
  check("E05 no session: a Budget URL goes to the sign-in", /\/election-day\/login/.test(path0(pn)), path0(pn));

  section("UI HIDING PER BUDGET PERMISSION (the server enforces separately - API suite)");
  for (const k of Object.keys(SINGLE)) {
    const p = await newPage();
    await workerLogin(p, CODE_A, `a-${k}`);
    await p.goto(`${BASE}/budget/dashboard`);
    await p.getByTestId("dashboard-kpis").waitFor({ timeout: 20000 });
    const got = {
      reportsMenu: (await p.locator("aside a[href='/budget/reports']").count()) > 0,
      settingsMenu: (await p.locator("aside a[href='/budget/settings']").count()) > 0,
    };
    await p.goto(`${BASE}/budget/expenses`);
    await p.getByTestId("expense-total").waitFor({ timeout: 20000 });
    got.newExpense = (await p.getByTestId("new-expense").count()) > 0;
    await p.goto(`${BASE}/budget/suppliers`);
    await p.getByTestId("supplier-list").waitFor({ timeout: 20000 });
    got.newSupplier = (await p.getByTestId("new-supplier").count()) > 0;
    await p.goto(`${BASE}/budget/planning`);
    await p.getByTestId("planning-summary").waitFor({ timeout: 20000 });
    got.newSource = (await p.getByRole("button", { name: "מקור מימון חדש" }).count()) > 0;
    await p.goto(`${BASE}/budget/expenses/${EXP}`);
    await p.getByTestId("expense-file").waitFor({ timeout: 20000 });
    await p.getByTestId("party-preapproval").waitFor({ timeout: 15000 }).catch(() => {});
    got.transitions = (await p.getByTestId("expense-transitions").count()) > 0;
    got.preapproval = (await p.getByTestId("record-preapproval").count()) > 0;
    const expected = {
      reportsMenu: k === "rep", settingsMenu: k === "set", newExpense: k === "exp", newSupplier: k === "sup",
      newSource: k === "plan" || k === "set", transitions: k === "exp", preapproval: k === "sub",
    };
    check(`PU-${k} budget.view${k === "view" ? " only" : " + " + SINGLE[k][0]}: exactly its own controls are shown`,
      JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
    await p.context().close();
  }

  section("ELECTION OWNER: the deletion export (Owner admin shell)");
  const pu = await newPage(undefined, { noFolderApi: true });
  await ownerLogin(pu);
  check("X01 without the File System Access API the export is explained and disabled (no download fallback)",
    await seen(pu.getByTestId("export-unsupported")) && await pu.getByTestId("export-start").isDisabled());
  await pu.context().close();
  const po = await newPage({ width: 1366, height: 900 }, { folder: true });
  await ownerLogin(po);
  await po.getByTestId("export-status").waitFor({ timeout: 20000 });
  check("X02 status before any export: none; permanent deletion blocked",
    (await po.getByTestId("export-status").getAttribute("data-state")) === "none" &&
    (await po.getByTestId("export-deletion").getAttribute("data-allowed")) === "false");
  await shot(po, "02-owner-export-before");
  await po.getByTestId("export-start").click();
  const fresh = await seen(po.locator('[data-testid="export-status"][data-state="fresh"]'), 90000);
  check("X03 one click: every part and document exported, checksum-verified and confirmed by the server -> fresh; deletion allowed",
    fresh && (await po.getByTestId("export-deletion").getAttribute("data-allowed")) === "true");
  const files = await po.evaluate(() => window.__exportFiles);
  const names = Object.keys(files);
  const manifestPath = names.find((n) => n.endsWith("/manifest.json"));
  const manifest = manifestPath ? JSON.parse(files[manifestPath].text) : null;
  const dataFiles = names.filter((n) => n.includes("/data/"));
  const docFiles = names.filter((n) => n.includes("/documents/"));
  const partShaOk = manifest ? manifest.tables.every((t) => t.parts.every((pt) => {
    const f = files[names.find((n) => n.endsWith(`/data/${t.name}/part-${String(pt.part + 1).padStart(5, "0")}.json`))];
    return f && f.sha === pt.sha256;
  })) : false;
  const storedSha = psql(`select string_agg(sha256, ',' order by sha256) from public.budget_document_versions where workspace_id = '${WA}';`).split(",");
  check("X04 the folder holds manifest.json, one file per part (sha256 = manifest), every document (sha256 = stored), verification.json",
    Boolean(manifest) && dataFiles.length === manifest.totals.parts && partShaOk && docFiles.length === manifest.documents.count &&
    JSON.stringify(docFiles.map((n) => files[n].sha).sort()) === JSON.stringify(storedSha) &&
    names.some((n) => n.endsWith("/verification.json")), `${dataFiles.length} parts, ${docFiles.length} documents`);
  check("X05 the document keeps its Hebrew name inside the export folder", docFiles.some((n) => n.endsWith("הצעת מחיר.pdf")), docFiles.join(","));
  await shot(po, "03-owner-export-fresh");
  await api("update_supplier", { supplierId: SUP, phone: "0501234567" });
  await po.reload();
  await po.getByTestId("export-status").waitFor({ timeout: 20000 });
  check("X06 any Budget change afterwards -> the export is stale and deletion blocked again",
    (await po.getByTestId("export-status").getAttribute("data-state")) === "stale" &&
    (await po.getByTestId("export-deletion").getAttribute("data-allowed")) === "false");
  await po.setViewportSize({ width: 390, height: 844 });
  await po.waitForTimeout(800);
  check("X07 Owner Budget settings + export card: no horizontal overflow at 390", await noOverflow(po));
  await shot(po, "04-owner-export-mobile");

  section("RESPONSIVE 390 (every primary page, dialogs, document + party controls)");
  const pm = await newPage({ width: 390, height: 844 });
  await workerLogin(pm, CODE_A, "a-full");
  const overflow = [];
  for (const route of [...BUDGET_ROUTES, `/budget/expenses/${EXP}`]) {
    await pm.goto(`${BASE}${route}`);
    await pm.getByTestId(PAGE_ROOT[route] ?? "expense-file").waitFor({ timeout: 20000 }).catch(() => {});
    await pm.waitForTimeout(700);
    if (!(await noOverflow(pm))) overflow.push(route);
    await shot(pm, `05-mobile-${route.split("/").slice(2).join("-").slice(0, 20)}`);
  }
  check("M01 no horizontal overflow at 390: dashboard, planning, expenses, suppliers, reports, settings, expense details", overflow.length === 0, overflow.join(","));
  await pm.goto(`${BASE}/budget/expenses/${EXP}`);
  await pm.getByTestId("expense-file").waitFor({ timeout: 20000 });
  check("M02 expense details at 390: documents + party workflow controls present, still no overflow",
    await seen(pm.getByTestId("expense-documents")) && await seen(pm.getByTestId("record-preapproval")) && await noOverflow(pm));
  await pm.goto(`${BASE}/budget/suppliers`);
  await pm.locator('[data-testid="supplier-file-open"]:visible').first().click();
  const supDialog = await seen(pm.getByTestId("supplier-file"), 15000);
  check("M03 supplier details (supplier file dialog) at 390 without overflow", supDialog && await noOverflow(pm));
  await shot(pm, "06-mobile-supplier-file");
  await pm.keyboard.press("Escape");
  await pm.goto(`${BASE}/budget/expenses`);
  await pm.getByTestId("new-expense").click();
  const dlg = pm.getByRole("dialog");
  await dlg.waitFor({ timeout: 15000 });
  check("M04 the new-expense form opens as a sheet at 390 without overflow", await noOverflow(pm));
  await shot(pm, "07-mobile-new-expense");

  section("ACCESSIBILITY (basic, within the current design system)");
  const focusInDialog = await pm.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  // Validation: an empty form cannot be submitted (the save button is disabled,
  // or a click leaves the dialog open).
  const save = dlg.getByRole("button", { name: "שמירה" });
  const saveDisabled = await save.isDisabled();
  if (!saveDisabled) await save.click();
  const stillOpen = await dlg.isVisible();
  await pm.keyboard.press("Escape");
  const closed = await pm.getByRole("dialog").count() === 0 || !(await pm.getByRole("dialog").first().isVisible());
  check("A01 dialog: focus moves into it, an empty form cannot be submitted (validation), Escape closes it", focusInDialog && stillOpen && closed,
    `focus=${focusInDialog} saveDisabled=${saveDisabled} open=${stillOpen} closed=${closed}`);
  const pk = await newPage();
  await workerLogin(pk, CODE_A, "a-full");
  const issues = {};
  for (const route of [...BUDGET_ROUTES, `/budget/expenses/${EXP}`]) {
    await pk.goto(`${BASE}${route}`);
    await pk.getByTestId(PAGE_ROOT[route] ?? "expense-file").waitFor({ timeout: 20000 }).catch(() => {});
    await pk.waitForTimeout(500);
    const r = await a11y(pk);
    if (r.unnamed.length || r.unlabeled.length) issues[route] = r;
  }
  check("A02 every visible button / link has an accessible name and every form field a label (7 pages)", Object.keys(issues).length === 0,
    JSON.stringify(issues).slice(0, 600));
  await pk.goto(`${BASE}/budget/expenses`);
  await pk.getByTestId("expense-total").waitFor({ timeout: 20000 });
  let focusVisible = true;
  for (let i = 0; i < 6; i++) {
    await pk.keyboard.press("Tab");
    const ring = await pk.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return true;
      const s = getComputedStyle(el);
      return s.outlineStyle !== "none" || s.boxShadow !== "none";
    });
    focusVisible = focusVisible && ring;
  }
  check("A03 keyboard: Tab moves through the page with a visible focus indicator", focusVisible);
  check("A04 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
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
  void sha;
}
process.exit(tally("BUDGET STAGE 7A UI") ? 1 : 0);
