// Platform Stage 5 - REAL-LOCAL UI suite for the `multi_entity` surface.
//
// Builds the multi_entity surface against the isolated kolboxs5 scratch stack,
// serves it with localServer.mjs (vercel.json rewrites -> real handlers), and
// drives it in headless Chromium: one-time link -> set password -> login ->
// TOTP enrollment -> assigned-workspace home -> freshness -> replacement ->
// forbidden -> logout, plus the aal1 guard-bypass and foreign-route checks.
// Screenshots at 360/390/768/1280 are written to <outDir>/screens.
//
// Run:  S5_STACK_DIR=<scratch>/s5stack node scripts/stage5/ui-real-local.mjs <outDir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "./buildHandlers.mjs";
import { startLocalServer } from "./localServer.mjs";
import {
  admin,
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
} from "./lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-stage5-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const handlers = await buildHandlers();
const a = admin();
const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "stage5-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;

section("BUILD multi_entity surface against the scratch stack");
const distDir = path.join(outDir, "dist-multi_entity");
execFileSync(
  process.execPath,
  [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", distDir, "--emptyOutDir", "--logLevel", "error"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      VITE_APP_SURFACE: "multi_entity",
      VITE_SUPABASE_URL: stackEnv.API_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
check("B1 multi_entity bundle built", fs.existsSync(path.join(distDir, "index.html")));

section("SETUP");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S5UI %';
`);
{
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'S5 UI PO', '${email("po")}');`);
const poS = await signIn(email("po"), poPw);
const PO = (await enrollTotp(poS.client, "s5-ui-po")).token;
const ws = psql(`
  insert into public.election_workspaces (name, election_end_at, login_code) values
    ('S5UI מערכת ירושלים', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
    ('S5UI מערכת חיפה',    now() + interval '20 days', public.election_day_generate_workspace_login_code())
  returning id;
`).split("\n");

const pPost = (body) =>
  callHandler(handlers.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: { authorization: `Bearer ${PO}`, origin: "http://localhost:5173" },
    body,
  });

process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = BASE;
const prov = await pPost({ op: "provision_multi_entity_owner", name: "בעל רב-מערכות בדיקה", email: email("me") });
const link = prov.body?.activationLink ?? "";
check("S1 provisioning returned a link on the Multi-Entity origin", link.startsWith(`${BASE}/multi-entity/set-password?`));

const server = await startLocalServer({
  distDir,
  port: PORT,
  handlers: { "/api/platform/session": handlers.platformSession, "/api/health": handlers.health },
});
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
const page = await context.newPage();
const sessionCalls = [];
page.on("request", (req) => {
  if (req.url().includes("/api/multi-entity/session")) sessionCalls.push(Date.now());
});
const shot = async (name) => page.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const text = async () => page.locator("body").innerText();

try {
  section("SET PASSWORD (one-time link)");
  await page.goto(link);
  await page.getByText("קביעת סיסמה", { exact: true }).waitFor({ timeout: 15000 });
  check("U1 set-password form renders from the one-time link", true);
  check("U1 token_hash stripped from the address bar", !page.url().includes("token_hash") && !page.url().includes("type="));
  await shot("01-set-password-390");
  const mePw = randomPassword();
  const pwInputs = page.locator('input[autocomplete="new-password"]');
  await pwInputs.nth(0).fill(mePw);
  await pwInputs.nth(1).fill(mePw);
  await page.getByRole("button", { name: "שמירת הסיסמה" }).click();
  await page.getByText("הסיסמה נשמרה").waitFor({ timeout: 15000 });
  check("U2 password saved -> success screen", true);
  const keysAfterSet = await page.evaluate(() => Object.keys(localStorage));
  check("U2 recovery session signed out (no ME session left in storage)", !keysAfterSet.includes("kb-multi-entity-owner-auth-token"), keysAfterSet.join(","));

  section("LOGIN -> aal1 -> TOTP ENROLL (guard + no privileged call at aal1)");
  await page.getByRole("button", { name: "המשך למסך הכניסה" }).click();
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor();
  await shot("02-login-390");
  await page.locator('input[type="email"]').fill(email("me"));
  await page.locator('input[autocomplete="current-password"]').fill(mePw);
  await page.getByRole("button", { name: "התחברות" }).click();
  await page.getByText("הגדרת אימות דו-שלבי").waitFor({ timeout: 15000 });
  await page.locator('[data-testid="mfa-secret"]').waitFor();
  check("U3 aal1 session is diverted to TOTP enrollment", true);
  await page.goto(`${BASE}/multi-entity`);
  await page.getByText("הגדרת אימות דו-שלבי").waitFor({ timeout: 15000 });
  check("U4 direct navigation at aal1 still shows MFA (guard bypass refused)", !(await text()).includes("המערכות שלי"));
  check("U4 ZERO calls to /api/multi-entity/session while at aal1", sessionCalls.length === 0, `calls=${sessionCalls.length}`);
  const keysAal1 = await page.evaluate(() => Object.keys(localStorage));
  check("U5 only the Multi-Entity storage key holds a session", keysAal1.includes("kb-multi-entity-owner-auth-token") && !keysAal1.includes("kb-platform-owner-auth-token") && !keysAal1.includes("kb-owner-auth-token"), keysAal1.join(","));
  await shot("03-mfa-enroll-390");

  const secret = (await page.locator('[data-testid="mfa-secret"]').innerText()).trim();
  let enrolled = false;
  for (let attempt = 0; attempt < 3 && !enrolled; attempt++) {
    await page.locator('input[autocomplete="one-time-code"]').fill(totp(secret, Date.now() + attempt * 30000));
    await page.getByRole("button", { name: "אימות" }).click();
    enrolled = await page
      .getByRole("heading", { name: "המערכות שלי" })
      .waitFor({ timeout: 8000 })
      .then(() => true, () => false);
    if (!enrolled) await sleep(1000);
  }
  check("U6 TOTP verified -> server 200 -> authorized home", enrolled);
  check("U6 privileged call happened only after aal2", sessionCalls.length >= 1);
  // Since Stage 7 the empty state renders only after the aggregate read
  // returns, so wait for it rather than reading the page the instant the
  // heading appears (same assertion, no longer timing-dependent).
  const emptyShown = await page
    .getByText("אין מערכות משויכות")
    .waitFor({ timeout: 10000 })
    .then(() => true, () => false);
  check("U7 zero assignments -> explicit empty state", emptyShown);
  await shot("04-home-empty-390");

  section("ENTITY SCOPE + FRESHNESS");
  await pPost({ op: "assign_workspace", workspaceId: ws[0] });
  await pPost({ op: "assign_workspace", workspaceId: ws[1] });
  await page.getByRole("button", { name: /רענון/ }).click();
  await page.locator('[data-testid="workspace-list"] li').nth(1).waitFor({ timeout: 10000 });
  check("U8 refresh shows both newly assigned workspaces", (await page.locator('[data-testid="workspace-list"] li').count()) === 2);
  for (const [w, h] of [[360, 780], [390, 844], [768, 1024], [1280, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    await shot(`05-home-list-${w}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(`U9 no horizontal overflow at ${w}px`, !overflow);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await pPost({ op: "unassign_workspace", workspaceId: ws[0] });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-list"] li').length === 1, null, { timeout: 10000 });
  check("U10 unassignment reflected when the tab becomes visible again", true);

  section("SEAT REPLACEMENT -> FORBIDDEN -> LOGOUT");
  const rep = await pPost({ op: "provision_multi_entity_owner", name: "מחליף", email: email("me2") });
  check("U11 seat replaced", rep.statusCode === 201 && rep.body?.replaced === true);
  await page.getByRole("button", { name: /רענון/ }).click();
  await page.getByText("אין הרשאת גישה").waitFor({ timeout: 10000 });
  check("U11 replaced holder lands on the forbidden screen", !(await text()).includes("המערכות שלי"));
  await shot("06-forbidden-390");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 10000 });
  const keysOut = await page.evaluate(() => Object.keys(localStorage));
  check("U12 logout clears the Multi-Entity session", !keysOut.includes("kb-multi-entity-owner-auth-token"));

  section("INVALID LINKS + FOREIGN ROUTES ON THIS ORIGIN");
  await page.goto(`${BASE}/multi-entity/set-password?token_hash=bogus&type=recovery`);
  await page.getByText("הקישור אינו תקף").waitFor({ timeout: 10000 });
  check("U13 forged token -> invalid-link screen (and stripped)", !page.url().includes("token_hash"));
  await page.goto(`${BASE}/multi-entity/set-password`);
  await page.getByText("הקישור אינו תקף").waitFor({ timeout: 10000 });
  check("U14 no link in this page load -> invalid (storage is not evidence)", true);
  await shot("07-invalid-link-390");
  for (const foreign of ["/platform/login", "/election-day/login", "/election-day/owner-login", "/login"]) {
    await page.goto(`${BASE}${foreign}`);
    await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 10000 });
    const t = await text();
    check(`U15 ${foreign} never renders a foreign login form here`, !t.includes("כניסת בעל הפלטפורמה") && !t.includes("כניסה למערכת הבחירות") && !t.includes("כניסת בעלים"));
  }
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("U16 /api/health through the rewrite table", health.ok === true);
  const r = await fetch(`${BASE}/api/multi-entity/workspace?workspaceId=not-a-uuid`);
  check("U17 /api/multi-entity/workspace rewrite forwards the caller's query (400 pre-auth)", r.status === 400);
  const r2 = await fetch(`${BASE}/api/multi-entity/session`);
  check("U17 /api/multi-entity/session rewrite reaches the ME partition (401 + no-store)", r2.status === 401 && r2.headers.get("cache-control") === "no-store");
} catch (err) {
  // An aborted run must still end in a counted FAIL, never a silent crash.
  check("UI suite aborted", false, String(err?.message ?? err).split("\n")[0]);
  await shot("99-aborted").catch(() => {});
} finally {
  await browser.close();
  server.close();
  delete process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL;
}

console.log(`\nscreenshots: ${screens}`);
process.exitCode = tally("UI-REAL-LOCAL") === 0 ? 0 : 1;
