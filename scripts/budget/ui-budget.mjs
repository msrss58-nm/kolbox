// Budget Stage 3 - REAL-LOCAL UI smoke suite for the Budget module.
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack,
// serves it with scripts/stage5/localServer.mjs (vercel.json rewrites -> the
// REAL bundled handlers, including api/budget/actions.ts) and drives headless
// Chromium through real PermissionUser and Election Owner sign-ins. Synthetic
// *.invalid identities only; nothing secret is printed.
//
// Run:  S5_STACK_DIR=<scratch>/s9stack [S5_PORT_OFFSET=1000] node scripts/budget/ui-budget.mjs <outDir>
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { startLocalServer } from "../stage5/localServer.mjs";
import { admin, check, installLocalnetGuard, loadStack, psql, section, tally } from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-budget-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const E_PORT = 5195;
const EBASE = `http://127.0.0.1:${E_PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S3UI-${RUN}`;
const DOMAIN = `budget-ui-${RUN}.invalid`;
const PW = "S3-Ui-Pw-7!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const ALL_BUDGET = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
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
const CODE_A = code();
const CODE_B = code();
const ws = (label, c, ended) => psql(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() ${ended ? "-" : "+"} interval '5 days', '${c}') returning id;`);
const WA = ws("A", CODE_A, false);
const WB = ws("B", CODE_B, true);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values
  ('${WA}','election_day'), ('${WA}','budget'), ('${WB}','budget');`);
const role = (w, name, perms) => psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
const ED_VIEW = ["voter.viewName", "voter.viewAddress", "voter.viewPhone", "voter.viewVotedStatus"];
user(WA, "a-full", role(WA, "full", [...ALL_BUDGET, ...ED_VIEW]));
user(WA, "a-nobudget", role(WA, "no budget", [...ED_VIEW, "electionDay.import"]));
user(WB, "b-full", role(WB, "b full", ALL_BUDGET));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner UI', '${ownerEmail}');`);
check("S1 fixtures created", Boolean(WA && WB));

const server = await startLocalServer({
  distDir: dist,
  port: E_PORT,
  handlers: {
    "/api/health": H.health,
    "/api/platform/session": H.platformSession,
    "/api/election-day/session": H.electionSession,
    "/api/election-day/actions": H.actions,
    "/api/election-day/roles": H.roles,
    "/api/election-day/reauth": H.reauth,
    "/api/election-day/permission-users": H.permissionUsers,
    "/api/election-day/owner-actions": H.ownerActions,
    "/api/election-day/owner-roles": H.ownerRoles,
    "/api/election-day/owner-reauth": H.ownerReauth,
    "/api/budget/actions": H.budget,
  },
});

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1280, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, locale: "he-IL" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const waitText = (p, t, timeout = 15000) => p.getByText(t).first().waitFor({ timeout }).then(() => true, () => false);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function workerLogin(p, c, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${EBASE}/election-day/login?w=${c}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
}

try {
  section("NAVIGATION + SESSION");
  const pb = await newPage();
  await workerLogin(pb, CODE_B, "b-full");
  // Budget Stage 6: the module's landing page is the dashboard.
  await pb.waitForURL(/\/budget\/dashboard/, { timeout: 20000 }).catch(() => {});
  check("U01 Budget-only worker lands in the Budget module (dashboard)", new URL(pb.url()).pathname === "/budget/dashboard", new URL(pb.url()).pathname);
  // Section labels live in the sidebar <nav>; the footer (outside it) repeats the module title.
  const navB = pb.locator("aside nav");
  check("U02 Budget-only sidebar: 'ניהול תקציב' section, no Election Day section",
    (await navB.getByText("ניהול תקציב", { exact: true }).count()) === 1 && (await navB.getByText("יום הבחירות").count()) === 0);
  await shot(pb, "01-budget-only-expenses");

  const pa = await newPage();
  await workerLogin(pa, CODE_A, "a-full");
  await pa.waitForURL(/\/election-day/, { timeout: 20000 }).catch(() => {});
  const asideA = pa.locator("aside");
  const hasBudgetSection = await asideA.getByText("ניהול תקציב").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  check("U03 Election Day + Budget worker: both sections, Budget below Election Day", hasBudgetSection &&
    (await asideA.getByText("יום הבחירות").count()) >= 1);
  // Module accordion: inside Election Day the Budget section starts collapsed.
  await asideA.getByRole("button", { name: "ניהול תקציב" }).click();
  await asideA.getByRole("link", { name: "הוצאות" }).click();
  await pa.waitForURL(/\/budget\/expenses/, { timeout: 15000 }).catch(() => {});
  check("U04 Budget menu item navigates into the Budget module", new URL(pa.url()).pathname === "/budget/expenses");

  const pn = await newPage();
  await workerLogin(pn, CODE_A, "a-nobudget");
  await pn.waitForURL(/\/election-day/, { timeout: 20000 }).catch(() => {});
  await pn.getByRole("link", { name: "בוחרים" }).first().waitFor({ timeout: 20000 }).catch(() => {});
  check("U05 Election Day worker without budget.view sees no Budget section", (await pn.locator("aside").getByText("ניהול תקציב").count()) === 0);
  await pn.goto(`${EBASE}/budget`);
  check("U06 ... and a direct /budget visit shows the no-permission state", await waitText(pn, "אין לך הרשאה לצפות בדף זה"));

  section("CORE FLOWS (worker with every Budget permission)");
  await pa.goto(`${EBASE}/budget/settings`);
  await pa.getByPlaceholder("קטגוריה חדשה").fill("שילוט UI");
  await pa.getByRole("button", { name: "הוספה" }).first().click();
  check("U07 settings: a category is created", await waitText(pa, "שילוט UI"));

  await pa.goto(`${EBASE}/budget/planning`);
  await pa.getByRole("button", { name: "מקור מימון חדש" }).click();
  const srcDlg = pa.getByRole("dialog");
  await srcDlg.getByLabel("שם המקור").fill("מימון מפלגתי UI");
  await srcDlg.getByLabel("סכום מקורי").fill("50,000");
  await srcDlg.getByRole("button", { name: "שמירה" }).click();
  check("U08 planning: a party funding source is created", await waitText(pa, "מימון מפלגתי UI"));
  check("U09 planning: its amount shows in shekels", await waitText(pa, "50,000"));

  await pa.goto(`${EBASE}/budget/suppliers`);
  await pa.getByTestId("new-supplier").click();
  const supDlg = pa.getByRole("dialog");
  await supDlg.getByLabel("שם העסק").fill("דפוס UI");
  await supDlg.getByLabel("ח.פ / ע.מ").fill("514000111");
  await supDlg.getByRole("button", { name: "שמירה" }).click();
  check("U10 suppliers: a supplier is created", await waitText(pa, "דפוס UI"));
  const card = pa.getByTestId("supplier-list").locator("li").filter({ hasText: "דפוס UI" });
  await card.getByRole("button", { name: "עדכון פרטי בנק" }).click();
  await pa.getByRole("dialog").getByLabel("סיסמה").fill(PW);
  await pa.getByRole("dialog").getByRole("button", { name: "אישור" }).click();
  const bankDlg = pa.getByRole("dialog");
  await bankDlg.getByLabel("מספר חשבון").waitFor({ timeout: 15000 });
  await bankDlg.getByLabel("קוד בנק").fill("12");
  await bankDlg.getByLabel("מספר חשבון").fill("7654321");
  await bankDlg.getByRole("button", { name: "שמירה" }).click();
  check("U11 bank change after step-up; shown masked (last 4 only)",
    await card.getByTestId("supplier-bank").getByText("4321").waitFor({ timeout: 15000 }).then(() => true, () => false) &&
    !(await card.innerText()).includes("7654321"));
  await card.getByRole("button", { name: "הצגת פרטי בנק מלאים" }).click();
  await pa.getByRole("dialog").getByLabel("סיסמה").fill(PW);
  await pa.getByRole("dialog").getByRole("button", { name: "אישור" }).click();
  check("U12 full reveal after a fresh step-up", await card.getByText("7654321").first().waitFor({ timeout: 15000 }).then(() => true, () => false));

  await pa.goto(`${EBASE}/budget/expenses`);
  await pa.getByTestId("new-expense").click();
  const expDlg = pa.getByRole("dialog");
  await expDlg.getByLabel("תיאור").fill("שלטי חוצות UI");
  await expDlg.getByLabel("ספק").selectOption({ label: "דפוס UI" });
  await expDlg.getByLabel("קטגוריה").selectOption({ label: "שילוט UI" });
  await expDlg.getByLabel("סכום כולל מע\"מ (₪)").fill("1,500");
  await expDlg.getByLabel("תאריך הוצאה").fill("2026-09-10");
  await expDlg.getByRole("button", { name: "שמירה" }).click();
  await pa.getByTestId("expense-file").waitFor({ timeout: 20000 });
  check("U13 expense created; the expense file opens (draft)", await waitText(pa, "טיוטה"));
  check("U14 the uncovered balance is explicit until a source is chosen", await waitText(pa, "יתרה לא ממומנת"));
  await pa.getByRole("button", { name: "הוספת מקור מימון" }).click();
  await pa.getByLabel("סכום (₪)").last().fill("1500");
  await pa.getByRole("button", { name: "הוספה" }).click();
  await pa.getByTestId("allocations").locator("li").first().waitFor({ timeout: 15000 });
  check("U15 funding allocated by the user's own choice", (await pa.getByTestId("allocations").locator("li").count()) === 1);
  await pa.getByTestId("expense-transitions").getByRole("button", { name: "סימון כהתחייבות" }).click();
  check("U16 draft -> commitment on the same record", await waitText(pa, "התחייבות"));
  check("U17 party workflow section shows 'awaiting prior approval'", await waitText(pa, "ממתין לאישור תקציבי מוקדם"));
  await shot(pa, "02-expense-file");

  section("OWNER: Budget settings (the same single store)");
  const po = await newPage();
  await po.goto(`${EBASE}/election-day/owner-login`);
  await po.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await po.locator('input[type="email"]').fill(ownerEmail);
  await po.locator('input[autocomplete="current-password"]').fill(PW);
  await po.getByRole("button", { name: "התחברות" }).click();
  // Owner sidebar accordion: the Budget module section starts collapsed.
  // The Owner-only Budget settings section lives in the ADMINISTRATION
  // group of the full application shell now - the "ניהול תקציב" group holds
  // the Budget module own screens.
  await po.getByRole("button", { name: "ניהול המערכת" }).first().waitFor({ timeout: 25000 });
  await po.getByRole("button", { name: "ניהול המערכת" }).first().click();
  await po.getByRole("link", { name: "הגדרות תקציב" }).first().click();
  check("U18 Owner sees the category a delegated user created", await waitText(po, "שילוט UI", 20000));
  await shot(po, "03-owner-budget-settings");

  section("MOBILE 390");
  const pm = await newPage({ width: 390, height: 844 });
  await workerLogin(pm, CODE_B, "b-full");
  await pm.waitForURL(/\/budget\/expenses/, { timeout: 20000 }).catch(() => {});
  let overflowFree = true;
  for (const route of ["expenses", "planning", "suppliers", "settings"]) {
    await pm.goto(`${EBASE}/budget/${route}`);
    await pm.waitForTimeout(1500);
    overflowFree = overflowFree && (await noOverflow(pm));
    await shot(pm, `04-mobile-${route}`);
  }
  check("U19 no horizontal overflow at 390 on all Budget pages", overflowFree);
  const bottomNav = pm.locator("nav.fixed");
  check("U20 mobile bottom nav carries the Budget items", (await bottomNav.getByRole("link", { name: "הוצאות" }).count()) === 1 &&
    (await bottomNav.getByRole("link", { name: "ספקים" }).count()) === 1);

  check("U21 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  server.close();
  psql(`update public.platform_modules set available = false where key = 'budget';`);
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
process.exit(tally("BUDGET UI") ? 1 : 0);
