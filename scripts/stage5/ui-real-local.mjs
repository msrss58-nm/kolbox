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
  seedMultiEntitySession,
  signIn,
  sleep,
  tally,
  totp,
} from "./lib.mjs";

/** Unified identity: provisioning now claims a LOGIN username. */
let __uSeq = 0;
const suiteUsername = () => `suite me ${Date.now().toString(36)} ${++__uSeq}`;


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
const prov = await pPost({ op: "provision_multi_entity_owner", phone: "0501234567", name: "בעל רב-מערכות בדיקה", email: email("me") , username: suiteUsername() });
// 20260926000000: assignment names its owner, and replacement names the owner
// row being handed over (omitting it would ADD a second owner instead).
const OWNER_ID = prov.body?.ownerId;
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

  section("SIGN IN (username + password only - this realm has no second factor)");
  // The per-origin login was retired and the second factor removed for this
  // realm (2026-09-24): an owner signs in with a USERNAME on the shared login,
  // which lives on the auth deployment and cannot run in a single-surface
  // suite. A REAL session is seeded instead - the same state that screen would
  // leave - so the guard and every server call behave exactly as for a human.
  await page.goto(`${BASE}/multi-entity`);
  await page.waitForURL(/\/multi-entity\/login$/, { timeout: 20000 });
  check("U3 signed out -> the login route, and it renders no credential field of its own",
    (await page.locator('input[type="email"]').count()) === 0 &&
      (await page.locator('input[type="password"]').count()) === 0);
  check("U3b no MFA screen exists for this realm any more", !(await text()).includes("אימות דו-שלבי"));
  check("U4 ZERO calls to /api/multi-entity/session while signed out", sessionCalls.length === 0, `calls=${sessionCalls.length}`);

  await seedMultiEntitySession(page, BASE, email("me"), mePw);
  await page.goto(`${BASE}/multi-entity`);
  const enrolled = await page
    .getByRole("heading", { name: "המערכות שלי" })
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  const keysAal1 = await page.evaluate(() => Object.keys(localStorage));
  check("U5 only the Multi-Entity storage key holds a session", keysAal1.includes("kb-multi-entity-owner-auth-token") && !keysAal1.includes("kb-platform-owner-auth-token") && !keysAal1.includes("kb-owner-auth-token"), keysAal1.join(","));
  await shot("03-signed-in-390");
  check("U6 password alone -> server 200 -> authorized home", enrolled);
  check("U6 the privileged call happened once authorized", sessionCalls.length >= 1);
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
  await pPost({ op: "assign_workspace", ownerId: OWNER_ID, workspaceId: ws[0] });
  await pPost({ op: "assign_workspace", ownerId: OWNER_ID, workspaceId: ws[1] });
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
  await pPost({ op: "unassign_workspace", ownerId: OWNER_ID, workspaceId: ws[0] });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="workspace-list"] li').length === 1, null, { timeout: 10000 });
  check("U10 unassignment reflected when the tab becomes visible again", true);

  section("SEAT REPLACEMENT -> FORBIDDEN -> LOGOUT");
  const rep = await pPost({ op: "provision_multi_entity_owner", ownerId: OWNER_ID, phone: "0501234567", name: "מחליף", email: email("me2") , username: suiteUsername() });
  check("U11 seat replaced", rep.statusCode === 201 && rep.body?.replaced === true);
  await page.getByRole("button", { name: /רענון/ }).click();
  await page.getByText("אין הרשאת גישה").waitFor({ timeout: 10000 });
  check("U11 replaced holder lands on the forbidden screen", !(await text()).includes("המערכות שלי"));
  await shot("06-forbidden-390");
  await page.getByRole("button", { name: "התנתקות" }).click();
  // The login ROUTE is the destination now; its screen is the bounce to the
  // shared login, so the URL is what to wait on.
  await page.waitForURL(/\/multi-entity\/login$/, { timeout: 15000 });
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
  // This surface's own login route is a bounce now, so a foreign path no
  // longer lands on a Multi-Entity login FORM - it lands on something that
  // renders no credential field at all. That is the claim: this origin hosts
  // nobody else's login, and after the cutover it hosts no form of its own.
  await page.route("https://kolbox-auth.vercel.app/**", (route) => route.fulfill({ status: 204 }));
  for (const foreign of ["/platform/login", "/election-day/login", "/election-day/owner-login", "/login"]) {
    await page.goto(`${BASE}${foreign}`);
    await page.waitForTimeout(500);
    const t = await text();
    check(`U15 ${foreign} never renders a foreign login form here`,
      !t.includes("כניסת בעל הפלטפורמה") && !t.includes("כניסה למערכת הבחירות") && !t.includes("כניסת בעלים") &&
        (await page.locator('input[type="email"]').count()) === 0 &&
        (await page.locator('input[type="password"]').count()) === 0);
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
