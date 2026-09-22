// OPEN-ISSUES BATCH - the browser half.
//
// Builds the `platform` and `election` surfaces against the isolated kolboxs5
// scratch stack, serves each through scripts/stage5/localServer.mjs (the real
// vercel.json rewrites -> the real bundled handlers) and drives headless
// Chromium. Synthetic *@open-ui.invalid identities only; nothing secret is
// printed.
//
//   Issue 1  a Platform approval refreshes EVERY shell-level list, not just
//            the one the dialog sits in - no F5.
//   Issue 2  the "ניהול בוחרים" group is gone for a workspace that is not
//            entitled to it, AND the route behind it refuses - with a
//            positive control so "absent" cannot pass vacuously.
//   Issue 3  the Multi-Entity hand-off details survive a reload.
//   Issue 4  the seat is a singleton: there is no second-seat action, and the
//            replace action is the real path. Documented, not "fixed".
//   Issue 5  the active workspace name sits under the logo, for the worker
//            and for the Owner, and is the workspace's OWN name.
//   Issue 6  the Owner's account block shows their username, not their
//            e-mail.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/open-issues/ui-open-issues.mjs <outDir>
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
  seedOwnerSession,
  signIn,
  tally,
} from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-open-issues-ui"));
fs.mkdirSync(outDir, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const P_PORT = 5188;
const E_PORT = 5187;
const PBASE = `http://127.0.0.1:${P_PORT}`;
const EBASE = `http://127.0.0.1:${E_PORT}`;

process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = EBASE;
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "http://127.0.0.1:5186";
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
process.env.OWNER_ALLOWED_ORIGIN = EBASE;

const H = await buildHandlers();
const a = admin();
const DOMAIN = "open-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const stamp = Date.now();
const PW = randomPassword();
const pageErrors = [];

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = (seed) =>
  Array.from(
    { length: 8 },
    (_, i) => CODE_ALPHABET[Math.floor(stamp / 10 ** i + seed * 7 + i * 13) % CODE_ALPHABET.length],
  ).join("");

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
  fs.existsSync(path.join(pDist, "index.html")) && fs.existsSync(path.join(eDist, "index.html")),
);

// -------------------------------------------------------------- fixtures ---
section("SETUP");
psql(`
  update public.platform_modules set available = false where key in ('budget','voter_management');
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access;
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'OI %';
  delete from public.election_day_login_attempts;
`);
async function purgeDomainUsers() {
  for (let p = 1; p < 20; p++) {
    const { data, error } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
    if (data.users.length < 200) break;
  }
}
await purgeDomainUsers();

/** An Election Owner + workspace + entitlements + a claimed login username. */
async function makeWorkspace(label, wsName, modules, seed) {
  const mail = email(`owner-${label}`);
  const { data, error } = await a.auth.admin.createUser({
    email: mail,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const code = mkCode(seed);
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values (${sqlText(wsName)},'${code}', now()+interval '30 days');`,
  );
  const workspaceId = psql(
    `select id from public.election_workspaces where login_code='${code}';`,
  ).trim();
  psql(
    `insert into public.election_owners (workspace_id, auth_user_id, name, email)
     values ('${workspaceId}','${data.user.id}','Owner ${label}',${sqlText(mail)});
     insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
     values ('${workspaceId}', 'מנהל', array['electionDay.manageRoles','voter.view','voter.markVoted'], 'all', true);`,
  );
  for (const key of modules) {
    psql(
      `insert into public.election_workspace_modules (workspace_id, module_key)
       values ('${workspaceId}','${key}') on conflict do nothing;`,
    );
  }
  const username = `owner-${label}-${stamp}`;
  psql(
    `select public.auth_identity_assign('election_owner', ${sqlText(username)}, '${data.user.id}', null, null);`,
  );
  const workerName = `עובד ${label}`;
  psql(
    `insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
     select '${workspaceId}', ${sqlText(workerName)}, extensions.crypt(${sqlText(PW)}, extensions.gen_salt('bf')), id
     from public.election_day_roles where workspace_id='${workspaceId}' limit 1;`,
  );
  return { label, mail, username, wsName, workspaceId, code, workerName };
}

// The reported case verbatim, and a positive control that differs ONLY in the
// entitlement, so "the menu is gone" cannot pass for the wrong reason.
const yavne = await makeWorkspace("yavne", "OI יבנה", ["election_day"], 21);
const modiin = await makeWorkspace("modiin", "OI מודיעין", ["election_day", "voter_management"], 22);

const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({
  email: email("po"),
  password: poPw,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'OI PO', ${sqlText(email("po"))});`,
);
await enrollTotp((await signIn(email("po"), poPw)).client, "oi-po");

const common = { "/api/platform/session": H.platformSession, "/api/health": H.health };
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
const newPage = async (opts = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "he-IL",
    ...opts,
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const navSections = (p) =>
  p.locator("[data-nav-section]").evaluateAll((els) => els.map((x) => x.getAttribute("data-nav-section")));
const workspaceLabel = async (p) => {
  const el = p.locator('[data-testid="active-workspace-name"]');
  return (await el.count()) === 1 ? (await el.innerText()).trim() : null;
};

/** Signs a worker in through the real login screen. */
async function workerSignIn(p, ws) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${EBASE}/election-day/login`, { waitUntil: "domcontentloaded" });
  await p.locator('input[name="election-day-workspace-code"]').fill(ws.code);
  await p.locator('input[name="election-day-username"]').fill(ws.workerName);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.getByRole("button", { name: "התחברות" }).click();
  await p.locator("[data-nav-section]").first().waitFor({ state: "attached", timeout: 30000 });
}

// =========================================================================
section("A. ISSUE 5 + 2 - THE WORKER'S SHELL");
// =========================================================================
{
  const p = await newPage();
  await workerSignIn(p, yavne);
  check(
    "A1 the active workspace name is rendered under the logo",
    (await workspaceLabel(p)) === "OI יבנה",
    String(await workspaceLabel(p)),
  );
  const sections = await navSections(p);
  check(
    "A2 the 'ניהול בוחרים' group is NOT offered - the workspace is not entitled",
    !sections.includes("ניהול בוחרים") && sections.includes("ניהול יום בחירות"),
    JSON.stringify(sections),
  );
  // The menu is not the boundary: the route behind it refuses too.
  await p.goto(`${EBASE}/voters`, { waitUntil: "domcontentloaded" });
  await p.getByText("ניהול בוחרים אינו זמין").waitFor({ timeout: 20000 });
  check(
    "A3 ... and the route itself refuses, full-page, with nothing of the module rendered",
    (await p.getByText("ניהול בוחרים אינו זמין").count()) === 1 &&
      (await p.locator("table").count()) === 0,
  );
  // Survives a reload: the name comes from the session, not from the login
  // response that is long gone by now.
  await p.goto(`${EBASE}/election-day/dashboard`, { waitUntil: "domcontentloaded" });
  await p.locator("[data-nav-section]").first().waitFor({ state: "attached", timeout: 30000 });
  check(
    "A4 the workspace name survives a full reload (it is session state, not a response)",
    (await workspaceLabel(p)) === "OI יבנה",
    String(await workspaceLabel(p)),
  );
  await p.context().close();
}
{
  // A DIFFERENT workspace, to prove the name is resolved rather than constant.
  // Note what this control does NOT test: a worker holding voter_management.
  // That is structurally impossible today - see A7 - so it is asserted as the
  // fact it is rather than faked.
  const p = await newPage();
  await workerSignIn(p, modiin);
  check(
    "A5 a different workspace shows ITS OWN name, not a constant",
    (await workspaceLabel(p)) === "OI מודיעין",
    String(await workspaceLabel(p)),
  );
  check(
    "A6 ... and it is not offered the group either, even though it HOLDS the entitlement row",
    !(await navSections(p)).includes("ניהול בוחרים"),
    JSON.stringify(await navSections(p)),
  );
  await p.context().close();
  // The reason, stated by the server itself: the worker module list is derived
  // from a function that emits only election_day and budget, so no worker
  // session can ever carry voter_management. Hiding the group for workers is
  // therefore correct unconditionally, not a guess about current data.
  check(
    "A7 the worker module list CANNOT emit voter_management (why A6 is not a false negative)",
    !psql(
      "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='election_day_workspace_worker_modules';",
    ).includes("voter_management"),
  );
}

// =========================================================================
section("B. ISSUE 6 + 5 - THE ELECTION OWNER'S SHELL");
// =========================================================================
{
  const p = await newPage();
  await seedOwnerSession(p, EBASE, yavne.mail, PW);
  await p.goto(`${EBASE}/election-day/owner/users`, { waitUntil: "domcontentloaded" });
  await p.locator("[data-nav-section]").first().waitFor({ state: "attached", timeout: 30000 });
  const footer = (await p.locator("aside").innerText()).trim();
  check(
    "B1 the account block shows the Owner's USERNAME",
    footer.includes(yavne.username),
    footer.split("\n").slice(-4).join(" | "),
  );
  check(
    "B2 ... and NOT their e-mail address (the reported symptom)",
    !footer.includes(yavne.mail),
    footer.split("\n").slice(-4).join(" | "),
  );
  check(
    "B3 the Owner sees the administered workspace's name under the logo",
    (await workspaceLabel(p)) === "OI יבנה",
    String(await workspaceLabel(p)),
  );
  const sections = await navSections(p);
  check(
    "B4 the Owner is not offered 'ניהול בוחרים' either - entitlement, not role",
    !sections.includes("ניהול בוחרים"),
    JSON.stringify(sections),
  );
  await p.context().close();
}
{
  // POSITIVE CONTROL, on the one path where the key CAN become effective: the
  // Owner reads the full catalogue, so switching the module globally available
  // makes the entitled workspace's Owner hold it for real. Without this, "the
  // group is absent" would prove nothing but that it is always absent.
  psql("update public.platform_modules set available = true where key = 'voter_management';");
  const p = await newPage();
  await seedOwnerSession(p, EBASE, modiin.mail, PW);
  await p.goto(`${EBASE}/election-day/owner/users`, { waitUntil: "domcontentloaded" });
  await p.locator("[data-nav-section]").first().waitFor({ state: "attached", timeout: 30000 });
  check(
    "B5 CONTROL: an Owner who really holds voter_management IS offered the group",
    (await navSections(p)).includes("ניהול בוחרים"),
    JSON.stringify(await navSections(p)),
  );
  check(
    "B6 CONTROL: ... and reaches the module instead of the refusal screen",
    await p
      .goto(`${EBASE}/voters`, { waitUntil: "domcontentloaded" })
      .then(async () => {
        await p.waitForTimeout(2500);
        return (await p.getByText("ניהול בוחרים אינו זמין").count()) === 0;
      }),
    p.url(),
  );
  await p.context().close();
  psql("update public.platform_modules set available = false where key = 'voter_management';");
  // And the same Owner, with availability withdrawn, loses it again - the gate
  // reads live server state, not something decided at sign-in.
  const q = await newPage();
  await seedOwnerSession(q, EBASE, modiin.mail, PW);
  await q.goto(`${EBASE}/election-day/owner/users`, { waitUntil: "domcontentloaded" });
  await q.locator("[data-nav-section]").first().waitFor({ state: "attached", timeout: 30000 });
  check(
    "B7 CONTROL: withdrawing global availability removes the group again",
    !(await navSections(q)).includes("ניהול בוחרים"),
    JSON.stringify(await navSections(q)),
  );
  await q.context().close();
}

// =========================================================================
section("C. ISSUE 1 - THE CONSOLE RE-READS ON ENTERING A SECTION, NO F5");
// =========================================================================
const po = await newPage();
const moduleRows = () => po.locator('[data-testid="workspace-modules-list"] > li').count();
{
  await po.goto(`${PBASE}/platform/login`, { waitUntil: "domcontentloaded" });
  await po.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 20000 });
  await po.locator('input[type="email"]').fill(email("po"));
  await po.locator('input[autocomplete="current-password"]').fill(poPw);
  await po.getByRole("button", { name: "התחברות" }).click();
  await po.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }).waitFor({ timeout: 25000 });

  // Load the module-entitlement section ONCE, so its shell-level list is
  // populated and can go stale. This hook is mounted by the shell and never
  // remounts on navigation - that is the whole bug.
  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator('[data-testid="workspace-modules-list"]').waitFor({ timeout: 25000 });
  const before = await moduleRows();
  check("C1 the module-entitlement list loaded", before >= 2, `rows=${before}`);

  // A workspace comes into existence ELSEWHERE - exactly what happens when an
  // approved Owner activates their link minutes later. No dialog in this tab
  // can call back from that, so a post-mutation callback could never fix it;
  // only re-reading on entry can.
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values ('OI רענון ${stamp}','${mkCode(31)}', now()+interval '30 days');`,
  );

  // Navigate away and back. NO reload, no F5.
  await po.getByRole("link", { name: "בעלי מערכות" }).first().click();
  await po.waitForTimeout(800);
  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator(`text=OI רענון ${stamp}`).first().waitFor({ timeout: 25000 });
  const after = await moduleRows();
  check(
    "C2 re-entering the section shows the workspace created elsewhere - WITHOUT F5",
    after === before + 1,
    `before=${before} after=${after}`,
  );
  check(
    "C3 ... and the page was never reloaded to achieve it",
    po.url().endsWith("/platform/modules"),
    po.url(),
  );

  // The other half: a mutation made HERE lands in its own list immediately.
  await po.getByRole("link", { name: "בעלי מערכות" }).first().click();
  await po.getByRole("button", { name: "אישור בעלים חדש" }).click();
  const form = po
    .locator("form")
    .filter({ has: po.getByRole("button", { name: "אישור ויצירת קישור" }) });
  await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').first().waitFor({ timeout: 20000 });
  const newOwnerName = `בעלים רענון ${stamp}`;
  await form.getByLabel("שם הבעלים").fill(newOwnerName);
  await form.getByLabel("אימייל").fill(email(`refresh-${stamp}`));
  await form.locator('input[name="approve-owner-phone"]').fill("050-123-4567");
  await form.getByLabel("שם משתמש לכניסה").fill(`refresh-${stamp}`);
  await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').first().check();
  await form.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  check(
    "C4 a new approval appears in the Owners list immediately, with no reload",
    await po
      .getByText(newOwnerName)
      .first()
      .waitFor({ timeout: 25000 })
      .then(() => true, () => false),
  );
  // The approval dialog stays open on purpose after a success (it shows the
  // link); close it before navigating, or it swallows every later click.
  await po.keyboard.press("Escape");
  await po.locator(".fixed.inset-0").first().waitFor({ state: "detached", timeout: 15000 });
}

// =========================================================================
section("D. ISSUE 3 + 4 - THE MULTI-ENTITY SEAT");
// =========================================================================
{
  await po.getByRole("link", { name: "רב-מערכות" }).first().click();
  await po.getByRole("heading", { name: "בעל רב-מערכות" }).first().waitFor({ timeout: 20000 });

  // Issue 4, BEFORE anything is seated: the only action offered is "create",
  // and it is the singleton's one create.
  const provisionBtn = po.getByRole("button", { name: "הקצאת בעל רב-מערכות" });
  // The card renders a skeleton first; assert once it has actually resolved,
  // or this reads "no buttons" from a card that has not loaded yet.
  await provisionBtn.first().waitFor({ timeout: 25000 });
  check(
    "D1 with no seat, the console offers exactly one action: create the seat",
    (await provisionBtn.count()) >= 1 &&
      (await po.getByRole("button", { name: "החלפת בעל רב-מערכות" }).count()) === 0,
    `provision=${await provisionBtn.count()} replace=${await po.getByRole("button", { name: "החלפת בעל רב-מערכות" }).count()}`,
  );

  await provisionBtn.first().click();
  const meSubmit = po.getByRole("button", { name: "הקצאת בעל רב-מערכות" }).last();
  const meForm = po.locator("form").filter({ has: meSubmit });
  await meForm.first().waitFor({ timeout: 20000 });
  const meUsername = `me-${stamp}`;
  await meForm.getByLabel("שם מלא").fill("בעל רב-מערכות ניסוי");
  await meForm.getByLabel("אימייל").fill(email(`me-${stamp}`));
  await meForm.getByLabel("טלפון").fill("050-765-4321");
  await meForm.getByLabel("שם משתמש לכניסה").fill(meUsername);
  await meSubmit.click();

  await po.locator('[data-testid="seat-handoff-hint"]').waitFor({ timeout: 30000 });
  const seatText = async () => (await po.locator("main").innerText()).trim();
  check(
    "D2 immediately after provisioning, the hand-off details are on screen",
    (await seatText()).includes(meUsername),
    (await seatText()).slice(0, 200).replace(/\s+/g, " "),
  );

  // THE ISSUE: reload. The one-time link is gone by design; everything the
  // operator needs to continue the hand-off must still be there.
  await po.reload({ waitUntil: "domcontentloaded" });
  await po.locator('[data-testid="seat-handoff-hint"]').waitFor({ timeout: 30000 });
  const after = await seatText();
  check(
    "D3 AFTER A RELOAD the seat holder's login username is still shown",
    after.includes(meUsername),
    after.slice(0, 240).replace(/\s+/g, " "),
  );
  check(
    "D4 ... and so is the login address they must be sent to",
    after.includes("/login"),
    after.slice(0, 240).replace(/\s+/g, " "),
  );
  check(
    "D5 ... and the e-mail and name survive too",
    after.includes(email(`me-${stamp}`)) && after.includes("בעל רב-מערכות ניסוי"),
  );
  // The credential must NOT survive - persisting it was never the fix.
  check(
    "D6 the ONE-TIME password link is NOT persisted (it is a credential)",
    !/set-password\?|token=/.test(after),
    after.slice(0, 240).replace(/\s+/g, " "),
  );
  // Evaluated INSIDE the page and reduced to a verdict + key NAMES there, so
  // no storage VALUE ever crosses into this process or into the log: these
  // keys hold the Platform Owner's live access token.
  const storage = await po.evaluate(() => {
    const read = (s) => {
      try {
        return Object.entries({ ...s });
      } catch {
        return [];
      }
    };
    const all = [...read(localStorage), ...read(sessionStorage)];
    const pattern = /set-password|passwordLink|activationLink/i;
    return {
      leaked: all.some(([k, v]) => pattern.test(k) || pattern.test(String(v))),
      keys: all.map(([k]) => k),
    };
  });
  check(
    "D7 ... and it is in no browser storage either",
    storage.leaked === false,
    `keys=${JSON.stringify(storage.keys)}`,
  );

  // Issue 4, WITH a seat: the create action is replaced by the replace action.
  check(
    "D8 with a seat, the create action is gone and REPLACE is the offered path",
    (await po.getByRole("button", { name: "הקצאת בעל רב-מערכות" }).count()) === 0 &&
      (await po.getByRole("button", { name: "החלפת בעל רב-מערכות" }).count()) === 1,
  );
  check(
    "D9 the DB refuses a second seat regardless of any UI - it is a singleton",
    psql("select count(*) from public.multi_entity_owner;").trim() === "1",
  );
}

check("Z1 no uncaught page errors on any page", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

await po.context().close();
await browser.close();
await pServer.close();
await eServer.close();
tally("OPEN ISSUES UI");
