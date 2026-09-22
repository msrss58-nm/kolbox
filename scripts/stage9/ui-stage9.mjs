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

// The Owner administers from the ONE full application shell now - the separate
// Owner admin shell is gone as a landing destination, so there is no
// "ניהול המערכת - בעלים" heading to wait for. The stable landmark is the Owner
// administration group in that shell's own sidebar, and the admin sections keep
// their original /election-day/owner/* paths.
const OWNER_NAV_SECTION = "ניהול יום בחירות";
const ownerAdmin = async (p) => {
  try {
    await p.locator(`[data-nav-section="${OWNER_NAV_SECTION}"]`).first().waitFor({ state: "attached", timeout: 25000 });
  } catch (e) {
    console.log("--- ownerAdmin DIAGNOSTIC ---");
    console.log("url:", p.url());
    console.log("sections:", JSON.stringify(await p.locator("[data-nav-section]").evaluateAll((els) => els.map((x) => x.getAttribute("data-nav-section")))));
    console.log("body:", (await p.locator("body").innerText()).slice(0, 500).split(String.fromCharCode(10)).join(" | "));
    throw e;
  }
  if (!p.url().includes("/election-day/owner/")) {
    await p.goto(`${EBASE}/election-day/owner/users`);
    await p.locator(`[data-nav-section="${OWNER_NAV_SECTION}"]`).first().waitFor({ state: "attached", timeout: 25000 });
  }
};
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
// Gate 4: effective module access = platform_modules.available AND the
// workspace's entitlement row. The entitlement block below leaves this
// workspace entitled to `budget` ONLY and asserts the Manager is then locked
// out of Election Day - which holds while budget is unavailable (no module
// admits the login). With budget AVAILABLE the module-neutral login
// (election_day_login_v3 admits election_day OR budget) would correctly let
// that worker in instead, so pin the flag here rather than inheriting
// whatever a previously-run suite (e.g. scripts/budget/ui-budget.mjs, which
// switches it on) happened to leave behind.
psql(`
  update public.platform_modules set available = false where key = 'budget';
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
  // Password-only sign-in: mandatory Platform Owner MFA was removed from the
  // active login flow (PLATFORM_OWNER_MFA_REQUIRED = false). The account still
  // holds a verified TOTP factor; it is simply never demanded.
  check("P1 password only -> console (no TOTP prompt)",
    await page.getByRole("heading", { name: "מסוף בעל הפלטפורמה" })
      .waitFor({ timeout: 20000 }).then(() => true, () => false));
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
  // Unified identity: the approval now also sets the Owner's LOGIN username.
  await form.locator('input[name="owner-approval-username"]').fill("s9ui owner");
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

  // --- SECOND-LOGIN REGRESSION (approved Owner, not provisioned yet) -------
  // This is the state the SHARED login hands over in: authenticated, with no
  // election_owners row. Landing on /election-day used to report them as
  // signed out and bounce them to the worker login, whose only way onward was
  // the legacy Owner login - a second credential prompt moments after they
  // had already signed in. The suite reaches this state through the legacy
  // screen only because the cross-origin handoff cannot run on one host; the
  // SESSION and the entry URL are identical either way, which is what this
  // asserts.
  const seen = [];
  ePage.on("framenavigated", (f) => {
    if (f === ePage.mainFrame()) seen.push(new URL(f.url()).pathname);
  });
  await ePage.goto(`${EBASE}/election-day`);
  // The guard resolves the destination asynchronously. Wait for it to stop
  // moving rather than for a particular screen, so a regression fails the
  // check below with the URL it actually reached - not an opaque timeout on
  // an element that was never going to appear.
  await ePage.waitForLoadState("networkidle").catch(() => {});
  await ePage.waitForTimeout(2000);
  check("O0a an approved-but-unprovisioned Owner landing on /election-day reaches PROVISIONING",
    new URL(ePage.url()).pathname === "/election-day/owner/setup", ePage.url());
  check("O0b ... and is never asked for credentials a second time",
    (await ePage.locator('input[type="password"]').count()) === 0 &&
      (await ePage.locator('input[name="kb-workspace-code"]').count()) === 0,
    `pw=${await ePage.locator('input[type="password"]').count()}`);
  check("O0c ... and never passes THROUGH a login screen on the way",
    !seen.some((u) => u.includes("owner-login") || u === "/election-day/login" || u === "/login"),
    seen.join(" -> "));

  // Continue the lifecycle from setup regardless of what the checks found, so
  // a regression reports the three results above instead of cascading.
  await ePage.goto(`${EBASE}/election-day/owner/setup`);
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
  await ownerAdmin(ePage);

  // The same entry URL, now that the workspace exists: straight in, still no
  // credential prompt, and into THIS Owner's own workspace.
  await ePage.goto(`${EBASE}/election-day`);
  await ownerAdmin(ePage);
  check("O0d a PROVISIONED Owner landing on /election-day opens their workspace directly",
    ePage.url().includes("/election-day/") &&
      !ePage.url().includes("login") &&
      (await ePage.locator('input[type="password"]').count()) === 0,
    ePage.url());
  // The workspace code and the module list are no longer duplicated into a
  // shell header - they are read from the sections that own them.
  await ePage.goto(`${EBASE}/election-day/owner/settings`);
  // The section renders a skeleton until the workspace summary lands, so poll
  // for the code rather than reading whatever is on screen first.
  loginCode = "";
  for (let i = 0; i < 40 && loginCode === ""; i++) {
    const t = await ePage
      .locator('[data-testid="owner-settings-section"]')
      .innerText({ timeout: 25000 });
    loginCode = (/[A-Z0-9]{6,}/.exec(t) ?? [""])[0].trim();
    if (loginCode === "") await ePage.waitForTimeout(500);
  }
  await ePage.goto(`${EBASE}/election-day/owner/modules`);
  let modulesText = "";
  for (let i = 0; i < 40 && !modulesText.includes("ניהול יום הבחירות"); i++) {
    modulesText = await ePage
      .locator('[data-testid="owner-modules-section"]')
      .innerText({ timeout: 25000 });
    if (!modulesText.includes("ניהול יום הבחירות")) await ePage.waitForTimeout(500);
  }
  check("O3 the Owner administers from the full shell, with the workspace code and its module",
    /^[A-Z0-9]{6,}$/.test(loginCode) && modulesText.includes("ניהול יום הבחירות"),
    `code=${loginCode}`);
  await ePage.goto(`${EBASE}/election-day/owner/users`);
  await ownerAdmin(ePage);
  check("O4 zero users is shown as a normal empty state", await waitText(ePage, "לא נוספו משתמשים עדיין"));
  await ePage.reload();
  await ownerAdmin(ePage);
  check("O5 reload keeps the Owner on administration", await waitText(ePage, "לא נוספו משתמשים עדיין"));
  await ePage.getByRole("button", { name: "התנתקות" }).click();
  // Unified entry: sign-out now returns every election-origin principal to the
  // one KOLBOX entry screen, which offers the Owner realm one click away.
  await ePage.getByRole("heading", { name: "כניסה לקולבוקס" }).waitFor({ timeout: 15000 });
  await ePage.getByRole("button", { name: "בעלי מערכת בחירות" }).click();
  await ePage.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await ePage.locator('input[type="email"]').fill(email("owner"));
  await ePage.locator('input[autocomplete="current-password"]').fill(ownerPw);
  await ePage.getByRole("button", { name: "התחברות" }).click();
  await ownerAdmin(ePage);
  check("O6 sign-out + sign-in returns the Owner straight to administration (not setup, not a user step)",
    !(await bodyText(ePage)).includes("יצירת המשתמש הראשון"));
  await ePage.goto(`${EBASE}/election-day/owner/setup`);
  await ownerAdmin(ePage);
  check("O7 revisiting the setup URL redirects a provisioned Owner to administration", true);
  check("O8 administration: no horizontal overflow at 390", await noOverflow(ePage));
  await shot(ePage, "03-admin-empty-390");

  // -------------------------------------------------------------------------
  section("OWNER USER MANAGEMENT");
  // The Owner's landing is the full shell's dashboard now, so the users
  // section is reached explicitly (in the app it is one sidebar click).
  //
  // Desktop width for the CRUD steps: the Owner sections now render inside the
  // full shell, which has a FIXED MOBILE BOTTOM NAV the old Owner-only shell
  // did not. At 390px that nav sits over the foot of the page and intercepts
  // the card's primary action, which is a mobile-layout interaction, not the
  // behaviour under test here. The 390px overflow assertions below still run
  // at 390px.
  await ePage.setViewportSize({ width: 1280, height: 900 });
  await ePage.goto(`${EBASE}/election-day/owner/users`);
  await ownerAdmin(ePage);
  const usersCard = ePage.locator('[data-testid="owner-users-card"]');
  await usersCard.waitFor({ timeout: 25000 });
  /**
   * TWO STEPS now, and NO Owner password: step 1 is the details plus the
   * server-side username check, step 2 is the new user's password.
   */
  async function addUser(name, password, roleName, username) {
    try {
      await usersCard.getByRole("button", { name: "הוספת משתמש" }).click({ timeout: 20000 });
    } catch (e) {
      console.log("--- addUser DIAGNOSTIC ---");
      console.log("url:", ePage.url());
      console.log("cards:", await ePage.locator('[data-testid="owner-users-card"]').count());
      const b = usersCard.getByRole("button", { name: "הוספת משתמש" });
      console.log("buttons:", await b.count(), "enabled:", await b.first().isEnabled().catch(() => "n/a"),
        "visible:", await b.first().isVisible().catch(() => "n/a"));
      console.log("card text:", (await usersCard.innerText().catch(() => "")).slice(0, 300).split(String.fromCharCode(10)).join(" | "));
      console.log("playwright:", String(e.message).slice(0, 900).split(String.fromCharCode(10)).join(" | "));
      throw e;
    }
    const dlg = ePage.getByRole("dialog").filter({ hasText: "הוספת משתמש" });
    await dlg.locator('input[name="new-permission-user-name"]').fill(name);
    if (username !== undefined) {
      await dlg.locator('input[name="new-permission-user-username"]').fill(username);
    }
    await dlg.locator("select").selectOption({ label: roleName });
    // Step 1 -> step 2. The password field does not exist until the username
    // has been checked, which is the whole point of the split.
    await dlg.getByRole("button", { name: "המשך", exact: true }).click();
    await dlg.locator('input[name="new-permission-user-password"]').waitFor({ timeout: 15000 });
    await dlg.locator('input[name="new-permission-user-password"]').fill(password);
    await dlg.getByRole("button", { name: "הוספה", exact: true }).click();
    await usersCard.getByText(name, { exact: true }).waitFor({ timeout: 15000 });
    await dlg.waitFor({ state: "detached", timeout: 10000 });
  }
  await addUser("s9ui-manager", managerPw, "מנהל");
  check("U1 Owner creates the first Manager from administration", true);
  await addUser("s9ui-ordinary", ordinaryPw, "טלפן/ית");
  check("U2 Owner creates an ordinary user", true);

  // ---------------------------------------------------------------------
  // The three UX fixes, asserted on the real screen.
  // ---------------------------------------------------------------------
  // 1. THE LIST AND THE COUNT ARE CURRENT, with no navigation and no reload.
  //    The count is read from the card's own header, not inferred from rows.
  const countText = async () =>
    (await usersCard.innerText()).replace(/\s+/g, " ");
  check("X1 the roster shows both new users immediately, without navigating away",
    (await countText()).includes("s9ui-manager") && (await countText()).includes("s9ui-ordinary"));
  // The card header renders "<n> משתמשים" - an exact string, so a count that
  // lagged the list by one would fail here rather than pass on a loose match.
  check("X2 the header count moved to 2 in the same breath - no manual refresh",
    (await countText()).includes("2 משתמשים"), (await countText()).slice(0, 120));
  check("X3 the URL never changed - nothing navigated to make this happen",
    ePage.url().endsWith("/election-day/owner/users"), ePage.url());

  // 2. NO OWNER PASSWORD ANYWHERE IN THE CREATE FLOW.
  await usersCard.getByRole("button", { name: "הוספת משתמש" }).click();
  const cDlg = ePage.getByRole("dialog").filter({ hasText: "הוספת משתמש" });
  await cDlg.locator('input[name="new-permission-user-name"]').waitFor({ timeout: 15000 });
  check("X4 step 1 is the details - the new user's password is not on screen yet",
    (await cDlg.locator('input[name="new-permission-user-password"]').count()) === 0 &&
      (await cDlg.getByTestId("create-user-step").innerText()).includes("שלב 1"));
  check("X5 no Owner password field is present at step 1",
    (await cDlg.locator('input[autocomplete="current-password"]').count()) === 0);

  // 3. A TAKEN USERNAME IS CAUGHT HERE, BEFORE ANY PASSWORD IS TYPED.
  await cDlg.locator('input[name="new-permission-user-name"]').fill("s9ui-clash");
  await cDlg.locator('input[name="new-permission-user-username"]').fill("s9ui-manager");
  await cDlg.getByRole("button", { name: "המשך", exact: true }).click();
  await cDlg.getByTestId("username-collision").waitFor({ timeout: 15000 });
  check("X6 the clash is shown at step 1 and the step does NOT advance",
    (await cDlg.getByTestId("create-user-step").innerText()).includes("שלב 1") &&
      (await cDlg.locator('input[name="new-permission-user-password"]').count()) === 0);
  const suggestionText = (await cDlg.getByTestId("username-collision").innerText()).replace(/\s+/g, " ");
  check("X7 it offers base1 - the suffix is appended with NO space",
    suggestionText.includes("s9ui-manager1") && !suggestionText.includes("s9ui-manager 1"),
    suggestionText.slice(0, 120));

  await cDlg.getByRole("button", { name: "השתמשו בשם המוצע" }).click();
  check("X8 accepting the suggestion fills the field with the exact name",
    (await cDlg.locator('input[name="new-permission-user-username"]').inputValue()) === "s9ui-manager1");
  await cDlg.getByRole("button", { name: "המשך", exact: true }).click();
  await cDlg.locator('input[name="new-permission-user-password"]').waitFor({ timeout: 15000 });
  check("X9 a free name advances to the password step",
    (await cDlg.getByTestId("create-user-step").innerText()).includes("שלב 2"));
  check("X10 step 2 asks for the NEW user's password only - never the Owner's",
    (await cDlg.locator('input[autocomplete="new-password"]').count()) === 1 &&
      (await cDlg.locator('input[autocomplete="current-password"]').count()) === 0);
  await cDlg.locator('input[name="new-permission-user-password"]').fill(randomPassword());
  await cDlg.getByRole("button", { name: "הוספה", exact: true }).click();
  await usersCard.getByText("s9ui-clash", { exact: true }).waitFor({ timeout: 15000 });
  check("X11 the user is created with no Owner password prompt at any point",
    (await ePage.getByRole("dialog").count()) === 0);
  check("X12 the roster and its count both moved to 3, immediately",
    (await countText()).includes("s9ui-clash") && (await countText()).includes("3 משתמשים"),
    (await countText()).slice(0, 140));
  const mgrRow = usersCard.locator("li").filter({ hasText: "s9ui-manager" });
  const ordRow = usersCard.locator("li").filter({ hasText: "s9ui-ordinary" });
  // CONTRACT CHANGE (unified identity): the Owner may now reset ANY of their
  // users, Manager roles included - a Manager has no e-mail and no
  // self-service recovery, so their Owner is the only recovery path. The
  // server-side CANNOT_RESET_MANAGER refusal was lifted with this button, so
  // the UI is not standing in for an enforcement rule.
  check("U3 the Manager's reset action is now OFFERED (CANNOT_RESET_MANAGER lifted)",
    await mgrRow.getByRole("button", { name: "איפוס סיסמה" }).isEnabled());
  check("U3b no disabled 'cannot reset a Manager' affordance remains",
    (await mgrRow.getByRole("button", { name: "לא ניתן לאפס סיסמה של משתמש בתפקיד מנהל" }).count()) === 0);
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
  // The admin sections live inside the shell the Manager is already signed in
  // to, so a Manager who forces the URL now gets an explicit owner-only notice
  // instead of being bounced to a different login. Authorization is unchanged:
  // no administration data renders, and owner-actions would refuse them anyway.
  await wPage.goto(`${EBASE}/election-day/owner/roles`);
  await wPage.getByText("אזור ניהול המערכת").first().waitFor({ timeout: 15000 });
  check("W4 the Manager cannot reach Owner administration (owner-only notice, no admin data)",
    (await wPage.locator('[data-testid="owner-roles-list"]').count()) === 0 &&
      (await wPage.locator('[data-testid="owner-users-card"]').count()) === 0);
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
  await ownerAdmin(ePage);
  // Administration stays available with the module disabled - that is the
  // invariant. The explanation is no longer a banner in a shell of its own:
  // the module simply stops appearing in the shell's navigation (exactly the
  // "show only enabled modules" rule), and the Modules section states it.
  await ePage.goto(`${EBASE}/election-day/owner/users`);
  await ownerAdmin(ePage);
  // The roster refetches once the Owner session resolves, so wait for the
  // user rather than reading whatever the card shows first.
  await usersCard
    .getByText("s9ui-manager", { exact: true })
    .first()
    .waitFor({ timeout: 25000 })
    .catch(() => {});
  const e6Card = await usersCard.innerText().catch(() => "<no card>");
  const e6Sections = await ePage
    .locator("[data-nav-section]")
    .evaluateAll((els) => els.map((x) => x.getAttribute("data-nav-section")));
  check("E6 Owner administration stays available and the Election Day SCREENS are no longer offered",
    e6Card.includes("s9ui-manager") &&
      (await ePage.locator('aside a[href="/election-day/dashboard"]').count()) === 0 &&
      (await ePage.locator('aside a[href$="/owner/users"]').count()) === 1,
    `sections=${e6Sections.join("/")} card=${e6Card.slice(0, 120).split(String.fromCharCode(10)).join(" | ")}`);

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
  // s9ui-clash is the user the two-step section created; it is deleted here
  // with the other two so "back to zero" still means zero. Deleting it also
  // exercises the step-up that create no longer has - the dialog below asks
  // for the Owner's password, and must.
  for (const name of ["s9ui-clash", "s9ui-ordinary", "s9ui-manager"]) {
    await ePage.reload();
    await ownerAdmin(ePage);
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
    await ownerAdmin(ePage);
    check(`L1 Owner ${w}px: fixed side menu visible, no menu button, active item = משתמשים`,
      (await sideMenu(ePage).isVisible()) && !(await menuBtn(ePage).isVisible()) && (await activeNav(ePage)).includes("משתמשים"));
    // The Owner administers from the normal application shell now, which
    // scrolls vertically like every other screen in it - the old Owner-only
    // shell was a fixed-viewport one. The standing requirement is that the
    // page never scrolls HORIZONTALLY.
    check(`L2 Owner ${w}px: no horizontal overflow`, await noOverflow(ePage));
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
  check("L4 the retired Modules path redirects into Settings, which now carries the read-only module list",
    new URL(ePage.url()).pathname === "/election-day/owner/settings" &&
    (await ePage.locator('[data-module="election_day"]').innerText()).includes("פעיל") &&
    (await ePage.locator('[data-testid="owner-modules-section"] button').count()) === 0 &&
    (await activeNav(ePage)).includes("הגדרות") &&
    (await ePage.locator('aside a[href$="/owner/modules"]').count()) === 0,
    ePage.url());
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
  await ownerAdmin(ePage);
  // The full application shell has NO hamburger drawer - its mobile navigation
  // is the fixed bottom bar, which shows the current module's items. While the
  // Owner is in administration it therefore carries the administration items,
  // so they remain reachable on a phone.
  const bottomNav = ePage.locator("nav.fixed.inset-x-0.bottom-0");
  await bottomNav.waitFor({ timeout: 15000 });
  check("L9 390px: side menu hidden, the bottom nav carries administration, no horizontal overflow",
    !(await sideMenu(ePage).isVisible()) &&
      (await bottomNav.getByRole("link", { name: "תפקידים והרשאות" }).count()) === 1 &&
      (await noOverflow(ePage)));
  await bottomNav.getByRole("link", { name: "תפקידים והרשאות" }).click();
  await ePage.waitForURL(/\/election-day\/owner\/roles$/, { timeout: 10000 });
  check("L10 390px: the bottom nav navigated without opening any drawer", (await drawer(ePage).count()) === 0);
  await shot(ePage, "14-owner-mobile-390");
  // The full application shell deliberately has NO hamburger drawer - its
  // mobile navigation is the persistent bottom bar asserted in L9. The old
  // Owner-only shell had a drawer; this is the documented difference, not a
  // missing affordance.
  check("L11 this shell exposes the bottom bar, not a drawer or menu button",
    !(await menuBtn(ePage).isVisible().catch(() => false)) &&
      (await drawer(ePage).count()) === 0 &&
      (await ePage.locator("nav.fixed.inset-x-0.bottom-0").count()) === 1);

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
