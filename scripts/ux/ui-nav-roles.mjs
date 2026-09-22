// Post-Stage 7B UX - REAL-LOCAL UI suite for the sidebar module accordion and
// the grouped role-permission editor.
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack,
// serves it with scripts/stage5/localServer.mjs (real bundled handlers) and
// drives headless Chromium through real PermissionUser and Election Owner
// sign-ins. Synthetic *.invalid identities only; nothing secret is printed.
//
// Run:  S5_STACK_DIR=<scratch>/stack [S5_PORT_OFFSET=1000] node scripts/ux/ui-nav-roles.mjs <outDir>
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-ux-nav-roles"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const E_PORT = 5197;
const EBASE = `http://127.0.0.1:${E_PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
// The Owner's module groups now come from each module's OWN probe (the same
// one a worker uses), so the Budget endpoint has to accept this origin - the
// Owner Budget group is no longer read from entitlement rows alone.
process.env.BUDGET_ALLOWED_ORIGIN = EBASE;
process.env.OWNER_ALLOWED_ORIGIN = EBASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `UXNR-${RUN}`;
const DOMAIN = `ux-nav-${RUN}.invalid`;
const PW = "Ux-Nav-Pw-7!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const ALL_BUDGET = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const ED_VIEW = ["voter.viewName", "voter.viewAddress", "voter.viewPhone", "voter.viewVotedStatus"];
const ED = (r) => `/election-day/${r}`;
const BUDGET_HREFS = ["dashboard", "planning", "expenses", "suppliers", "reports", "settings"].map((r) => `/budget/${r}`);
const MAIN_HREFS = ["/", "/voters", "/activists", "/import"];
const S_MAIN = "ניהול בוחרים";
const S_ED = "יום הבחירות";
const S_BUDGET = "ניהול תקציב";

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
const WA = psql(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} A', now() + interval '5 days', '${CODE_A}') returning id;`);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}','election_day'), ('${WA}','budget');`);
const role = (name, perms, isManager = false) => psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', 'תיאור ${name}', ${arr(perms)}, 'all', '${WA}', ${isManager}) returning id;`);
const user = (name, r) => psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${WA}') returning id;`);
user("ux-full", role("UX עובד מלא", [...ALL_BUDGET, ...ED_VIEW]));
const MGR_ED = [...ED_VIEW, "electionDay.import", "electionDay.export", "electionDay.manageRideCoordinators", "electionDay.manageNonVotingReasons"];
user("ux-mgr-ed", role("UX מנהל יום בחירות", MGR_ED, true));
// Role-editor fixtures (unassigned). R_BUD also carries the hidden, non-grantable permission.
const R_BUD_PERMS = [...ALL_BUDGET, ...ED_VIEW, "electionDay.import", "electionDay.manageUsers"];
const R_BUD = role("UX עם תקציב", R_BUD_PERMS);
const R_NOB_PERMS = [...ED_VIEW, "electionDay.import"];
const R_NOB = role("UX ללא תקציב", R_NOB_PERMS);
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner UX', '${ownerEmail}');`);
check("S1 fixtures created", Boolean(WA && R_BUD && R_NOB));

const roleRow = (id) => psql(`select array_to_string(array(select unnest(permissions) order by 1), ',') || '|' || name || '|' ||
  description || '|' || scope_type || '|' || is_manager from public.election_day_roles where id = '${id}';`);
const sorted = (xs) => [...xs].sort().join(",");

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
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`) });
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const path0 = (p) => new URL(p.url()).pathname;
async function workerLogin(p, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${EBASE}/election-day/login?w=${CODE_A}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
}

// Accordion helpers: one module group in the desktop sidebar.
const sec = (p, label) => p.locator(`aside [data-nav-section="${label}"]`);
const hdr = (p, label) => sec(p, label).locator(":scope > button");
const expanded = async (p, label) => (await hdr(p, label).getAttribute("aria-expanded")) === "true";
const visibleHrefs = (p, label) => sec(p, label).locator("a:visible").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const domHrefs = (p, label) => sec(p, label).locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
const sectionLabels = (p) => p.locator("aside [data-nav-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-section")));
const chevronOpen = async (p, label) => ((await hdr(p, label).locator("svg").getAttribute("class")) ?? "").includes("rotate-180");
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

try {
  section("ACCORDION - Election Day + Budget worker, desktop 1280");
  const pa = await newPage();
  await workerLogin(pa, "ux-full");
  await pa.waitForURL(/\/election-day\/dashboard/, { timeout: 20000 }).catch(() => {});
  await sec(pa, S_BUDGET).waitFor({ timeout: 20000 });
  check("N01 three module headers in order: ניהול בוחרים, יום הבחירות, ניהול תקציב",
    same(await sectionLabels(pa), [S_MAIN, S_ED, S_BUDGET]), (await sectionLabels(pa)).join(" | "));
  check("N02 each header is a button with aria-expanded + aria-controls pointing at its own links",
    await pa.evaluate(() => [...document.querySelectorAll("aside [data-nav-section]")].every((s) => {
      const b = s.querySelector(":scope > button");
      const panel = b && document.getElementById(b.getAttribute("aria-controls") ?? "");
      return b && b.hasAttribute("aria-expanded") && panel && s.contains(panel) && panel.querySelectorAll("a").length > 0;
    })));
  check("N03 the active module (Election Day) is expanded; the others are collapsed",
    await expanded(pa, S_ED) && !(await expanded(pa, S_MAIN)) && !(await expanded(pa, S_BUDGET)) &&
    (await sec(pa, S_ED).getAttribute("data-active")) === "true");
  check("N04 the active page link is visible and marked current",
    (await pa.locator('aside a[aria-current="page"]:visible').getAttribute("href")) === ED("dashboard"));
  check("N05 Election Day links = exactly the permission-filtered set (dashboard, voters, reasons)",
    same(await visibleHrefs(pa, S_ED), [ED("dashboard"), ED("voters"), ED("reasons")]), (await visibleHrefs(pa, S_ED)).join(" "));
  check("N06 collapsed Budget: no visible links, but the same six items as before are present (nothing added/removed)",
    (await visibleHrefs(pa, S_BUDGET)).length === 0 && same(await domHrefs(pa, S_BUDGET), BUDGET_HREFS));
  check("N07 collapsed 'ניהול בוחרים' holds the unchanged main-app items", same(await domHrefs(pa, S_MAIN), MAIN_HREFS));
  check("N08 chevron state follows expansion", (await chevronOpen(pa, S_ED)) && !(await chevronOpen(pa, S_BUDGET)));
  const box = await hdr(pa, S_BUDGET).boundingBox();
  check("N09 module header is a >=44px touch target", Boolean(box && box.height >= 44), String(box?.height));
  await shot(pa, "01-ed-shell-default");

  await hdr(pa, S_BUDGET).click();
  check("N10 click once -> Budget expands, its six links visible, chevron open",
    await expanded(pa, S_BUDGET) && same(await visibleHrefs(pa, S_BUDGET), BUDGET_HREFS) && await chevronOpen(pa, S_BUDGET));
  await hdr(pa, S_BUDGET).click();
  check("N11 click again -> Budget collapses", !(await expanded(pa, S_BUDGET)) && (await visibleHrefs(pa, S_BUDGET)).length === 0);

  await hdr(pa, S_BUDGET).focus();
  await pa.keyboard.press("Enter");
  const byEnter = await expanded(pa, S_BUDGET);
  await pa.keyboard.press("Space");
  const bySpace = !(await expanded(pa, S_BUDGET));
  check("N12 keyboard: Enter expands, Space collapses (focused header)", byEnter && bySpace);

  await hdr(pa, S_ED).click();
  check("N13 collapsing the ACTIVE module keeps the page and marks the header active",
    !(await expanded(pa, S_ED)) && path0(pa) === ED("dashboard") &&
    (await sec(pa, S_ED).locator("[data-active-marker]").count()) === 1);
  await shot(pa, "02-ed-shell-active-collapsed");
  await hdr(pa, S_ED).click();
  check("N14 re-expanding the active module restores its links", same(await visibleHrefs(pa, S_ED), [ED("dashboard"), ED("voters"), ED("reasons")]));

  await hdr(pa, S_BUDGET).click();
  await sec(pa, S_BUDGET).getByRole("link", { name: "הוצאות" }).click();
  await pa.waitForURL(/\/budget\/expenses/, { timeout: 20000 }).catch(() => {});
  await sec(pa, S_BUDGET).waitFor({ timeout: 20000 });
  check("N15 a Budget link navigates; inside Budget the Budget module is expanded and active, Election Day collapsed",
    path0(pa) === "/budget/expenses" && await expanded(pa, S_BUDGET) && !(await expanded(pa, S_ED)) &&
    (await sec(pa, S_BUDGET).getAttribute("data-active")) === "true");
  await shot(pa, "03-budget-shell");

  await pa.goto(`${EBASE}/budget/suppliers`);
  await sec(pa, S_BUDGET).waitFor({ timeout: 20000 });
  const deepB = await expanded(pa, S_BUDGET) && !(await expanded(pa, S_ED));
  await pa.reload();
  await sec(pa, S_BUDGET).waitFor({ timeout: 20000 });
  check("N16 deep link + refresh on /budget/suppliers keep Budget expanded (Election Day collapsed)",
    deepB && await expanded(pa, S_BUDGET) && !(await expanded(pa, S_ED)) &&
    (await pa.locator('aside a[aria-current="page"]:visible').getAttribute("href")) === "/budget/suppliers");
  await pa.goto(`${EBASE}${ED("voters")}`);
  await sec(pa, S_ED).waitFor({ timeout: 20000 });
  await pa.reload();
  await sec(pa, S_BUDGET).waitFor({ timeout: 20000 });
  check("N17 deep link + refresh on /election-day/voters keep Election Day expanded (Budget collapsed)",
    await expanded(pa, S_ED) && !(await expanded(pa, S_BUDGET)) && path0(pa) === ED("voters"));
  check("N18 RTL document, no horizontal overflow",
    await pa.evaluate(() => document.documentElement.dir === "rtl") && await noOverflow(pa));

  section("ACCORDION - Manager role with only Election Day permissions");
  const pm = await newPage();
  await workerLogin(pm, "ux-mgr-ed");
  await pm.waitForURL(/\/election-day\/dashboard/, { timeout: 20000 }).catch(() => {});
  await sec(pm, S_ED).waitFor({ timeout: 20000 });
  await pm.waitForTimeout(1500); // the Budget status probe settles
  check("N19 no Budget module header at all (not entitled by role); headers = ניהול בוחרים, יום הבחירות",
    same(await sectionLabels(pm), [S_MAIN, S_ED]) && (await pm.locator("aside a[href^='/budget']").count()) === 0);
  check("N20 Election Day expanded with every permitted item (all six)",
    await expanded(pm, S_ED) && same(await visibleHrefs(pm, S_ED), ["dashboard", "voters", "files", "rides", "reasons", "reports"].map(ED)));
  await shot(pm, "04-manager-ed-only");

  section("MOBILE 390 - bottom nav unchanged, no accordion");
  const pmob = await newPage({ width: 390, height: 844 });
  await workerLogin(pmob, "ux-full");
  await pmob.waitForURL(/\/election-day\/dashboard/, { timeout: 20000 }).catch(() => {});
  const bottom = pmob.locator("nav.fixed");
  await bottom.getByRole("link").first().waitFor({ timeout: 20000 });
  const bottomHrefs = await bottom.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const switchLink = await pmob.getByRole("link", { name: "מעבר לניהול תקציב" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  check("M01 390: sidebar hidden, no visible accordion header, bottom nav = the current module's items, module switch link shown",
    !(await pmob.locator("aside").isVisible()) && (await pmob.locator("[data-nav-section] > button:visible").count()) === 0 &&
    same(bottomHrefs, [ED("dashboard"), ED("voters"), ED("reasons")]) && switchLink, bottomHrefs.join(" "));
  check("M02 390: no horizontal overflow (Election Day)", await noOverflow(pmob));
  await shot(pmob, "05-mobile-ed");
  await pmob.getByRole("link", { name: "מעבר לניהול תקציב" }).click();
  await pmob.waitForURL(/\/budget/, { timeout: 20000 }).catch(() => {});
  await bottom.getByRole("link", { name: "ספקים" }).waitFor({ timeout: 20000 });
  check("M03 390: in Budget the bottom nav carries the Budget items; no overflow",
    same(await bottom.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href"))), BUDGET_HREFS) && await noOverflow(pmob));
  await shot(pmob, "06-mobile-budget");

  section("OWNER - admin shell unchanged; grouped role editor");
  const po = await newPage();
  await po.goto(`${EBASE}/election-day/owner-login`);
  await po.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await po.locator('input[type="email"]').fill(ownerEmail);
  await po.locator('input[autocomplete="current-password"]').fill(PW);
  await po.getByRole("button", { name: "התחברות" }).click();
  // The Owner administers from the ONE full application shell - the separate
  // Owner admin shell is gone as a landing destination. Its sidebar is the
  // application sidebar: the main-app group, each ENTITLED module, and one
  // administration group carrying the Owner-only sections.
  const VM_SEC = "ניהול בוחרים";
  const ED_SEC = "יום הבחירות";
  const B_SEC = "ניהול תקציב";
  const O_SEC = "ניהול המערכת";
  const OWNER_ADMIN_HREFS = ["users", "roles", "modules", "settings"].map((r) => `/election-day/owner/${r}`);
  const BUDGET_HREF = "/election-day/owner/budget-settings";
  const OWNER_HREFS_WITH_BUDGET = [...OWNER_ADMIN_HREFS, BUDGET_HREF];
  const ED_DASH_HREF = "/election-day/dashboard";
  const BUDGET_DASH_HREF = "/budget/dashboard";
  const oSec = (p, label) => p.locator(`aside [data-nav-section="${label}"]`);
  const oHdr = (p, label) => oSec(p, label).locator(":scope > button");
  const oOpen = async (p, label) => (await oHdr(p, label).getAttribute("aria-expanded")) === "true";
  const oVisible = (p, label) => oSec(p, label).locator("a:visible").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  const oLabels = (p) => p.locator("aside [data-nav-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-section")));
  const oActiveHref = (p) => p.locator('aside a[aria-current="page"]:visible').getAttribute("href");

  await oSec(po, B_SEC).waitFor({ timeout: 25000 });
  check("A01 Owner sidebar = the application groups, every ENTITLED module, and ONE administration group",
    same(await oLabels(po), [VM_SEC, ED_SEC, B_SEC, O_SEC]), (await oLabels(po)).join(" | "));
  const domHrefsOf = (label) =>
    oSec(po, label).locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  check("A02 administration holds the Owner-only sections; each module group holds that module own screens",
    same(await domHrefsOf(O_SEC), OWNER_HREFS_WITH_BUDGET) &&
      (await domHrefsOf(ED_SEC)).includes(ED_DASH_HREF) &&
      (await domHrefsOf(B_SEC)).includes(BUDGET_DASH_HREF),
    `admin=${(await domHrefsOf(O_SEC)).join(",")}`);
  // The Owner LANDS on the module dashboard now, so the administration
  // sections are navigated to (one sidebar click in the app).
  await po.goto(`${EBASE}/election-day/owner/users`);
  await oSec(po, B_SEC).waitFor({ timeout: 25000 });
  check("A03 on /owner/users the administration group is expanded and active; module groups collapsed",
    await oOpen(po, O_SEC) && (await oSec(po, O_SEC).getAttribute("data-active")) === "true" &&
    !(await oOpen(po, B_SEC)) && (await oVisible(po, B_SEC)).length === 0 &&
    (await oActiveHref(po)) === OWNER_ADMIN_HREFS[0],
    `open=${await oOpen(po, O_SEC)} active=${await oSec(po, O_SEC).getAttribute("data-active")} bOpen=${await oOpen(po, B_SEC)} bVis=${(await oVisible(po, B_SEC)).length} href=${await oActiveHref(po)}`);
  check("A04 every Owner group header is a >=44px button with aria-expanded + aria-controls over its own links",
    await po.evaluate(() => [...document.querySelectorAll("aside [data-nav-section]")].every((s) => {
      const b = s.querySelector(":scope > button");
      const panel = b && document.getElementById(b.getAttribute("aria-controls") ?? "");
      return b && b.hasAttribute("aria-expanded") && b.getBoundingClientRect().height >= 44 &&
        panel && s.contains(panel) && panel.querySelectorAll("a").length > 0;
    })));
  await shot(po, "09-owner-admin-default");
  await oHdr(po, B_SEC).click();
  check("A05 click expands the Budget module group (its screens appear); click again collapses it",
    await oOpen(po, B_SEC) && (await oVisible(po, B_SEC)).includes(BUDGET_DASH_HREF));
  await shot(po, "10-owner-admin-budget-expanded");
  await oHdr(po, B_SEC).click();
  const collapsedAgain = !(await oOpen(po, B_SEC));
  await oHdr(po, B_SEC).focus();
  await po.keyboard.press("Enter");
  const oByEnter = await oOpen(po, B_SEC);
  await po.keyboard.press("Space");
  check("A06 keyboard: Enter expands, Space collapses the Budget module group", collapsedAgain && oByEnter && !(await oOpen(po, B_SEC)));

  await po.goto(`${EBASE}${BUDGET_HREF}`);
  await oSec(po, B_SEC).waitFor({ timeout: 25000 });
  await po.locator(`aside a[href='${BUDGET_HREF}']`).first().waitFor({ state: "attached", timeout: 25000 });
  const deepOwner = (await oOpen(po, O_SEC)) && (await oActiveHref(po)) === BUDGET_HREF;
  await po.reload();
  await oSec(po, O_SEC).waitFor({ timeout: 20000 });
  // Budget settings joins the administration group only once the module probe
  // resolves - wait for it, or the group is read before it owns this route.
  await po.locator(`aside a[href='${BUDGET_HREF}']`).first().waitFor({ state: "attached", timeout: 25000 });
  // After a refresh the group is ACTIVE and its item is the current page; its
  // expanded state can lag, because the Budget settings link only joins the
  // administration group once the asynchronous module probe resolves. A08
  // asserts the active-collapsed marker that covers exactly that state.
  check("A07 deep link + refresh on Budget settings mark the ADMINISTRATION group active on that item",
    deepOwner && (await oSec(po, O_SEC).getAttribute("data-active")) === "true" &&
      (await oActiveHref(po)) === BUDGET_HREF,
    `deep=${deepOwner} open=${await oOpen(po, O_SEC)} href=${await oActiveHref(po)}`);
  await oHdr(po, O_SEC).click();
  check("A08 collapsing the active administration group keeps the page and marks the header active",
    !(await oOpen(po, O_SEC)) && path0(po) === BUDGET_HREF &&
    (await oSec(po, O_SEC).locator("[data-active-marker]").count()) === 1,
    `open=${await oOpen(po, O_SEC)} path=${path0(po)} markers=${await oSec(po, O_SEC).locator("[data-active-marker]").count()}`);
  check("A09 Owner shell is RTL with no horizontal overflow",
    await po.evaluate(() => document.documentElement.dir === "rtl") && await noOverflow(po));

  // Entitlement-driven visibility (the same rows the header badges read).
  psql(`delete from public.election_workspace_modules where workspace_id = '${WA}' and module_key = 'budget';`);
  await po.goto(`${EBASE}/election-day/owner/users`);
  await oSec(po, O_SEC).waitFor({ timeout: 20000 });
  await po.waitForTimeout(1000);
  check("A10 without the Budget entitlement the Budget group AND its Owner settings link disappear",
    same(await oLabels(po), [VM_SEC, ED_SEC, O_SEC]) &&
      (await po.locator(`aside a[href='${BUDGET_HREF}']`).count()) === 0,
    (await oLabels(po)).join(" | "));
  await shot(po, "11-owner-admin-no-budget");
  psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}', 'budget');`);
  await po.goto(`${EBASE}/election-day/owner/users`);
  await oSec(po, B_SEC).waitFor({ timeout: 20000 });
  check("A11 restoring the entitlement brings the Budget group back",
    same(await oLabels(po), [VM_SEC, ED_SEC, B_SEC, O_SEC]), (await oLabels(po)).join(" | "));

  // The links must actually OPEN the module's own existing surface for the
  // Owner - the same shells a worker gets, driven by owner-actions. A guard
  // that bounced the Owner to the worker login, or a data layer still calling
  // the worker endpoint, would fail here rather than in front of the Owner.
  await oHdr(po, ED_SEC).click();
  await oSec(po, ED_SEC).locator(`a[href='${ED_DASH_HREF}']`).first().click();
  await po.waitForURL((u) => u.pathname === ED_DASH_HREF, { timeout: 25000 });
  const edBody = await po.locator("body").innerText();
  check("A11b the Owner OPENS the real Election Day dashboard (not a login, not unavailable)",
    !edBody.includes("מודול יום הבחירות אינו פעיל") && !po.url().includes("/owner"),
    po.url());
  await shot(po, "11b-owner-in-election-day");

  await po.goto(`${EBASE}/election-day/owner/users`);
  await oSec(po, B_SEC).waitFor({ timeout: 20000 });
  await oHdr(po, B_SEC).click();
  await oSec(po, B_SEC).locator(`a[href='${BUDGET_DASH_HREF}']`).first().click();
  const budgetShell = await po
    .locator('a[href="/budget/expenses"], a[href="/budget/planning"]')
    .first()
    .waitFor({ timeout: 25000 })
    .then(() => true, () => false);
  check("A11c the Owner OPENS the real Budget shell",
    budgetShell && po.url().includes("/budget/"), po.url());
  await shot(po, "11c-owner-in-budget");
  await po.goto(`${EBASE}/election-day/owner/users`);
  await oSec(po, O_SEC).waitFor({ timeout: 20000 });

  await po.locator("aside").getByRole("link", { name: "תפקידים והרשאות" }).click();
  const rolesList = po.locator('[data-testid="owner-roles-list"]');
  await rolesList.locator("li").filter({ hasText: "UX עם תקציב" }).waitFor({ timeout: 20000 });
  const openEditor = async (name) => {
    await rolesList.locator("li").filter({ hasText: name }).getByRole("button", { name: "עריכת תפקיד" }).click();
    const d = po.getByRole("dialog", { name: "עריכת תפקיד" });
    await d.locator("[data-permission-group]").first().waitFor({ timeout: 10000 });
    return d;
  };
  const groupKeys = (d) => d.locator("[data-permission-group]").evaluateAll((els) => els.map((e) => e.getAttribute("data-permission-group")));
  const groupBoxes = (d, key) => d.locator(`[data-permission-group="${key}"] label`);
  const groupState = (d, key) => groupBoxes(d, key).evaluateAll((els) => els.map((l) => [l.innerText.trim(), l.querySelector("input").checked]));
  const count = (d, key) => d.locator(`[data-permission-group="${key}"] [data-group-count]`).innerText();
  const saveWithPassword = async (d) => {
    await d.getByRole("button", { name: "שמירה" }).click();
    const re = po.getByRole("dialog", { name: "אימות מחדש נדרש" });
    await re.waitFor({ timeout: 10000 });
    await re.getByLabel("הסיסמה שלך").fill(PW);
    await re.getByRole("button", { name: "אישור" }).click();
    await d.waitFor({ state: "detached", timeout: 20000 });
  };
  const BUDGET_LABELS = ["ניהול תקציב - צפייה", "ניהול תקציב - הוצאות ותשלומים", "ניהול תקציב - הגשות למממן",
    "ניהול תקציב - ספקים ופרטי בנק", "ניהול תקציב - תקציב ותכנון", "ניהול תקציב - דוחות", "ניהול תקציב - הגדרות"];

  const before = roleRow(R_BUD);
  let d = await openEditor("UX עם תקציב");
  check("R01 six permission sections in order (Election Day, voter actions, voter fields, Budget, users/roles, system)",
    same(await groupKeys(d), ["electionDay", "voterActions", "voterFields", "budget", "usersRoles", "system"]));
  check("R02 section headings are Hebrew and exposed as labelled groups",
    same(await d.locator('[role="group"][data-permission-group] h3').allInnerTexts(),
      ["יום הבחירות - ניהול ונתונים", "בוחרים - פעולות", "בוחרים - צפייה בפרטים", "ניהול תקציב", "משתמשים ותפקידים", "מערכת והגדרות"]) &&
    (await d.getByRole("group", { name: "ניהול תקציב" }).count()) === 1);
  const budgetState = await groupState(d, "budget");
  check("R03 Budget section = exactly the seven Budget permissions, in order, all ticked for this role",
    same(budgetState.map(([l]) => l), BUDGET_LABELS) && budgetState.every(([, c]) => c), budgetState.map(([l]) => l).join(" | "));
  const allLabels = await d.locator("[data-permission-group] label").allInnerTexts();
  check("R04 31 grantable permissions, each exactly once; the inert 'ניהול הרשאות משתמשים' is not offered",
    allLabels.length === 31 && new Set(allLabels).size === 31 && !allLabels.some((l) => l.includes("ניהול הרשאות משתמשים")));
  check("R05 no raw permission keys in the editor", !/\b(voter|electionDay|budget|app)\.[a-zA-Z]+/.test(await d.innerText()));
  check("R06 per-section counters match the role (Budget 7/7, Election Day 1/6, voter fields 4/10)",
    (await count(d, "budget")) === "7/7" && (await count(d, "electionDay")) === "1/6" && (await count(d, "voterFields")) === "4/10");
  await shot(po, "07-role-editor-budget");
  await d.getByRole("button", { name: "ביטול" }).click();
  await d.waitFor({ state: "detached", timeout: 10000 });
  check("R07 opening + cancelling the editor changes nothing in the DB", roleRow(R_BUD) === before);

  d = await openEditor("UX עם תקציב");
  await saveWithPassword(d);
  check("R08 save with no edits (after Owner password) -> identical backend permission set, hidden manageUsers kept, flags unchanged",
    roleRow(R_BUD) === before && roleRow(R_BUD).split("|")[0].split(",").includes("electionDay.manageUsers"));

  const beforeNob = roleRow(R_NOB);
  d = await openEditor("UX ללא תקציב");
  check("R09 role without Budget: Budget section present, nothing ticked (0/7)",
    (await count(d, "budget")) === "0/7" && (await groupState(d, "budget")).every(([, c]) => !c));
  const box7 = (label) => d.locator('[data-permission-group="budget"] label').filter({ hasText: label }).locator("input");
  await box7("ניהול תקציב - דוחות").check();
  const cascadeOn = (await box7("ניהול תקציב - צפייה").isChecked()) && (await count(d, "budget")) === "2/7";
  await box7("ניהול תקציב - צפייה").uncheck();
  const cascadeOff = (await count(d, "budget")) === "0/7";
  check("R10 cascade unchanged: ticking Reports adds View; unticking View removes every Budget permission", cascadeOn && cascadeOff);
  await box7("ניהול תקציב - דוחות").check();
  await saveWithPassword(d);
  const afterNob = roleRow(R_NOB).split("|");
  check("R11 saved set = original + budget.view + budget.viewReports exactly; name/description/scope/manager flag unchanged",
    afterNob[0] === sorted([...R_NOB_PERMS, "budget.view", "budget.viewReports"]) &&
    afterNob.slice(1).join("|") === beforeNob.split("|").slice(1).join("|"), afterNob[0]);

  await po.setViewportSize({ width: 390, height: 844 });
  d = await openEditor("UX עם תקציב");
  const budgetLabelBoxes = await groupBoxes(d, "budget").evaluateAll((els) => els.map((l) => l.getBoundingClientRect().left));
  const dlgWidth = await d.evaluate((el) => el.getBoundingClientRect().width);
  check("R12 390: editor fits the screen, sections stack to one column, no horizontal overflow",
    await noOverflow(po) && dlgWidth <= 390 && new Set(budgetLabelBoxes.map((x) => Math.round(x))).size === 1);
  await shot(po, "08-role-editor-390");
  await d.getByRole("button", { name: "ביטול" }).click();
  await d.waitFor({ state: "detached", timeout: 10000 });
  check("R13 R_BUD still unchanged after the mobile open/cancel", roleRow(R_BUD) === before);

  section("OWNER IN THE FULL SHELL - 390 navigation");
  await po.goto(`${EBASE}/election-day/owner/users`);
  // The Budget settings link joins the administration group only once the
  // module probe resolves - wait for it before reading the mobile navigation.
  await po.locator(`aside a[href='${BUDGET_HREF}']`).first().waitFor({ state: "attached", timeout: 25000 });
  // The full application shell has NO hamburger drawer - its mobile navigation
  // is the persistent bottom bar, which carries the items of the group the
  // Owner is currently in. That is the documented difference from the retired
  // Owner-only shell, not a missing affordance.
  const oBottomNav = po.locator("nav.fixed.inset-x-0.bottom-0");
  await oBottomNav.waitFor({ timeout: 15000 });
  check("A12 390: the fixed side menu is hidden and the bottom bar replaces it; no horizontal overflow",
    !(await po.locator("aside nav").isVisible()) &&
      (await oBottomNav.isVisible()) &&
      (await noOverflow(po)));
  check("A13 390: the bottom bar carries the administration items, and no drawer is used",
    (await oBottomNav.locator(`a[href='${OWNER_ADMIN_HREFS[1]}']`).count()) === 1 &&
      (await oBottomNav.locator(`a[href='${BUDGET_HREF}']`).count()) === 1 &&
      (await po.getByRole("dialog", { name: "ניווט ראשי" }).count()) === 0,
    await oBottomNav.locator("a").evaluateAll((els) => els.map((e) => e.getAttribute("href")).join(",")));
  await shot(po, "12-owner-admin-mobile-390");
  await oBottomNav.locator(`a[href='${BUDGET_HREF}']`).first().click();
  await po.waitForURL(/\/owner\/budget-settings$/, { timeout: 15000 }).catch(() => {});
  check("A14 390: choosing Budget settings from the bottom bar navigates there",
    path0(po) === BUDGET_HREF, po.url());
  check("A15 390: no horizontal overflow on Budget settings", await noOverflow(po));

  check("Z1 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  server.close();
  psql(`update public.platform_modules set available = false where key = 'budget';`);
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
process.exit(tally("UX NAV + ROLES") ? 1 : 0);
