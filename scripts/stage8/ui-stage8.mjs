// Platform Stage 8B - REAL-LOCAL UI suite for the Platform Owner console and
// the Multi-Entity management page.
//
// Builds the `platform` AND `election` surfaces against the isolated kolboxs5
// scratch stack, serves each with scripts/stage5/localServer.mjs (vercel.json
// rewrites -> the REAL bundled handlers, in this same process so faults can be
// injected), and drives headless Chromium:
//   Platform Owner login -> TOTP challenge -> console -> approve an Owner ->
//   duplicate / foreign / leftover-account paths -> approvals list -> re-issue
//   (active, with the old link invalidated) -> renew (expired) -> consumed is
//   read-only -> the renewed link completes Election Owner onboarding on the
//   election surface -> Multi-Entity management (destination address, form and
//   error reset after success/failure) -> MFA-setup sign-out -> storage/privacy
//   -> responsive (360/390/768/1280) -> accessible names -> logout.
//
// Run:  S5_STACK_DIR=<scratch>/s8stack [S5_PORT_OFFSET=1000] node scripts/stage8/ui-stage8.mjs <outDir>
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
  anon,
  callHandler,
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
const outDir = path.resolve(
  process.argv[2] ?? path.join(os.tmpdir(), "kolbox-stage8-ui"),
);
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const P_PORT = 5198;
const E_PORT = 5197;
const PBASE = `http://127.0.0.1:${P_PORT}`;
const EBASE = `http://127.0.0.1:${E_PORT}`;
const MEBASE = "http://127.0.0.1:5196"; // display-only: the Multi-Entity origin
process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = EBASE;
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = MEBASE;
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
const handlers = await buildHandlers();
const a = admin();
const DOMAIN = "stage8-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;

const setFaults = (f) => {
  globalThis.__S5_FAULTS = f;
};
const clearFaults = () => setFaults({});
clearFaults();

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
check(
  "B1 both bundles built",
  fs.existsSync(path.join(pDist, "index.html")) &&
    fs.existsSync(path.join(eDist, "index.html")),
);

section("SETUP");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  -- ALL approvals (scratch stack only): the console lists every approval, and
  -- other suites (e.g. Stage 5's pending-eo) leave theirs behind.
  delete from public.election_workspace_pending_owner_access;
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S8UI %';
`);
async function listUsers() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const { data, error } = await a.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
const usersWith = async (e) =>
  (await listUsers()).filter((u) => (u.email ?? "").toLowerCase() === e.toLowerCase());
for (const u of await listUsers())
  if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);

const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({
  email: email("po"),
  password: poPw,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'S8 UI PO', '${email("po")}');`,
);
const poApi = await enrollTotp((await signIn(email("po"), poPw)).client, "s8-ui-po");
const PO = poApi.token;
const strangerPw = randomPassword();
await a.auth.admin.createUser({
  email: email("stranger"),
  password: strangerPw,
  email_confirm: true,
});
await a.auth.admin.createUser({
  email: email("foreign"),
  password: randomPassword(),
  email_confirm: true,
});
const pPost = (body) =>
  callHandler(handlers.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: { authorization: `Bearer ${PO}`, origin: PBASE },
    body,
  });

const pServer = await startLocalServer({
  distDir: pDist,
  port: P_PORT,
  handlers: {
    "/api/platform/session": handlers.platformSession,
    "/api/health": handlers.health,
  },
});
const eServer = await startLocalServer({
  distDir: eDist,
  port: E_PORT,
  handlers: {
    "/api/platform/session": handlers.platformSession,
    "/api/health": handlers.health,
    "/api/election-day/owner-actions": handlers.ownerActions,
    "/api/election-day/session": handlers.electionSession,
  },
});

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  locale: "he-IL",
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const reqs = { ownerAccess: 0, reissue: 0 };
page.on("request", (r) => {
  if (r.url().includes("op=owner_access")) reqs.ownerAccess++;
  if (r.method() === "POST" && (r.postData() ?? "").includes("reissue_owner_access"))
    reqs.reissue++;
});
const shot = async (p, name) =>
  p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const bodyText = async (p = page) => p.locator("body").innerText();
const approvalForm = () =>
  page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "אישור ויצירת קישור" }) });
const row = (e) =>
  page.locator('[data-testid="owner-access-list"] li').filter({ hasText: e });
const ltrLinkIn = (loc, needle) =>
  loc.locator('[dir="ltr"]').filter({ hasText: needle }).first().innerText();
const oldLinkWorks = async (link) => {
  const h = new URL(link).searchParams.get("token_hash");
  const r = await anon().auth.verifyOtp({ token_hash: h, type: "recovery" });
  return !r.error;
};

async function totpInto(p, secret, successLocator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await p.locator('input[autocomplete="one-time-code"]').fill(totp(secret));
    await p.getByRole("button", { name: "אימות" }).click();
    if (
      await successLocator.waitFor({ timeout: 8000 }).then(
        () => true,
        () => false,
      )
    )
      return true;
    await sleep(31000); // a code used by the API enrollment cannot be reused in its window
  }
  return false;
}

async function approveViaUi(name, addr) {
  const f = approvalForm();
  await f.getByLabel("שם הבעלים").fill(name);
  await f.getByLabel("אימייל").fill(addr);
  // Stage 9: the module choice is explicit and required.
  await f.getByRole("checkbox", { name: "ניהול יום הבחירות" }).check();
  await f.getByRole("button", { name: "אישור ויצירת קישור" }).click();
}

try {
  section("LOGIN -> TOTP CHALLENGE -> CONSOLE");
  await page.goto(`${PBASE}/platform/login`);
  await page
    .getByRole("heading", { name: "כניסת בעל הפלטפורמה" })
    .waitFor({ timeout: 15000 });
  check("U0 no approvals request while signed out", reqs.ownerAccess === 0);
  await page.locator('input[type="email"]').fill(email("po"));
  await page.locator('input[autocomplete="current-password"]').fill(poPw);
  await page.getByRole("button", { name: "התחברות" }).click();
  await page.getByRole("heading", { name: "אימות דו-שלבי" }).waitFor({ timeout: 15000 });
  check("U0 no approvals request at aal1", reqs.ownerAccess === 0);
  const inConsole = await totpInto(
    page,
    poApi.secret,
    page.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }),
  );
  check("U1 password + TOTP -> console", inConsole);
  await page.getByText("טרם אושרו בעלים").waitFor({ timeout: 10000 });
  check("U2 approvals list: explicit empty state", reqs.ownerAccess >= 1);
  await shot(page, "01-console-empty-390");

  section("APPROVE -> LIST; DUPLICATE / FOREIGN / LEFTOVER ACCOUNT");
  await approveViaUi("בעלים ראשון", email("eo1"));
  await page.getByText("הבעלים אושר").waitFor({ timeout: 15000 });
  const link1 = await ltrLinkIn(page, "/election-day/owner-set-password");
  check(
    "U3 approval -> one-time link on the Election Owner screen",
    link1.startsWith(`${EBASE}/election-day/owner-set-password?`),
  );
  await row(email("eo1")).waitFor({ timeout: 10000 });
  check(
    "U3 the list refetched and shows the approval as pending",
    (await row(email("eo1")).innerText()).includes("ממתינה להרשמה"),
  );
  await shot(page, "02-approved-390");

  await page.getByRole("button", { name: "אישור בעלים נוסף" }).click();
  check(
    "U4 'approve another' resets the form",
    (await approvalForm().getByLabel("אימייל").inputValue()) === "",
  );
  await approveViaUi("כפול", email("eo1").toUpperCase());
  await page.getByText("כבר קיימת הרשאת בעלים").waitFor({ timeout: 10000 });
  check(
    "U4 same address -> 'approval exists, re-issue from the list' (no false promise)",
    (await usersWith(email("eo1"))).length === 1,
  );

  await approveViaUi("זר", email("foreign"));
  await page.getByText("כבר משויכת לחשבון קיים").waitFor({ timeout: 10000 });
  check(
    "U5 existing foreign account -> refused, no approval created",
    !(await bodyText()).includes(email("foreign")) ||
      (await row(email("foreign")).count()) === 0,
  );

  setFaults({
    rpc: {
      platform_create_pending_owner_access: () => ({
        data: null,
        error: { message: "injected" },
      }),
    },
    admin: {
      deleteUser: () => ({
        data: null,
        error: { status: 500, code: "unexpected_failure", message: "injected" },
      }),
    },
  });
  await approveViaUi("שארית", email("leftover"));
  await page
    .getByText("לא ניתן היה לאמת שחשבון ההתחברות שנוצר נמחק")
    .waitFor({ timeout: 10000 });
  clearFaults();
  const leftover = await usersWith(email("leftover"));
  check(
    "U6 unconfirmed cleanup is shown explicitly, with the account id",
    leftover.length === 1 && (await bodyText()).includes(leftover[0].id),
  );
  await approveViaUi("שארית", email("leftover"));
  await page.getByText("הבעלים אושר").waitFor({ timeout: 15000 });
  const afterAdopt = await usersWith(email("leftover"));
  check(
    "U6 re-approving the address re-uses that account (still exactly one)",
    afterAdopt.length === 1 && afterAdopt[0].id === leftover[0].id,
  );
  await page.getByRole("button", { name: "אישור בעלים נוסף" }).click();

  section("RE-ISSUE (active) -> RENEW (expired) -> CONSUMED is read-only");
  const reissueBefore = reqs.reissue;
  await row(email("eo1")).getByRole("button", { name: "הפקת קישור חדש" }).click();
  await page.getByRole("dialog").getByText("קישור שנמסר קודם יפסיק לעבוד").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
  check(
    "U7 Escape cancels the confirmation - nothing sent",
    reqs.reissue === reissueBefore,
  );
  await row(email("eo1")).getByRole("button", { name: "הפקת קישור חדש" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "הפקת קישור" }).click();
  const issued = page.locator('[data-testid="owner-access-issued"]');
  await issued.waitFor({ timeout: 15000 });
  const link2 = await ltrLinkIn(issued, "/election-day/owner-set-password");
  check(
    "U8 re-issue -> a NEW link, shown once in the panel",
    link2 !== link1 && link2.startsWith(`${EBASE}/election-day/owner-set-password?`),
  );
  check("U8 the earlier link stopped working", !(await oldLinkWorks(link1)));
  await shot(page, "03-reissued-390");

  const eo1Pending = psql(
    `select id from public.election_workspace_pending_owner_access where email = '${email("eo1")}';`,
  );
  psql(
    `update public.election_workspace_pending_owner_access set expires_at = now() - interval '1 day' where id = '${eo1Pending}';`,
  );
  await page.reload();
  await row(email("eo1")).waitFor({ timeout: 15000 });
  check(
    "U9 expired approval is shown as expired, and the panel did not survive the reload",
    (await row(email("eo1")).innerText()).includes("פג תוקף") &&
      (await page.locator('[data-testid="owner-access-issued"]').count()) === 0,
  );
  await row(email("eo1")).getByRole("button", { name: "חידוש והפקת קישור" }).click();
  await page.getByRole("dialog").getByText("תחודש ל-7 ימים").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "הפקת קישור" }).click();
  await issued.getByText("ההרשאה חודשה ל-7 ימים.").waitFor({ timeout: 15000 });
  const link3 = await ltrLinkIn(issued, "/election-day/owner-set-password");
  await page.waitForFunction(
    (e) =>
      [...document.querySelectorAll('[data-testid="owner-access-list"] li')].some(
        (li) => li.textContent.includes(e) && li.textContent.includes("ממתינה להרשמה"),
      ),
    email("eo1"),
    { timeout: 10000 },
  );
  check("U9 renew -> new window + link; row back to pending", link3 !== link2);

  const co = await pPost({
    op: "create_owner_access",
    name: "בעלים שהשלים",
    email: email("eo-done"),
    modules: ["election_day"],
  });
  const doneUser = (await usersWith(email("eo-done")))[0];
  psql(`
    with w as (insert into public.election_workspaces (name, election_end_at, login_code)
               values ('S8UI מערכת שהושלמה', now() + interval '10 days', public.election_day_generate_workspace_login_code()) returning id)
    insert into public.election_owners (workspace_id, auth_user_id, name, email) select id, '${doneUser.id}', 'בעלים שהשלים', '${email("eo-done")}' from w;
    update public.election_workspace_pending_owner_access set status = 'consumed', consumed_at = now() where id = '${co.body?.pendingId}';
  `);
  await page.reload();
  await row(email("eo-done")).waitFor({ timeout: 15000 });
  const doneText = await row(email("eo-done")).innerText();
  check(
    "U10 consumed approval: 'completed', its workspace, and NO action",
    doneText.includes("הושלמה") &&
      doneText.includes("S8UI מערכת שהושלמה") &&
      (await row(email("eo-done")).getByRole("button").count()) === 0,
  );

  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  check(
    "U11 no one-time link / token_hash in browser storage",
    !stored.includes("token_hash") && !stored.includes("owner-set-password"),
  );

  for (const [w, h] of [
    [360, 780],
    [390, 844],
    [768, 1024],
    [1280, 900],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    await shot(page, `04-console-${w}`);
    check(
      `U12 console: no horizontal overflow at ${w}px`,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      )),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const unnamed = await page.evaluate(
    () =>
      [...document.querySelectorAll("button")].filter(
        (b) => !(b.getAttribute("aria-label") || b.textContent.trim()),
      ).length,
  );
  check(
    "U13 every console button has an accessible name",
    unnamed === 0,
    String(unnamed),
  );

  section("END-TO-END: the renewed link completes Election Owner onboarding");
  const ePage = await context.newPage();
  await ePage.goto(link3);
  await ePage.getByText("הגדרת סיסמה לחשבון הבעלים").waitFor({ timeout: 15000 });
  check(
    "E1 renewed link opens the Election Owner set-password form",
    !ePage.url().includes("token_hash"),
  );
  const eoPw = randomPassword();
  const pwInputs = ePage.locator('input[type="password"]');
  await pwInputs.nth(0).fill(eoPw);
  await pwInputs.nth(1).fill(eoPw);
  await ePage.getByRole("button", { name: "שמירת סיסמה" }).click();
  await ePage.getByText("הסיסמה נשמרה").waitFor({ timeout: 15000 });
  await ePage.getByRole("button", { name: "מעבר להתחברות" }).click();
  await ePage.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await ePage.locator('input[type="email"]').fill(email("eo1"));
  await ePage.locator('input[autocomplete="current-password"]').fill(eoPw);
  await ePage.getByRole("button", { name: "התחברות" }).click();
  const setupShown = await ePage
    .getByText("הקמת מערכת הבחירות")
    .first()
    .waitFor({ timeout: 20000 })
    .then(
      () => true,
      () => false,
    );
  await shot(ePage, "05-owner-setup-390");
  check(
    "E2 owner signs in and reaches workspace setup (approval is live again)",
    setupShown,
  );
  await ePage.close();

  section("MULTI-ENTITY MANAGEMENT - text, destination, form reset");
  await page.getByRole("button", { name: "פתיחת הניהול" }).click();
  await page
    .getByRole("heading", { name: "ניהול בעל רב-מערכות" })
    .waitFor({ timeout: 15000 });
  const meText = await bodyText();
  check(
    "M1 Stage 7 text is current (aggregate counts only) and the obsolete 'later stage' promise is gone",
    meText.includes("נתונים מצטברים בלבד") && !meText.includes("תתווסף בשלב מאוחר יותר"),
  );
  await page.getByRole("button", { name: "הקצאת בעל רב-מערכות" }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("שם מלא").fill("בעל רב-מערכות בדיקה");
  await dialog.getByLabel("אימייל").fill(email("me1"));
  await dialog.getByRole("button", { name: "הקצאת בעל רב-מערכות" }).click();
  await page.getByText("קישור לקביעת סיסמה").waitFor({ timeout: 15000 });
  const dest = await page.locator('[data-testid="multi-entity-destination"]').innerText();
  check(
    "M2 the password-link panel shows the real Multi-Entity sign-in address",
    dest.includes(`${MEBASE}/multi-entity/login`),
    dest.replace(/\s+/g, " "),
  );
  const closedAfterProvision = await page
    .getByRole("dialog")
    .waitFor({ state: "detached", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  check("M2 the modal closed on success", closedAfterProvision);
  await shot(page, "06-me-provisioned-390");

  await page.getByRole("button", { name: "החלפת בעל רב-מערכות" }).click();
  dialog = page.getByRole("dialog");
  check(
    "M3 re-opening after a success: every field empty, no error",
    (await dialog.getByLabel("שם מלא").inputValue()) === "" &&
      (await dialog.getByLabel("אימייל").inputValue()) === "" &&
      (await dialog.getByRole("alert").count()) === 0,
  );
  await dialog.getByLabel("שם מלא").fill("אותה כתובת");
  await dialog.getByLabel("אימייל").fill(email("me1"));
  await dialog.getByRole("button", { name: "החלפת בעל רב-מערכות" }).click();
  await page.getByRole("button", { name: "החלפה", exact: true }).click();
  await page.getByText("כבר משויכת לחשבון קיים").waitFor({ timeout: 15000 });
  check(
    "M4 a failed replacement keeps the modal open with the reason",
    (await page.getByRole("dialog").count()) === 1,
  );
  await page.getByRole("dialog").getByRole("button", { name: "סגירה" }).click();
  await page.getByRole("button", { name: "החלפת בעל רב-מערכות" }).click();
  dialog = page.getByRole("dialog");
  check(
    "M5 re-opening after a failure: no stale error, fields empty",
    (await dialog.getByRole("alert").count()) === 0 &&
      (await dialog.getByLabel("אימייל").inputValue()) === "",
  );
  await dialog.getByLabel("שם מלא").fill("מחליף");
  await dialog.getByLabel("אימייל").fill(email("me2"));
  await dialog.getByRole("button", { name: "החלפת בעל רב-מערכות" }).click();
  await page.getByRole("button", { name: "החלפה", exact: true }).click();
  await page.getByText("ההחלפה הושלמה").waitFor({ timeout: 15000 });
  const closedAfterReplace = await page
    .getByRole("dialog")
    .waitFor({ state: "detached", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  check("M6 the modal closed on a successful replacement", closedAfterReplace);
  await page.getByRole("button", { name: "החלפת בעל רב-מערכות" }).click();
  dialog = page.getByRole("dialog");
  check(
    "M6 re-opening after a successful replacement: fields empty",
    (await dialog.getByLabel("שם מלא").inputValue()) === "" &&
      (await dialog.getByRole("alert").count()) === 0,
  );
  await dialog.getByRole("button", { name: "סגירה" }).click();
  for (const [w, h] of [
    [360, 780],
    [1280, 900],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    await shot(page, `07-me-page-${w}`);
    check(
      `M7 Multi-Entity page: no horizontal overflow at ${w}px`,
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      )),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });

  section("LOGOUT");
  await page.getByRole("button", { name: "חזרה למסוף" }).click();
  await page.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }).waitFor();
  await page.getByRole("button", { name: "התנתקות" }).click();
  await page
    .getByRole("heading", { name: "כניסת בעל הפלטפורמה" })
    .waitFor({ timeout: 10000 });
  const afterLogout = reqs.ownerAccess;
  await page.goto(`${PBASE}/platform`);
  await page
    .getByRole("heading", { name: "כניסת בעל הפלטפורמה" })
    .waitFor({ timeout: 10000 });
  check(
    "L1 logout -> login; the console route stays behind the guard, no approvals request",
    reqs.ownerAccess === afterLogout,
  );

  section("MFA SETUP SIGN-OUT (a non-owner at aal1 is no longer stranded)");
  const sContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "he-IL",
  });
  const sPage = await sContext.newPage();
  await sPage.goto(`${PBASE}/platform/login`);
  await sPage.locator('input[type="email"]').fill(email("stranger"));
  await sPage.locator('input[autocomplete="current-password"]').fill(strangerPw);
  await sPage.getByRole("button", { name: "התחברות" }).click();
  await sPage
    .getByRole("heading", { name: "הגדרת אימות דו-שלבי" })
    .waitFor({ timeout: 15000 });
  await shot(sPage, "08-mfa-enroll-signout-390");
  await sPage.getByRole("button", { name: "התנתקות" }).click();
  await sPage
    .getByRole("heading", { name: "כניסת בעל הפלטפורמה" })
    .waitFor({ timeout: 10000 });
  const sKeys = await sPage.evaluate(() => Object.keys(localStorage));
  check(
    "S1 MFA setup offers sign-out and it clears the platform session",
    !sKeys.includes("kb-platform-owner-auth-token"),
    sKeys.join(","),
  );
  await sContext.close();

  check(
    "Z1 no uncaught page errors",
    pageErrors.length === 0,
    pageErrors.join(" | ").slice(0, 300),
  );
} catch (err) {
  check("SUITE aborted on an unexpected error", false, String(err).slice(0, 400));
  await shot(page, "zz-abort").catch(() => {});
} finally {
  clearFaults();
  await browser.close();
  pServer.close();
  eServer.close();
  psql(`
    delete from public.multi_entity_owner;
    delete from public.election_owners where email like '%@${DOMAIN}';
    delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
    delete from public.platform_owners;
    delete from public.election_workspaces where name like 'S8UI %';
  `);
  for (const u of await listUsers())
    if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

process.exit(tally("STAGE 8B UI") > 0 ? 1 : 0);
