// Platform Stage 9 - REAL-LOCAL UI suite: Platform Owner module choice ->
// Election Owner onboarding with NO first-user step -> Owner administration
// (reload / sign-out / sign-in never strands the Owner) -> Owner user
// management -> Manager login with no user-management surface -> entitlement
// edit from the Platform console locks / unlocks worker login -> responsive.
//
// Builds the `platform` AND `election` surfaces against the isolated kolboxs5
// scratch stack, serves each with scripts/stage5/localServer.mjs (vercel.json
// rewrites -> the REAL bundled handlers) and drives headless Chromium.
// Synthetic *@stage9-ui.invalid identities only; nothing secret is printed.
//
// Run:  S5_STACK_DIR=<scratch>/s9stack [S5_PORT_OFFSET=1000] node scripts/stage9/ui-stage9.mjs <outDir>
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
  totp,
} from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-stage9-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const P_PORT = 5198;
const E_PORT = 5197;
const PBASE = `http://127.0.0.1:${P_PORT}`;
const EBASE = `http://127.0.0.1:${E_PORT}`;
process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = EBASE;
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "http://127.0.0.1:5196";
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
const H = await buildHandlers();
const a = admin();
const DOMAIN = "stage9-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const WS_NAME = "S9UI מערכת ניסוי";

function build(surface, distDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--outDir",
      distDir,
      "--emptyOutDir",
      "--logLevel",
      "error",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        VITE_APP_SURFACE: surface,
        VITE_SUPABASE_URL: stackEnv.API_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
}

section("BUILD platform + election surfaces against the scratch stack");
const pDist = path.join(outDir, "dist-platform");
const eDist = path.join(outDir, "dist-election");
build("platform", pDist);
build("election", eDist);
check("B1 both bundles built", fs.existsSync(path.join(pDist, "index.html")) && fs.existsSync(path.join(eDist, "index.html")));

section("SETUP");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access;
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S9UI %';
  delete from public.election_day_login_attempts;
`);
async function listUsers() {
  const out = [];
  for (let p = 1; p < 20; p++) {
    const { data, error } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
for (const u of await listUsers()) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);

const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'S9 UI PO', '${email("po")}');`);
const poApi = await enrollTotp((await signIn(email("po"), poPw)).client, "s9-ui-po");

const common = {
  "/api/platform/session": H.platformSession,
  "/api/health": H.health,
};
const pServer = await startLocalServer({ distDir: pDist, port: P_PORT, handlers: common });
const eServer = await startLocalServer({
  distDir: eDist,
  port: E_PORT,
  handlers: {
    ...common,
    "/api/election-day/owner-actions": H.ownerActions,
    "/api/election-day/owner-roles": H.ownerRoles,
    "/api/election-day/owner-reauth": H.ownerReauth,
    "/api/election-day/session": H.electionSession,
    "/api/election-day/permission-users": H.permissionUsers,
    "/api/election-day/reauth": H.reauth,
    "/api/election-day/actions": H.actions,
    "/api/election-day/roles": H.roles,
  },
});

const browser = await chromium.launch();
const newPage = async (ctxOpts = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL", ...ctxOpts });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const pageErrors = [];
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const bodyText = (p) => p.locator("body").innerText();
const noOverflow = (p) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const waitText = (p, t, timeout = 15000) =>
  p.getByText(t).first().waitFor({ timeout }).then(() => true, () => false);

async function totpInto(p, secret, successLocator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.locator('input[autocomplete="one-time-code"]').fill(totp(secret));
    await p.getByRole("button", { name: "אימות" }).click();
    if (await successLocator.waitFor({ timeout: 8000 }).then(() => true, () => false)) return true;
    await sleep(31000); // the enrolment code cannot be reused within its window
  }
  return false;
}
/** Waits for the worker shell. On failure returns the URL + a short text
 * excerpt (synthetic data only) and a screenshot, so a miss is diagnosable. */
async function workerShell(p, label) {
  const ok = await p
    .getByRole("link", { name: "בוחרים" })
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  if (ok) return { ok, detail: "" };
  await shot(p, `diag-${label}`);
  const excerpt = (await bodyText(p)).replace(/\s+/g, " ").slice(0, 160);
  return { ok, detail: `url=${new URL(p.url()).pathname} text=${excerpt}` };
}
async function reauthConfirm(p, password) {
  const dlg = p.getByRole("dialog").last();
  await dlg.locator('input[autocomplete="current-password"]').waitFor({ timeout: 10000 });
  await dlg.locator('input[autocomplete="current-password"]').fill(password);
  await dlg.getByRole("button", { name: "אישור" }).click();
}

const ownerPw = randomPassword();
const managerPw = randomPassword();
const ordinaryPw = randomPassword();
let loginCode = "";

try {
  // -------------------------------------------------------------------------
  section("PLATFORM OWNER: approve with an EXPLICIT module choice");
  const page = await newPage();
  await page.goto(`${PBASE}/platform/login`);
  await page.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 15000 });
  await page.locator('input[type="email"]').fill(email("po"));
  await page.locator('input[autocomplete="current-password"]').fill(poPw);
  await page.getByRole("button", { name: "התחברות" }).click();
  await page.getByRole("heading", { name: "אימות דו-שלבי" }).waitFor({ timeout: 15000 });
  check("P1 password + TOTP -> console", await totpInto(page, poApi.secret, page.getByRole("heading", { name: "מסוף בעל הפלטפורמה" })));
  // Admin shell: approval is a dialog opened from the Owners section.
  await page.getByRole("button", { name: "אישור בעלים חדש" }).click();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "אישור ויצירת קישור" }) });
  await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').first().waitFor({ timeout: 15000 });
  const boxes = await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').count();
  const anyChecked = await form.locator('[data-testid="approval-modules"] input[type="checkbox"]:checked').count();
  check("P2 the approval form offers the 3 catalogued modules, none pre-selected", boxes === 3 && anyChecked === 0, `${boxes}/${anyChecked}`);
  await form.getByLabel("שם הבעלים").fill("בעלים ניסוי");
  await form.getByLabel("אימייל").fill(email("owner"));
  await form.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  check("P3 submitting with NO module is refused in the form", await waitText(page, "יש לבחור לפחות מודול אחד", 5000));
  check("P4 ... and nothing was created server-side", psql(`select count(*) from public.election_workspace_pending_owner_access where email = '${email("owner")}'`) === "0");
  await form.getByRole("checkbox", { name: "ניהול יום הבחירות" }).check();
  await form.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  await page.getByText("הבעלים אושר").waitFor({ timeout: 15000 });
  const link = await page.locator('[dir="ltr"]').filter({ hasText: "/election-day/owner-set-password" }).first().innerText();
  check("P5 approval with Election Day -> one-time link", link.includes("/election-day/owner-set-password?"));
  check("P6 the approval records exactly the chosen module",
    psql(`select array_to_string(requested_modules, ',') from public.election_workspace_pending_owner_access where email = '${email("owner")}'`) === "election_day");
  await page.locator('[data-testid="owner-access-list"] li').filter({ hasText: email("owner") }).getByText("מודולים שנבחרו: ניהול יום הבחירות").waitFor({ timeout: 10000 });
  check("P7 the approvals list shows the requested module", true);
  check("P8 console: no horizontal overflow at 390", await noOverflow(page));
  await shot(page, "01-console-approval-390");

  // -------------------------------------------------------------------------
  section("ELECTION OWNER: activation -> setup -> administration (no first-user step)");
  const ePage = await newPage();
  await ePage.goto(link);
  await ePage.getByText("הגדרת סיסמה לחשבון הבעלים").waitFor({ timeout: 15000 });
  const pw = ePage.locator('input[type="password"]');
  await pw.nth(0).fill(ownerPw);
  await pw.nth(1).fill(ownerPw);
  await ePage.getByRole("button", { name: "שמירת סיסמה" }).click();
  await ePage.getByText("הסיסמה נשמרה").waitFor({ timeout: 15000 });
  await ePage.getByRole("button", { name: "מעבר להתחברות" }).click();
  await ePage.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await ePage.locator('input[type="email"]').fill(email("owner"));
  await ePage.locator('input[autocomplete="current-password"]').fill(ownerPw);
  await ePage.getByRole("button", { name: "התחברות" }).click();
  await ePage.getByText("הקמת מערכת הבחירות").first().waitFor({ timeout: 20000 });
  await ePage.locator("#ws-name").fill(WS_NAME);
  await ePage.locator("#ws-end").fill("2026-12-31T20:00");
  await ePage.getByRole("button", { name: "יצירת מערכת הבחירות" }).click();
  await ePage.getByText("מערכת הבחירות נוצרה").first().waitFor({ timeout: 20000 });
  const createdBody = await bodyText(ePage);
  check("O1 workspace created; the old mandatory 'יצירת המשתמש הראשון' step is GONE", !createdBody.includes("יצירת המשתמש הראשון"));
  check("O2 zero PermissionUsers exist after provisioning",
    psql(`select count(*) from public.election_day_permission_users u join public.election_workspaces w on w.id = u.workspace_id where w.name = '${WS_NAME}'`) === "0");
  await shot(ePage, "02-created-390");
  await ePage.getByRole("button", { name: "המשך לניהול המערכת" }).click();
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  loginCode = (await ePage.locator('[data-testid="owner-workspace-code"]').innerText()).trim();
  check("O3 the Owner lands on administration with the workspace code and its module",
    /^[A-Z0-9]{6,}$/.test(loginCode) && (await ePage.locator('[data-testid="owner-modules"]').innerText()).includes("ניהול יום הבחירות"));
  check("O4 zero users is shown as a normal empty state", await waitText(ePage, "לא נוספו משתמשים עדיין"));
  await ePage.reload();
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  check("O5 reload keeps the Owner on administration", await waitText(ePage, "לא נוספו משתמשים עדיין"));
  await ePage.getByRole("button", { name: "התנתקות" }).click();
  await ePage.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await ePage.locator('input[type="email"]').fill(email("owner"));
  await ePage.locator('input[autocomplete="current-password"]').fill(ownerPw);
  await ePage.getByRole("button", { name: "התחברות" }).click();
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  check("O6 sign-out + sign-in returns the Owner straight to administration (not setup, not a user step)",
    !(await bodyText(ePage)).includes("יצירת המשתמש הראשון"));
  await ePage.goto(`${EBASE}/election-day/owner/setup`);
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  check("O7 revisiting the setup URL redirects a provisioned Owner to administration", true);
  check("O8 administration: no horizontal overflow at 390", await noOverflow(ePage));
  await shot(ePage, "03-admin-empty-390");

  // -------------------------------------------------------------------------
  section("OWNER USER MANAGEMENT");
  const usersCard = ePage.locator('[data-testid="owner-users-card"]');
  async function addUser(name, password, roleName) {
    // Admin shell: "add user" opens a dialog; the Owner step-up stacks on it.
    await usersCard.getByRole("button", { name: "הוספת משתמש" }).click();
    const dlg = ePage.getByRole("dialog").filter({ hasText: "הוספת משתמש" });
    await dlg.locator('input[name="new-permission-user-name"]').fill(name);
    await dlg.locator('input[name="new-permission-user-password"]').fill(password);
    await dlg.locator("select").selectOption({ label: roleName });
    await dlg.getByRole("button", { name: "הוספה", exact: true }).click();
    await reauthConfirm(ePage, ownerPw);
    await usersCard.getByText(name, { exact: true }).waitFor({ timeout: 15000 });
    await dlg.waitFor({ state: "detached", timeout: 10000 });
  }
  await addUser("s9ui-manager", managerPw, "מנהל");
  check("U1 Owner creates the first Manager from administration", true);
  await addUser("s9ui-ordinary", ordinaryPw, "טלפן/ית");
  check("U2 Owner creates an ordinary user", true);
  const mgrRow = usersCard.locator("li").filter({ hasText: "s9ui-manager" });
  const ordRow = usersCard.locator("li").filter({ hasText: "s9ui-ordinary" });
  check("U3 the Manager's reset action is disabled (Owner cannot reset a Manager)",
    await mgrRow.getByRole("button", { name: "לא ניתן לאפס סיסמה של משתמש בתפקיד מנהל" }).isDisabled());
  const newOrdinaryPw = randomPassword();
  await ordRow.getByRole("button", { name: "איפוס סיסמה" }).click();
  const resetDlg = ePage.getByRole("dialog").filter({ hasText: "איפוס סיסמה" });
  await resetDlg.locator('input[autocomplete="new-password"]').nth(0).fill(newOrdinaryPw);
  await resetDlg.locator('input[autocomplete="new-password"]').nth(1).fill(newOrdinaryPw);
  await resetDlg.getByRole("button", { name: "אפס סיסמה" }).click();
  await reauthConfirm(ePage, ownerPw);
  check("U4 Owner resets the ordinary user's password", await waitText(ePage, "הסיסמה של s9ui-ordinary אופסה בהצלחה"));
  await shot(ePage, "04-admin-users-390");

  // -------------------------------------------------------------------------
  section("MANAGER: normal Election Day login, NO user management");
  const wPage = await newPage();
  async function workerLogin(p, name, password) {
    await p.goto(`${EBASE}/election-day/login`);
    await p.getByLabel("קוד מערכת").fill(loginCode);
    await p.locator('input[autocomplete="username"]').fill(name);
    await p.locator('input[autocomplete="current-password"]').fill(password);
    await p.getByRole("button", { name: "התחברות" }).click();
  }
  psql("delete from public.election_day_login_attempts;");
  await workerLogin(wPage, "s9ui-manager", managerPw);
  const inShell = await workerShell(wPage, "w1");
  check("W1 the Manager signs in to Election Day", inShell.ok, inShell.detail);
  const shellText = await bodyText(wPage);
  check("W2 no users/permissions entry anywhere in the Manager's navigation", !shellText.includes("הרשאות ומשתמשים"));
  await wPage.goto(`${EBASE}/election-day/permissions`);
  await sleep(1500);
  check("W3 the old users URL renders no user-management form",
    (await wPage.locator('input[name="new-permission-user-name"]').count()) === 0);
  await wPage.goto(`${EBASE}/election-day/owner/roles`);
  await wPage.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  check("W4 the Manager cannot reach Owner administration (sent to the Owner login)", true);
  await shot(wPage, "05-manager-390");

  // -------------------------------------------------------------------------
  section("ENTITLEMENT EDIT FROM THE PLATFORM CONSOLE");
  // Admin shell: module assignment is its own section; the editor is a dialog
  // and the confirmation stacks on it.
  await page.goto(`${PBASE}/platform/modules`);
  const wsRow = page.locator('[data-testid="workspace-modules-list"] li').filter({ hasText: WS_NAME });
  const modDlg = page.getByRole("dialog").filter({ hasText: "עריכת מודולים" });
  await wsRow.waitFor({ timeout: 15000 });
  check("E1 the console lists the new workspace with Election Day", (await wsRow.innerText()).includes("ניהול יום הבחירות"));
  await wsRow.getByRole("button", { name: "עריכת מודולים" }).click();
  await modDlg.getByRole("checkbox", { name: "ניהול יום הבחירות" }).uncheck();
  await modDlg.getByRole("checkbox", { name: /ניהול תקציב/ }).check();
  await modDlg.getByRole("button", { name: "שמירה" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "עדכון" }).click();
  check("E2 saving the new module set succeeds", await waitText(page, "המודולים עודכנו"));
  check("E3 the database now holds budget only",
    psql(`select string_agg(m.module_key, ',') from public.election_workspace_modules m join public.election_workspaces w on w.id = m.workspace_id where w.name = '${WS_NAME}'`) === "budget");
  await shot(page, "06-console-modules-390");

  psql("delete from public.election_day_login_attempts;");
  const lockedPage = await newPage();
  await workerLogin(lockedPage, "s9ui-manager", managerPw);
  check("E4 the Manager's login is refused with the module message",
    await waitText(lockedPage, "מודול יום הבחירות אינו פעיל למערכת זו. פנו לבעלי המערכת."));
  await wPage.goto(`${EBASE}/election-day`);
  const stillIn = await wPage.getByRole("link", { name: "בוחרים" }).first().waitFor({ timeout: 6000 }).then(() => true, () => false);
  check("E5 the Manager's already-open session no longer gets into the shell", !stillIn);
  await ePage.reload();
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  check("E6 Owner administration stays available and explains the disabled module",
    await waitText(ePage, "מודול יום הבחירות אינו פעיל למערכת זו") && (await usersCard.innerText()).includes("s9ui-manager"));

  await wsRow.getByRole("button", { name: "עריכת מודולים" }).click();
  await modDlg.getByRole("checkbox", { name: "ניהול יום הבחירות" }).check();
  await modDlg.getByRole("button", { name: "שמירה" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "עדכון" }).click();
  await waitText(page, "המודולים עודכנו");
  psql("delete from public.election_day_login_attempts;");
  const backPage = await newPage();
  await workerLogin(backPage, "s9ui-manager", managerPw);
  const back = await workerShell(backPage, "e7");
  check("E7 re-enabling Election Day restores the Manager's login", back.ok, back.detail);

  // -------------------------------------------------------------------------
  section("OWNER DELETES USERS -> back to zero, still administrable");
  for (const name of ["s9ui-ordinary", "s9ui-manager"]) {
    await ePage.reload();
    await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
    const row = usersCard.locator("li").filter({ hasText: name });
    await row.getByRole("button", { name: "מחיקת משתמש" }).click();
    await ePage.getByRole("dialog").getByRole("button", { name: "מחק משתמש" }).click();
    await reauthConfirm(ePage, ownerPw);
    await row.waitFor({ state: "detached", timeout: 15000 });
  }
  check("D1 Owner deleted the ordinary user and the Manager", await waitText(ePage, "לא נוספו משתמשים עדיין"));

  // -------------------------------------------------------------------------
  section("ADMIN SHELL LAYOUT - fixed viewport, side navigation, internal scroll");
  // The shell is one viewport tall: the DOCUMENT must never scroll vertically;
  // only a section's own [data-admin-scroll-region] may.
  const pageScrolls = (p) =>
    p.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1);
  const sideMenu = (p) => p.locator("aside nav");
  const menuBtn = (p) => p.getByRole("button", { name: "פתיחת תפריט הניווט" });
  const activeNav = (p) => p.locator('aside a[aria-current="page"]').innerText();
  const drawer = (p) => p.getByRole("dialog", { name: "ניווט ראשי" });

  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    await ePage.setViewportSize({ width: w, height: h });
    await ePage.goto(`${EBASE}/election-day/owner/users`);
    await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
    check(`L1 Owner ${w}px: fixed side menu visible, no menu button, active item = משתמשים`,
      (await sideMenu(ePage).isVisible()) && !(await menuBtn(ePage).isVisible()) && (await activeNav(ePage)).includes("משתמשים"));
    check(`L2 Owner ${w}px: the page itself does not scroll; no horizontal overflow`,
      !(await pageScrolls(ePage)) && (await noOverflow(ePage)));
    await shot(ePage, `10-owner-users-${w}`);
  }

  await ePage.setViewportSize({ width: 1280, height: 800 });
  await usersCard.getByRole("button", { name: "הוספת משתמש" }).click();
  await ePage.getByRole("dialog").filter({ hasText: "הוספת משתמש" }).waitFor({ timeout: 10000 });
  check("L3 the add-user dialog opens over the shell - the page does not grow", !(await pageScrolls(ePage)));
  await shot(ePage, "11-owner-add-user-dialog-1280");
  await ePage.keyboard.press("Escape");
  check("L3 Escape closes the add-user dialog",
    await ePage.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));

  await ePage.goto(`${EBASE}/election-day/owner/modules`);
  await ePage.locator('[data-module="election_day"]').waitFor({ timeout: 15000 });
  check("L4 direct link to Modules: Election Day shown as enabled, read-only, nav item active",
    (await ePage.locator('[data-module="election_day"]').innerText()).includes("פעיל") &&
    (await ePage.locator('[data-testid="owner-modules-section"] button').count()) === 0 &&
    (await activeNav(ePage)).includes("מודולים"));
  await shot(ePage, "12-owner-modules-1280");

  await ePage.goto(`${EBASE}/election-day/owner/settings`);
  await ePage.locator('[data-testid="owner-settings-section"]').getByText(loginCode).first().waitFor({ timeout: 15000 });
  check("L5 direct link to Settings: workspace code + Owner account shown",
    (await ePage.locator('[data-testid="owner-settings-section"]').innerText()).includes(email("owner")));

  await ePage.goto(`${EBASE}/election-day/owner/roles`);
  const mgrRoles = ePage.locator('[data-testid="owner-roles-list"] li[data-manager="true"]');
  await mgrRoles.first().waitFor({ timeout: 15000 });
  check("L6 Roles: the seeded מנהל role carries the Manager marker",
    (await mgrRoles.count()) >= 1 && (await mgrRoles.first().innerText()).includes("מנהל"));
  await ePage.getByRole("button", { name: "תפקיד חדש" }).click();
  await ePage.getByRole("dialog").filter({ hasText: "תפקיד חדש" }).waitFor({ timeout: 10000 });
  check("L7 the role editor is a dialog - the page does not grow", !(await pageScrolls(ePage)));
  await shot(ePage, "13-owner-role-editor-1280");
  await ePage.keyboard.press("Escape");
  await ePage.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
  await ePage.reload();
  await ePage.getByRole("heading", { name: "תפקידים והרשאות", level: 2 }).waitFor({ timeout: 15000 });
  check("L8 reload keeps the Owner on the same section", new URL(ePage.url()).pathname === "/election-day/owner/roles");

  await ePage.setViewportSize({ width: 390, height: 844 });
  await ePage.goto(`${EBASE}/election-day/owner/users`);
  await ePage.getByRole("heading", { name: "ניהול המערכת - בעלים" }).waitFor({ timeout: 15000 });
  check("L9 390px: side menu hidden, menu button shown, no page scroll / overflow",
    !(await sideMenu(ePage).isVisible()) && (await menuBtn(ePage).isVisible()) && !(await pageScrolls(ePage)) && (await noOverflow(ePage)));
  await menuBtn(ePage).click();
  await drawer(ePage).getByRole("link", { name: "תפקידים והרשאות" }).click();
  await ePage.waitForURL(/\/election-day\/owner\/roles$/, { timeout: 10000 });
  check("L10 390px: the navigation drawer navigates and closes itself", (await drawer(ePage).count()) === 0);
  await menuBtn(ePage).click();
  await drawer(ePage).waitFor({ timeout: 5000 });
  await shot(ePage, "14-owner-drawer-390");
  await ePage.keyboard.press("Escape");
  check("L11 Escape closes the navigation drawer",
    await drawer(ePage).waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false));

  // Platform: long lists scroll ONLY inside their section region.
  psql(`
    insert into public.election_workspaces (name, election_end_at, login_code)
    select 'S9UI L' || lpad(g::text, 2, '0'), now() + interval '10 days', public.election_day_generate_workspace_login_code()
    from generate_series(1, 40) g;
  `);
  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${PBASE}/platform/modules`);
    await page.locator('[data-testid="workspace-modules-list"] li').nth(35).waitFor({ timeout: 15000 });
    const region = page.locator('[data-testid="workspace-modules-card"] [data-admin-scroll-region]');
    const r = await region.evaluate((el) => {
      const overflows = el.scrollHeight > el.clientHeight + 1;
      el.scrollTop = 400;
      return { overflows, scrolled: el.scrollTop > 0 };
    });
    check(`L12 Platform ${w}px: 40+ workspaces scroll inside the list region; the page does not`,
      r.overflows && r.scrolled && !(await pageScrolls(page)) && (await noOverflow(page)), JSON.stringify(r));
    check(`L13 Platform ${w}px: fixed side menu, active item = הקצאת מודולים`,
      (await sideMenu(page).isVisible()) && (await activeNav(page)).includes("הקצאת מודולים"));
    await shot(page, `15-platform-modules-${w}`);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${PBASE}/platform/workspaces`);
  await page.getByRole("button", { name: `פרטי ${WS_NAME}` }).click();
  const detailDrawer = page.getByRole("dialog").filter({ hasText: "קוד מערכת" });
  await detailDrawer.waitFor({ timeout: 10000 });
  check("L14 Workspaces: the detail panel shows the Owner, the code and Election Day",
    ((t) => t.includes(loginCode) && t.includes("בעלים ניסוי") && t.includes("ניהול יום הבחירות"))(await detailDrawer.innerText()));
  check("L14 ... and the page does not grow", !(await pageScrolls(page)));
  await shot(page, "16-platform-workspace-detail-1280");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  await page.goto(`${PBASE}/platform/audit`);
  check("L15 Audit: an explicit 'not available yet' state (no invented backend)", await waitText(page, "תצוגת היומן תתווסף בהמשך"));
  await page.goto(`${PBASE}/platform/settings`);
  check("L16 Settings: the verified identity", await waitText(page, email("po")));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${PBASE}/platform/owners`);
  await page.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }).waitFor({ timeout: 15000 });
  await menuBtn(page).click();
  await drawer(page).getByRole("link", { name: "רב-מערכות" }).click();
  check("L17 390px: the drawer reaches Multi-Entity management",
    await page.getByRole("heading", { name: "ניהול בעל רב-מערכות" }).waitFor({ timeout: 15000 }).then(() => true, () => false));
  check("L18 390px Platform: no page scroll, no horizontal overflow", !(await pageScrolls(page)) && (await noOverflow(page)));
  await shot(page, "17-platform-multi-entity-390");

  check("Z1 no uncaught page errors on any page", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  check("RUN completed without an exception", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  pServer.close();
  eServer.close();
  psql(`
    delete from public.election_owners where email like '%@${DOMAIN}';
    delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
    delete from public.election_workspaces where name like 'S9UI %';
    delete from public.platform_owners;
    delete from public.election_day_login_attempts;
  `);
  for (const u of await listUsers()) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

process.exit(tally("STAGE 9 UI") > 0 ? 1 : 0);
