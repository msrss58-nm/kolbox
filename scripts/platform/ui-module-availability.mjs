// Budget Stage 7B Gate 4 - REAL-LOCAL UI suite: the Platform Owner's GLOBAL
// module availability switch in the Platform console, end to end into the
// Election surface.
//
// Builds the `platform` AND `election` surfaces against the isolated kolboxs5
// scratch stack, serves each with scripts/stage5/localServer.mjs (vercel.json
// rewrites -> the REAL bundled handlers) and drives headless Chromium: a real
// password + TOTP Platform Owner switches Budget on and off; an entitled
// workspace's worker sees "ניהול תקציב" appear and disappear, a non-entitled
// one never sees it. Synthetic identities only; nothing secret is printed.
//
// Run:  S5_STACK_DIR=<scratch stack> [S5_PORT_OFFSET=1000] node scripts/platform/ui-module-availability.mjs <outDir>
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { startLocalServer } from "../stage5/localServer.mjs";
import {
  admin,
  check,
  enrollTotp,
  installLocalnetGuard,
  loadStack,
  psql,
  randomPassword,
  section,
  signIn,
  sleep,
  tally,
} from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-g4-availability-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const P_PORT = 5203;
const E_PORT = 5204;
const PBASE = `http://127.0.0.1:${P_PORT}`;
const EBASE = `http://127.0.0.1:${E_PORT}`;
process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = EBASE;
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
const H = await buildHandlers();
const a = admin();
const DOMAIN = "g4-availability-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;
// Per-run prefix: a workspace that opened Budget holds its lazy defaults and is
// never deleted (the Stage 7A delete guard would refuse it), so reruns add new
// fixtures instead of cleaning old ones.
const PFX = `G4UI-${crypto.randomBytes(3).toString("hex")}`;
const PW = "G4-Ui-Availability-9!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const BUDGET_ROUTES = ["/budget/dashboard", "/budget/planning", "/budget/expenses", "/budget/suppliers", "/budget/reports", "/budget/settings"];

function build(surface, distDir) {
  execFileSync(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", distDir,
    "--emptyOutDir", "--logLevel", "error"], {
    cwd: repoRoot,
    env: { ...process.env, VITE_APP_SURFACE: surface, VITE_SUPABASE_URL: stackEnv.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

section("BUILD platform + election surfaces against the scratch stack");
const pDist = path.join(outDir, "dist-platform");
const eDist = path.join(outDir, "dist-election");
build("platform", pDist);
build("election", eDist);
check("B1 both bundles built", fs.existsSync(path.join(pDist, "index.html")) && fs.existsSync(path.join(eDist, "index.html")));

section("SETUP (scratch stack only)");
psql(`
  delete from public.election_workspaces where name like '${PFX} %';
  delete from public.platform_owners;
  delete from public.election_day_login_attempts;
  update public.platform_modules set available = false where key = 'budget';
`);
{
  for (let p = 1; p < 20; p++) {
    const { data } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    for (const u of data.users) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
    if (data.users.length < 200) break;
  }
}
const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'G4 UI PO', '${email("po")}');`);
const poApi = await enrollTotp((await signIn(email("po"), poPw)).client, "g4-ui-po");
const CODE_T = mkCode();
const CODE_C = mkCode();
const ws = (label, c) => psql(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() + interval '30 days', '${c}') returning id;`);
const WT = ws("יעד", CODE_T);
const WC = ws("ביקורת", CODE_C);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values
  ('${WT}', 'election_day'), ('${WT}', 'budget'), ('${WC}', 'election_day');`);
const PERMS = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings", "voter.viewName", "voter.viewAddress", "voter.viewPhone", "voter.viewVotedStatus"];
for (const [w, n] of [[WT, "t-full"], [WC, "c-full"]]) {
  const r = psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
    values ('${n}', '', ${arr(PERMS)}, 'all', '${w}', true) returning id;`);
  psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
    values ('${n}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}');`);
}
const moduleRows = () =>
  psql(`select coalesce(string_agg(workspace_id || ':' || module_key, ',' order by workspace_id, module_key), '') from public.election_workspace_modules;`);
const auditRows = () => Number(psql(`select count(*) from public.platform_module_availability_audit;`));
const lastAudit = () => psql(`select previous_available || '>' || new_available || '|' || acting_platform_owner_auth_user_id
  from public.platform_module_availability_audit order by performed_at desc, id desc limit 1;`);
const avail = () => psql(`select available from public.platform_modules where key = 'budget';`);
const rows0 = moduleRows();
const audit0 = auditRows();
check("S1 fixtures: Platform Owner (TOTP), target (election day + budget) and control (election day only), budget unavailable",
  Boolean(poApi.secret && WT && WC) && avail() === "f");

const common = { "/api/platform/session": H.platformSession, "/api/health": H.health };
const pServer = await startLocalServer({ distDir: pDist, port: P_PORT, handlers: common });
const eServer = await startLocalServer({
  distDir: eDist,
  port: E_PORT,
  handlers: {
    ...common,
    "/api/election-day/session": H.electionSession, "/api/election-day/actions": H.actions, "/api/election-day/roles": H.roles,
    "/api/election-day/reauth": H.reauth, "/api/election-day/permission-users": H.permissionUsers,
    "/api/election-day/owner-actions": H.ownerActions, "/api/election-day/owner-roles": H.ownerRoles,
    "/api/election-day/owner-reauth": H.ownerReauth, "/api/budget/actions": H.budget,
  },
});

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1280, height: 860 }) => {
  const ctx = await browser.newContext({ viewport, locale: "he-IL" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const seen = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true, () => false);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function platformLogin(p) {
  await p.goto(`${PBASE}/platform/login`);
  await p.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 15000 });
  await p.locator('input[type="email"]').fill(email("po"));
  await p.locator('input[autocomplete="current-password"]').fill(poPw);
  await p.getByRole("button", { name: "התחברות" }).click();
  // Mandatory Platform Owner MFA was removed from the active login flow
  // (PLATFORM_OWNER_MFA_REQUIRED = false), so password alone reaches the
  // console. The account still HOLDS a verified TOTP factor - it is simply
  // never demanded.
  return await seen(p.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }), 20000);
}
async function workerLogin(p, codeValue, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${EBASE}/election-day/login?w=${codeValue}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }).catch(() => {});
  await p.locator("aside nav").first().waitFor({ timeout: 20000 });
}
/** The worker shell's Budget section, read ATOMICALLY.
 *
 * The label and the links used to be two sequential awaits. The shell renders
 * the section asynchronously (the entitlement resolves after the first paint),
 * so the two reads could straddle that render and report a state that never
 * existed - E1 really did observe "0 labels, 6 links". Both values now come
 * from ONE synchronous DOM read, and the poll below only decides WHEN to take
 * that read: it samples until two consecutive samples agree, so an absent
 * section (E3 / K3) settles just as well as a present one. */
async function budgetNav(p) {
  return await p.evaluate(async (target) => {
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    // One instant, both values - never interleaved with a render.
    const read = () => {
      const navs = Array.from(document.querySelectorAll("aside nav"));
      const labels = navs.flatMap((nav) =>
        Array.from(nav.querySelectorAll("*")).filter(
          (el) =>
            norm(el.textContent) === target &&
            // deepest match only, mirroring getByText's element choice
            !Array.from(el.children).some((c) => norm(c.textContent) === target),
        ),
      );
      return {
        section: labels.length,
        hrefs: Array.from(document.querySelectorAll("aside a[href^='/budget/']")).map((a) => a.getAttribute("href")),
      };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // The entitlement resolves asynchronously AFTER the first paint, so an
    // empty nav is "stable" before it has resolved at all. Keep the original
    // 2500ms settling floor and additionally require two consecutive equal
    // samples; the fix for the race is that the accepted result is ONE read.
    const FLOOR_MS = 2500;
    const started = Date.now();
    let key = JSON.stringify(read());
    for (let i = 0; i < 40; i++) {
      await wait(250);
      const cur = read();
      const curKey = JSON.stringify(cur);
      if (curKey === key && Date.now() - started >= FLOOR_MS) return cur; // one atomic read
      key = curKey;
    }
    return read();
  }, "ניהול תקציב");
}
const row = (p, key) => p.getByTestId(`module-availability-${key}`);
async function switchBudget(p, label) {
  await p.getByTestId("module-availability-toggle-budget").click();
  const confirm = p.getByRole("dialog").last();
  await confirm.getByRole("button", { name: label }).click();
}

try {
  // -------------------------------------------------------------------------
  section("PLATFORM CONSOLE: the global switch is its own control");
  const pp = await newPage();
  check("P1 Platform Owner password + TOTP -> console", await platformLogin(pp));
  // The separate module-assignment screen was retired (2026-09-24); the GLOBAL
  // availability switch - this suite's subject - moved to Settings.
  await pp.goto(`${PBASE}/platform/settings`);
  await pp.getByTestId("platform-settings-section").waitFor({ timeout: 15000 });
  const openBtn = pp.getByTestId("module-availability-open").first();
  check("P2 Settings offers 'זמינות מודולים' as its own action", await seen(openBtn) && (await openBtn.innerText()).includes("זמינות מודולים"));
  await openBtn.click();
  const dlg = pp.getByRole("dialog").last();
  check("P3 the dialog explains global vs per-workspace (title + 'אינו מוסיף ואינו מסיר הקצאות')",
    await seen(dlg.getByText("זמינות מודולים בכל הפלטפורמה")) && (await dlg.innerText()).includes("אינו מוסיף ואינו מסיר הקצאות"));
  check("P4 Budget shows 'לא זמין' with 'הפיכה לזמין'",
    (await row(pp, "budget").getAttribute("data-available")) === "false" &&
      (await row(pp, "budget").getByTestId("module-availability-state").innerText()) === "לא זמין" &&
      (await pp.getByTestId("module-availability-toggle-budget").innerText()).includes("הפיכה לזמין"));
  check("P5 only Budget is switchable: election_day / voter_management show a fixed state, no toggle; no entitlement checkboxes here",
    (await dlg.locator('[data-testid^="module-availability-toggle-"]').count()) === 1 &&
      (await row(pp, "election_day").getByText("זמינות קבועה").count()) === 1 &&
      (await row(pp, "voter_management").getByText("זמינות קבועה").count()) === 1 &&
      (await dlg.locator('input[type="checkbox"]').count()) === 0);
  check("P6 Budget shows its entitlement count", (await row(pp, "budget").innerText()).includes("הוקצה"));
  await shot(pp, "01-availability-dialog-off-1280");

  await pp.getByTestId("module-availability-toggle-budget").click();
  const confirmOn = pp.getByRole("dialog").last();
  check("P7 enabling asks for confirmation: 'להפוך את \"ניהול תקציב\" לזמין?' + no other workspace gains access",
    await seen(confirmOn.getByText('להפוך את "ניהול תקציב" לזמין?')) && (await confirmOn.innerText()).includes("אף מערכת אחרת לא תקבל גישה"));
  await confirmOn.getByRole("button", { name: "הפיכה לזמין" }).click();
  check("P8 after confirming: Budget 'זמין', a success note, the toggle now offers 'הפיכה ללא זמין'",
    await seen(row(pp, "budget").and(pp.locator('[data-available="true"]'))) &&
      (await row(pp, "budget").getByTestId("module-availability-state").innerText()) === "זמין" &&
      (await row(pp, "budget").getByText("הזמינות עודכנה").count()) === 1 &&
      (await pp.getByTestId("module-availability-toggle-budget").innerText()).includes("הפיכה ללא זמין"));
  check("P9 server state: available=true, ONE audit row false>true by the Platform Owner, entitlements unchanged",
    avail() === "t" && auditRows() === audit0 + 1 && lastAudit() === `false>true|${poUser.user.id}` && moduleRows() === rows0);
  await shot(pp, "02-availability-dialog-on-1280");
  await pp.getByRole("button", { name: "סגירה" }).first().click();

  // -------------------------------------------------------------------------
  section("ELECTION SURFACE: effective only where entitled");
  const pt = await newPage();
  await workerLogin(pt, CODE_T, "t-full");
  const navT = await budgetNav(pt);
  check("E1 target worker: 'ניהול תקציב' section with exactly the approved six items",
    navT.section === 1 && JSON.stringify(navT.hrefs) === JSON.stringify(BUDGET_ROUTES), `${navT.section} ${navT.hrefs.join(" ")}`);
  await pt.goto(`${EBASE}/budget/dashboard`);
  check("E2 target worker: the Budget dashboard opens", await seen(pt.getByTestId("dashboard-kpis"), 20000));
  await shot(pt, "03-target-budget-on");
  const pc = await newPage();
  await workerLogin(pc, CODE_C, "c-full");
  const navC = await budgetNav(pc);
  check("E3 control worker (not entitled): no Budget section", navC.section === 0 && navC.hrefs.length === 0, `${navC.section}`);
  await pc.goto(`${EBASE}/budget/dashboard`);
  await sleep(2500);
  check("E4 control worker: the direct Budget route gives no Budget page", (await pc.getByTestId("dashboard-kpis").count()) === 0);
  await shot(pc, "04-control-no-budget");

  // -------------------------------------------------------------------------
  section("PLATFORM CONSOLE: switch off (kill switch)");
  await pp.getByTestId("module-availability-open").first().click();
  await pp.getByTestId("module-availability-toggle-budget").waitFor({ timeout: 10000 });
  await pp.getByTestId("module-availability-toggle-budget").click();
  const confirmOff = pp.getByRole("dialog").last();
  check("K1 disabling warns that entitled workspaces are blocked and entitlements are kept",
    await seen(confirmOff.getByText('להפוך את "ניהול תקציב" ללא זמין?')) && (await confirmOff.innerText()).includes("ההקצאות והנתונים נשמרים"));
  await confirmOff.getByRole("button", { name: "הפיכה ללא זמין" }).click();
  check("K2 Budget back to 'לא זמין'; available=false; one more audit row true>false; entitlements unchanged",
    await seen(row(pp, "budget").and(pp.locator('[data-available="false"]'))) && avail() === "f" &&
      auditRows() === audit0 + 2 && lastAudit() === `true>false|${poUser.user.id}` && moduleRows() === rows0);
  await pt.goto(`${EBASE}/election-day`);
  await pt.locator("aside nav").first().waitFor({ timeout: 20000 });
  const navOff = await budgetNav(pt);
  check("K3 target worker after the kill switch: the Budget section is gone (same session)", navOff.section === 0 && navOff.hrefs.length === 0);
  await pp.getByRole("button", { name: "סגירה" }).first().click();

  // -------------------------------------------------------------------------
  section("RESPONSIVE (390px)");
  const pm = await newPage({ width: 390, height: 844 });
  check("R0 Platform Owner signs in at 390px", await platformLogin(pm));
  await pm.goto(`${PBASE}/platform/settings`);
  await pm.getByTestId("platform-settings-section").waitFor({ timeout: 15000 });
  const mOpen = pm.getByTestId("module-availability-open").last();
  check("R1 390px: the action is reachable in Settings", await seen(mOpen) && (await mOpen.isVisible()));
  await mOpen.click();
  await pm.getByTestId("module-availability-toggle-budget").waitFor({ timeout: 10000 });
  const tb = await pm.getByTestId("module-availability-toggle-budget").boundingBox();
  check("R2 390px: dialog fits, toggle >= 44px tall, no horizontal overflow", (tb?.height ?? 0) >= 44 && (await noOverflow(pm)), `${tb?.height}`);
  await shot(pm, "05-availability-dialog-390");

  check("Z1 no page errors on any surface", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check("Z2 budget left unavailable on the scratch stack", avail() === "f");
} finally {
  await browser.close();
  await pServer.close();
  await eServer.close();
}

tally("MODULE AVAILABILITY UI");
