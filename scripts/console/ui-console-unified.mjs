// CONSOLE CONSOLIDATION - "בעלי מערכות" folded into "מערכות בחירות".
//
// Builds the `platform` surface against the isolated kolboxs5 scratch stack,
// serves it through scripts/stage5/localServer.mjs (the real vercel.json
// rewrites -> the real bundled handlers) and drives headless Chromium.
// Synthetic *@console-ui.invalid identities only; nothing secret is printed.
//
// It also covers the three defects reported against `dcce88d`: the list
// revalidating itself with no F5 and no navigation (G), the workspace name
// rendering under KOLBOX in full (H), and the Platform Owner's account block
// naming them by username rather than e-mail (I).
//
// What it proves:
//   A  ONE management destination - the retired section is gone from the
//      navigation, its path redirects, and no second entry point survives.
//   B  Everything the retired screen could do is here: the approval action,
//      the approval states, the recovery actions and their business rules,
//      the search, the filter and the approval details.
//   C  Everything the systems list could already do still works: owner,
//      status, modules, login code, the details drawer, the module editor,
//      an ownerless workspace, and a workspace several Multi-Entity Owners
//      can see.
//   D  The list stays current without F5 - both for a change made here and
//      for one made elsewhere.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/console/ui-console-unified.mjs <outDir>
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
const outDir = path.resolve(
  process.argv[2] ?? path.join(os.tmpdir(), "kolbox-console-unified-ui"),
);
fs.mkdirSync(outDir, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const P_PORT = 5178;
const E_PORT = 5177;
const PBASE = `http://127.0.0.1:${P_PORT}`;
const EBASE = `http://127.0.0.1:${E_PORT}`;

process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = EBASE;
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "http://127.0.0.1:5176";
process.env.SESSION_ALLOWED_ORIGIN = EBASE;
process.env.OWNER_ALLOWED_ORIGIN = EBASE;

const H = await buildHandlers();
// The suite's waits are derived from the app's OWN interval, so they cannot
// drift from the shipped value.
const REVALIDATE_MS = Number(
  /platformConsoleRevalidateMs:\s*([0-9_]+)/
    .exec(fs.readFileSync(path.join(repoRoot, "src", "constants", "config.ts"), "utf8"))[1]
    .replace(/_/g, ""),
);
const a = admin();
const DOMAIN = "console-ui.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const stamp = Date.now();
const PW = randomPassword();
const pageErrors = [];

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = (seed) =>
  Array.from(
    { length: 8 },
    (_, i) =>
      CODE_ALPHABET[
        Math.floor(stamp / 10 ** i + seed * 7 + i * 13) % CODE_ALPHABET.length
      ],
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

section("BUILD the platform + election surfaces against the scratch stack");
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
  update public.platform_modules set available = true where key = 'election_day';
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access;
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'CU %';
  delete from public.election_day_login_attempts;
`);
async function purgeDomainUsers() {
  for (let p = 1; p < 20; p++) {
    const { data, error } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) {
      if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
    }
    if (data.users.length < 200) break;
  }
}
await purgeDomainUsers();

const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({
  email: email("po"),
  password: poPw,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email)
   values ('${poUser.user.id}', 'CU PO', ${sqlText(email("po"))});`,
);
await enrollTotp((await signIn(email("po"), poPw)).client, "cu-po");

// A module choice on an approval must be ATTRIBUTED to the Platform Owner who
// made it (the table's own check constraint), so the fixtures below need the
// Platform Owner to exist first.
/** A bare workspace with NO Election Owner - the "unassigned" case. */
function makeOwnerlessWorkspace(name, seed) {
  const code = mkCode(seed);
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values (${sqlText(name)},'${code}', now()+interval '30 days');`,
  );
  return {
    name,
    code,
    workspaceId: psql(
      `select id from public.election_workspaces where login_code='${code}';`,
    ).trim(),
  };
}

/**
 * A fully provisioned system: an Owner Auth account, the CONSUMED approval it
 * came from (provisioning marks it consumed and keeps it), the workspace, and
 * its module entitlements. This is what "an owner with one workspace" is.
 */
async function makeProvisioned(label, wsName, modules, seed, { ended = false } = {}) {
  const mail = email(`owner-${label}`);
  const { data, error } = await a.auth.admin.createUser({
    email: mail,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const code = mkCode(seed);
  const end = ended ? "now() - interval '2 days'" : "now() + interval '30 days'";
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values (${sqlText(wsName)},'${code}', ${end});`,
  );
  const workspaceId = psql(
    `select id from public.election_workspaces where login_code='${code}';`,
  ).trim();
  psql(
    `insert into public.election_owners (workspace_id, auth_user_id, name, email)
     values ('${workspaceId}','${data.user.id}',${sqlText(`בעלים ${label}`)},${sqlText(mail)});
     insert into public.election_workspace_pending_owner_access
       (auth_user_id, name, phone, email, status, expires_at, consumed_at,
        requested_modules, approved_by_platform_owner_auth_user_id)
     values ('${data.user.id}', ${sqlText(`בעלים ${label}`)}, '0501112233', ${sqlText(mail)},
             'consumed', now() + interval '7 days', now() - interval '1 day',
             array[${modules.map(sqlText).join(",")}]::text[], '${poUser.user.id}');`,
  );
  for (const key of modules) {
    psql(
      `insert into public.election_workspace_modules (workspace_id, module_key)
       values ('${workspaceId}','${key}') on conflict do nothing;`,
    );
  }
  return { label, mail, wsName, workspaceId, code };
}

/** An approval that has NOT been used - the system does not exist yet. */
async function makeApproval(label, { expired = false } = {}) {
  const mail = email(`pending-${label}`);
  const { data, error } = await a.auth.admin.createUser({
    email: mail,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  psql(
    `insert into public.election_workspace_pending_owner_access
       (auth_user_id, name, phone, email, status, expires_at,
        requested_modules, approved_by_platform_owner_auth_user_id)
     values ('${data.user.id}', ${sqlText(`ממתין ${label}`)}, '0507654321', ${sqlText(mail)},
             ${expired ? "'expired'" : "'pending'"},
             now() ${expired ? "- interval '1 day'" : "+ interval '7 days'"},
             array['election_day']::text[], '${poUser.user.id}');`,
  );
  return { label, mail, name: `ממתין ${label}` };
}

const live = await makeProvisioned("live", "CU מערכת פעילה", ["election_day"], 41);
const ended = await makeProvisioned("ended", "CU מערכת שהסתיימה", ["election_day"], 42, {
  ended: true,
});
const ownerless = makeOwnerlessWorkspace("CU ללא בעלים", 43);
const pendingA = await makeApproval("a");
const expiredA = await makeApproval("b", { expired: true });

// Two Multi-Entity Owners, BOTH holding the live workspace - the count the
// systems list renders must be a count, not a yes/no.
for (const n of [1, 2]) {
  const { data } = await a.auth.admin.createUser({
    email: email(`me${n}`),
    password: PW,
    email_confirm: true,
  });
  psql(
    `insert into public.multi_entity_owner (auth_user_id, name, email)
     values ('${data.user.id}', ${sqlText(`רב-מערכות ${n}`)}, ${sqlText(email(`me${n}`))});
     insert into public.multi_entity_assignments (owner_id, workspace_id)
     select o.owner_id, '${live.workspaceId}'
     from public.multi_entity_owner o where o.email = ${sqlText(email(`me${n}`))};`,
  );
}

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
const po = await ctx.newPage();
po.on("pageerror", (e) => pageErrors.push(String(e)));

const rows = () => po.locator('[data-testid="workspaces-list"] > li');
const rowFor = (needle) => rows().filter({ hasText: needle });
const listText = async () => (await po.locator('[data-testid="workspaces-list"]').innerText()).trim();
const navLabels = () =>
  po.locator("nav a").evaluateAll((els) => els.map((e) => e.textContent.trim()));

try {
  // =======================================================================
  section("A. ONE MANAGEMENT DESTINATION");
  // =======================================================================
  await po.goto(`${PBASE}/platform/login`, { waitUntil: "domcontentloaded" });
  await po.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 20000 });
  await po.locator('input[type="email"]').fill(email("po"));
  await po.locator('input[autocomplete="current-password"]').fill(poPw);
  await po.getByRole("button", { name: "התחברות" }).click();
  await po.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }).waitFor({ timeout: 25000 });

  check(
    "A1 the console's own index lands on the systems section, not a retired one",
    /\/platform\/workspaces$/.test(po.url()),
    po.url(),
  );
  const labels = await navLabels();
  check(
    "A2 the navigation no longer offers a separate 'בעלי מערכות' destination",
    !labels.some((l) => l.includes("בעלי מערכות")),
    labels.join(" | "),
  );
  check(
    "A3 ... and 'מערכות בחירות' is there - so A2 is not passing because the menu is empty",
    labels.some((l) => l.includes("מערכות בחירות")),
    labels.join(" | "),
  );
  await po.locator('[data-testid="workspaces-list"]').waitFor({ timeout: 25000 });
  check(
    "A4 the section that renders is the systems section",
    (await po.locator('[data-testid="platform-workspaces-section"]').count()) === 1,
  );
  check(
    "A5 the retired list is gone from the DOM entirely",
    (await po.locator('[data-testid="owner-access-list"]').count()) === 0 &&
      (await po.locator('[data-testid="platform-owners-section"]').count()) === 0,
  );

  // The old path must land somewhere real, not on a no-match page.
  await po.goto(`${PBASE}/platform/owners`, { waitUntil: "domcontentloaded" });
  await po.locator('[data-testid="workspaces-list"]').waitFor({ timeout: 25000 });
  check(
    "A6 the retired /platform/owners path redirects into the systems section",
    /\/platform\/workspaces$/.test(po.url()),
    po.url(),
  );
  check(
    "A7 ... and only ONE 'אישור בעלים חדש' action exists in the whole console",
    (await po.getByRole("button", { name: "אישור בעלים חדש" }).count()) === 1,
  );

  // =======================================================================
  section("B. EVERYTHING THE RETIRED SCREEN COULD DO, HERE");
  // =======================================================================
  const all = await listText();
  check(
    "B2 an approval that has not been used appears as a system that is not created yet",
    (await rowFor(pendingA.mail).count()) === 1 &&
      (await rowFor(pendingA.mail).innerText()).includes("המערכת טרם הוקמה"),
    all.replace(/\s+/g, " ").slice(0, 160),
  );
  check(
    "B3 ... carrying the approval's OWN state, not a workspace state",
    (await rowFor(pendingA.mail).innerText()).includes("ממתינה להרשמה") &&
      (await rowFor(expiredA.mail).innerText()).includes("פג תוקף"),
  );
  check(
    "B4 ... its owner's name",
    (await rowFor(pendingA.mail).innerText()).includes(pendingA.name),
  );
  check(
    "B5 ... and the modules the approval recorded",
    (await rowFor(pendingA.mail).innerText()).includes("ניהול יום הבחירות"),
  );
  check(
    "B6 an ACTIVE approval offers a new link; an EXPIRED one offers renewal",
    (await rowFor(pendingA.mail).getByRole("button", { name: "הפקת קישור חדש" }).count()) === 1 &&
      (await rowFor(expiredA.mail).getByRole("button", { name: "חידוש והפקת קישור" }).count()) === 1,
  );
  check(
    "B7 a CONSUMED approval offers neither - the business rule survived the move",
    (await rowFor(live.wsName).getByRole("button", { name: "הפקת קישור חדש" }).count()) === 0 &&
      (await rowFor(live.wsName).getByRole("button", { name: "חידוש והפקת קישור" }).count()) === 0,
  );

  // Search reaches an approval by its e-mail - the retired screen's search.
  const search = po.getByPlaceholder("חיפוש לפי שם מערכת, בעלים, אימייל או קוד מערכת");
  await search.fill(pendingA.mail);
  await po.waitForTimeout(400);
  check(
    "B8 search finds an approval by e-mail address",
    (await rows().count()) === 1 && (await rows().first().innerText()).includes(pendingA.mail),
    String(await rows().count()),
  );
  await search.fill(live.code);
  await po.waitForTimeout(400);
  check(
    "B9 ... and still finds a workspace by its login code",
    (await rows().count()) === 1 && (await rows().first().innerText()).includes(live.wsName),
  );
  await search.fill("");
  await po.waitForTimeout(400);

  // The state filter, now over one axis covering both kinds of row.
  const filter = po.getByLabel("סינון לפי מצב");
  await filter.selectOption({ value: "pending" });
  await po.waitForTimeout(400);
  check(
    "B10 filtering by 'ממתינות להרשמה' shows exactly the unused approvals",
    (await rows().count()) === 1 && (await rows().first().innerText()).includes(pendingA.mail),
    String(await rows().count()),
  );
  await filter.selectOption({ value: "ended" });
  await po.waitForTimeout(400);
  // The scratch stack is shared, so other suites' workspaces are present too -
  // this asserts membership, not a total.
  check(
    "B11 ... and filtering by 'מערכות שהסתיימו' includes the ended system and excludes the live one",
    (await rowFor(ended.wsName).count()) === 1 &&
      (await rowFor(live.wsName).count()) === 0 &&
      (await rowFor(pendingA.mail).count()) === 0,
    String(await rows().count()),
  );
  await filter.selectOption({ value: "" });
  await po.waitForTimeout(400);
  check(
    "B11b clearing the filter brings every kind of row back",
    (await rowFor(ended.wsName).count()) === 1 &&
      (await rowFor(live.wsName).count()) === 1 &&
      (await rowFor(pendingA.mail).count()) === 1,
  );

  // The approval's persistent details.
  await rowFor(pendingA.mail).getByRole("button", { name: `פרטי ${pendingA.name}` }).click();
  const drawer = po.getByRole("dialog");
  await drawer.waitFor({ timeout: 10000 });
  const pendingDetail = await drawer.innerText();
  check(
    "B12 the approval's details are all here: phone, e-mail, requested modules and its date",
    pendingDetail.includes("0507654321") &&
      pendingDetail.includes(pendingA.mail) &&
      pendingDetail.includes("ניהול יום הבחירות") &&
      pendingDetail.includes("בתוקף עד"),
    pendingDetail.replace(/\s+/g, " ").slice(0, 180),
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  // The recovery action itself - the retired screen's one mutation.
  await rowFor(expiredA.mail).getByRole("button", { name: "חידוש והפקת קישור" }).click();
  await po.getByRole("dialog").getByText("תחודש ל-7 ימים").waitFor({ timeout: 10000 });
  await po.getByRole("dialog").getByRole("button", { name: "הפקת קישור" }).click();
  const issued = po.locator('[data-testid="owner-access-issued"]');
  await issued.waitFor({ timeout: 20000 });
  const issuedText = await issued.innerText();
  check(
    "B13 renewing an expired approval issues a one-time link and says the window was renewed",
    issuedText.includes("ההרשאה חודשה ל-7 ימים.") &&
      issuedText.includes("/election-day/owner-set-password"),
  );
  await issued.getByRole("button", { name: "סיום" }).click();
  await po.waitForFunction(
    (m) =>
      [...document.querySelectorAll('[data-testid="workspaces-list"] > li')].some(
        (li) => li.textContent.includes(m) && li.textContent.includes("ממתינה להרשמה"),
      ),
    expiredA.mail,
    { timeout: 15000 },
  );
  check("B14 ... and the row moves back to 'ממתינה להרשמה' without a reload", true);

  // =======================================================================
  section("C. EVERYTHING THE SYSTEMS LIST COULD ALREADY DO");
  // =======================================================================
  const liveRow = rowFor(live.wsName);
  check(
    "C1 a provisioned system shows its name, login code, owner, status and modules",
    ((t) =>
      t.includes(live.wsName) &&
      t.includes(live.code) &&
      t.includes("בעלים live") &&
      t.includes("פעילה") &&
      t.includes("ניהול יום הבחירות"))(await liveRow.innerText()),
    (await liveRow.innerText()).replace(/\s+/g, " ").slice(0, 160),
  );
  check(
    "C2 an ended system renders as ended, not as active",
    ((t) => t.includes("הסתיימה") && !t.includes("פעילה"))(
      await rowFor(ended.wsName).innerText(),
    ),
    (await rowFor(ended.wsName).innerText()).replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "C3 a workspace with no Election Owner is preserved and says so",
    (await rowFor(ownerless.name).count()) === 1 &&
      (await rowFor(ownerless.name).innerText()).includes("לא משויך בעלים"),
  );

  await liveRow.getByRole("button", { name: `פרטי ${live.wsName}` }).click();
  await po.getByRole("dialog").waitFor({ timeout: 10000 });
  const wsDetail = await po.getByRole("dialog").innerText();
  check(
    "C4 the system's details still carry the owner, e-mail, code, status, end date and modules",
    wsDetail.includes("בעלים live") &&
      wsDetail.includes(live.mail) &&
      wsDetail.includes(live.code) &&
      wsDetail.includes("סיום הבחירות") &&
      wsDetail.includes("ניהול יום הבחירות"),
    wsDetail.replace(/\s+/g, " ").slice(0, 200),
  );
  check(
    "C5 ... the number of Multi-Entity Owners that can see it (a count, not a yes/no)",
    wsDetail.includes("משויכת ל-2 בעלי רב-מערכות"),
    wsDetail.replace(/\s+/g, " ").slice(0, 220),
  );
  check(
    "C6 ... and NEW here: the approval this system came from, which used to be a screen away",
    wsDetail.includes("מצב ההרשאה") && wsDetail.includes("הושלמה"),
  );
  await po.getByRole("button", { name: "עריכת מודולים" }).click();
  await po
    .getByRole("dialog")
    .filter({ hasText: "עריכת מודולים" })
    .waitFor({ timeout: 10000 });
  check(
    "C7 the module editor still opens from the details drawer",
    (await po.getByRole("dialog").getByRole("checkbox").count()) >= 1,
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  // =======================================================================
  section("D. THE LIST STAYS CURRENT WITHOUT F5");
  // =======================================================================
  const before = await rows().count();
  await po.getByRole("button", { name: "אישור בעלים חדש" }).click();
  const form = po
    .locator("form")
    .filter({ has: po.getByRole("button", { name: "אישור ויצירת קישור" }) });
  await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').first().waitFor({ timeout: 20000 });
  const freshName = `בעלים חדש ${stamp}`;
  await form.getByLabel("שם הבעלים").fill(freshName);
  await form.getByLabel("אימייל").fill(email(`fresh-${stamp}`));
  await form.locator('input[name="approve-owner-phone"]').fill("050-123-4567");
  await form.locator('input[name="owner-approval-username"]').fill(`cu fresh ${stamp}`);
  await form.locator('[data-testid="approval-modules"] input[type="checkbox"]').first().check();
  await form.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  await po.getByText("הבעלים אושר").waitFor({ timeout: 25000 });
  await po.getByRole("button", { name: "סיום" }).click();
  await po.waitForFunction(
    (n) =>
      [...document.querySelectorAll('[data-testid="workspaces-list"] > li')].some((li) =>
        li.textContent.includes(n),
      ),
    freshName,
    { timeout: 20000 },
  );
  check(
    "D1 approving an owner adds their system-to-be to THIS list, with no F5",
    (await rows().count()) === before + 1 && !po.url().includes("reload"),
    `${before} -> ${await rows().count()}`,
  );

  // A workspace that comes into existence ELSEWHERE - no dialog here can call
  // back from that; only re-reading on entry can.
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values ('CU נוצרה מבחוץ ${stamp}','${mkCode(44)}', now()+interval '30 days');`,
  );
  // Away and back. The module-assignment destination is retired, so this
  // leaves through Settings - any sibling section forces the same remount.
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.locator('[data-testid="platform-settings-section"]').waitFor({ timeout: 25000 });
  await po.getByRole("link", { name: "מערכות בחירות" }).click();
  await po.locator(`text=CU נוצרה מבחוץ ${stamp}`).first().waitFor({ timeout: 25000 });
  check(
    "D2 a system created elsewhere appears on re-entering the section - still no F5",
    /\/platform\/workspaces$/.test(po.url()),
    po.url(),
  );

  // =======================================================================
  section("E. THE REAL LIFECYCLE - approval, then provisioning, in ONE row");
  // =======================================================================
  // Sections B-D ran against hand-built fixtures. This one runs the ACTUAL
  // flow: the console approves, the owner activates the link, sets a password
  // and creates their own workspace through the real RPC. That is the only way
  // to see what the two reads really contain afterwards - a fixture can only
  // confirm whatever assumption wrote it.
  const lodPw = randomPassword();
  const lodMail = email(`lod-${stamp}`);
  const LOD = `CU לוד ${stamp}`;

  await po.getByRole("button", { name: "אישור בעלים חדש" }).click();
  const lodForm = po
    .locator("form")
    .filter({ has: po.getByRole("button", { name: "אישור ויצירת קישור" }) });
  await lodForm
    .locator('[data-testid="approval-modules"] input[type="checkbox"]')
    .first()
    .waitFor({ timeout: 20000 });
  await lodForm.getByLabel("שם הבעלים").fill("נחום משה בדיקה");
  await lodForm.getByLabel("אימייל").fill(lodMail);
  await lodForm.locator('input[name="approve-owner-phone"]').fill("050-765-4321");
  await lodForm.locator('input[name="owner-approval-username"]').fill(`cu lod ${stamp}`);
  await lodForm.getByRole("checkbox", { name: "ניהול יום הבחירות" }).check();
  await lodForm.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  await po.getByText("הבעלים אושר").waitFor({ timeout: 25000 });
  const activation = await po
    .locator('[dir="ltr"]')
    .filter({ hasText: "/election-day/owner-set-password" })
    .first()
    .innerText();
  await po.getByRole("button", { name: "סיום" }).click();

  await po.waitForFunction(
    (m) =>
      [...document.querySelectorAll('[data-testid="workspaces-list"] > li')].some((li) =>
        li.textContent.includes(m),
      ),
    lodMail,
    { timeout: 20000 },
  );
  check(
    "E1 BEFORE creation the approval is one row, saying the system does not exist yet",
    (await rowFor(lodMail).count()) === 1 &&
      (await rowFor(lodMail).getAttribute("data-kind")) === "approval" &&
      (await rowFor(lodMail).innerText()).includes("המערכת טרם הוקמה"),
    (await rowFor(lodMail).innerText()).replace(/\s+/g, " ").slice(0, 120),
  );

  // --- the owner does their half, for real ---------------------------------
  const ePage = await ctx.browser().newPage();
  ePage.on("pageerror", (e) => pageErrors.push(String(e)));
  await ePage.goto(activation.trim());
  await ePage.getByText("הגדרת סיסמה לחשבון הבעלים").waitFor({ timeout: 20000 });
  const pwFields = ePage.locator('input[type="password"]');
  await pwFields.nth(0).fill(lodPw);
  await pwFields.nth(1).fill(lodPw);
  await ePage.getByRole("button", { name: "שמירת סיסמה" }).click();
  await ePage.getByText("הסיסמה נשמרה").waitFor({ timeout: 20000 });
  // The username sign-in lives on the auth origin, which a single-host suite
  // cannot run; a REAL session from a real password sign-in is seeded instead,
  // so provisioning below is the genuine authorized call.
  await seedOwnerSession(ePage, EBASE, lodMail, lodPw);
  await ePage.goto(`${EBASE}/election-day/owner/setup`);
  await ePage.getByText("הקמת מערכת הבחירות").first().waitFor({ timeout: 25000 });
  await ePage.locator("#ws-name").fill(LOD);
  await ePage.locator("#ws-end").fill("2026-12-31T20:00");
  await ePage.getByRole("button", { name: "יצירת מערכת הבחירות" }).click();
  await ePage.getByText("מערכת הבחירות נוצרה").first().waitFor({ timeout: 25000 });
  const lodCode = psql(
    `select login_code from public.election_workspaces where name = ${sqlText(LOD)};`,
  ).trim();
  check("E2 the owner really created the workspace", lodCode.length === 8, lodCode);
  await ePage.close();

  // What the two reads now hold for the SAME person. Printed because this is
  // the evidence the join stands on - addresses are identifiers here, not
  // secrets, and these are synthetic *.invalid ones.
  const pendingMail = psql(
    `select email from public.election_workspace_pending_owner_access where email = ${sqlText(lodMail)};`,
  ).trim();
  const ownerMail = psql(
    `select o.email from public.election_owners o
     join public.election_workspaces w on w.id = o.workspace_id
     where w.name = ${sqlText(LOD)};`,
  ).trim();
  console.log(`    approval.email=${JSON.stringify(pendingMail)}`);
  console.log(`    election_owners.email=${JSON.stringify(ownerMail)}`);

  // --- and the console, WITHOUT F5 -----------------------------------------
  // Away and back. The module-assignment destination is retired, so this
  // leaves through Settings - any sibling section forces the same remount.
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.locator('[data-testid="platform-settings-section"]').waitFor({ timeout: 25000 });
  await po.getByRole("link", { name: "מערכות בחירות" }).click();
  await po.locator(`text=${LOD}`).first().waitFor({ timeout: 25000 });

  const lodRow = rowFor(LOD);
  check(
    "E3 AFTER creation the row became the real workspace row",
    (await lodRow.count()) === 1 && (await lodRow.getAttribute("data-kind")) === "workspace",
    `count=${await lodRow.count()} kind=${await lodRow.getAttribute("data-kind")}`,
  );
  await lodRow.getByText(lodCode).waitFor({ timeout: 25000 });
  check(
    "E4 ... showing the workspace name, code, owner, status and modules",
    ((t) =>
      t.includes(LOD) &&
      t.includes(lodCode) &&
      t.includes("נחום משה בדיקה") &&
      t.includes("פעילה") &&
      t.includes("ניהול יום הבחירות"))(await lodRow.innerText()),
    (await lodRow.innerText()).replace(/\s+/g, " ").slice(0, 160),
  );
  check(
    "E5 ... and NO approval row survives for that owner - one system, one row",
    (await po
      .locator('[data-testid="workspaces-list"] li[data-kind="approval"]')
      .filter({ hasText: lodMail })
      .count()) === 0 &&
      (await po
        .locator('[data-testid="workspaces-list"] li')
        .filter({ hasText: "המערכת טרם הוקמה" })
        .filter({ hasText: "נחום משה בדיקה" })
        .count()) === 0,
  );
  await lodRow.getByRole("button", { name: `פרטי ${LOD}` }).click();
  await po.getByRole("dialog").waitFor({ timeout: 10000 });
  const lodDetail = await po.getByRole("dialog").innerText();
  check(
    "E6 ... and the details carry the approval it came from",
    lodDetail.includes("מצב ההרשאה") &&
      lodDetail.includes("הושלמה") &&
      lodDetail.includes(lodMail),
    lodDetail.replace(/\s+/g, " ").slice(0, 180),
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  await po.reload({ waitUntil: "domcontentloaded" });
  await po.locator(`text=${LOD}`).first().waitFor({ timeout: 25000 });
  check(
    "E7 a full reload keeps the same mapping - still one workspace row, no approval row",
    (await rowFor(LOD).getAttribute("data-kind")) === "workspace" &&
      (await po
        .locator('[data-testid="workspaces-list"] li[data-kind="approval"]')
        .filter({ hasText: lodMail })
        .count()) === 0,
  );

  // =======================================================================
  section("F. THE REPORTED DEFECT - the address is not the key");
  // =======================================================================
  // Production symptom: an Election Owner who is already inside an active
  // workspace still read as "המערכת טרם הוקמה". Provisioning copies the
  // approval's address into `election_owners`, so the two agree on the happy
  // path (section E printed them) - but nothing KEEPS them equal, neither
  // column is unique, and a workspace whose owner row was written by any other
  // path carries whatever address that path was given. This reproduces exactly
  // that shape: the durable key (`auth_user_id`) still links the two rows, so
  // the server still resolves the workspace, and only the copied address
  // differs.
  const divergent = email(`divergent-${stamp}`);
  psql(
    `update public.election_owners o set email = ${sqlText(divergent)}
     where o.workspace_id = (select id from public.election_workspaces where name = ${sqlText(LOD)});`,
  );
  check(
    "F0 the two addresses now disagree, while the durable key still links them",
    psql(
      `select (o.email <> pa.email) and (o.auth_user_id = pa.auth_user_id)
       from public.election_owners o
       join public.election_workspace_pending_owner_access pa on pa.auth_user_id = o.auth_user_id
       where o.workspace_id = (select id from public.election_workspaces where name = ${sqlText(LOD)});`,
    ).trim() === "t",
  );

  // Away and back. The module-assignment destination is retired, so this
  // leaves through Settings - any sibling section forces the same remount.
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.locator('[data-testid="platform-settings-section"]').waitFor({ timeout: 25000 });
  await po.getByRole("link", { name: "מערכות בחירות" }).click();
  await po.locator(`text=${LOD}`).first().waitFor({ timeout: 25000 });

  await rowFor(LOD).getByText(lodCode).waitFor({ timeout: 25000 });
  check(
    "F1 the owner is STILL mapped to their workspace - not reported as uncreated",
    (await rowFor(LOD).count()) === 1 &&
      (await rowFor(LOD).getAttribute("data-kind")) === "workspace" &&
      (await po
        .locator('[data-testid="workspaces-list"] li[data-kind="approval"]')
        .filter({ hasText: "נחום משה בדיקה" })
        .count()) === 0,
    (await rowFor(LOD).innerText()).replace(/\s+/g, " ").slice(0, 140),
  );
  check(
    "F2 ... with the workspace name, code, owner, status and modules intact",
    ((t) =>
      t.includes(LOD) &&
      t.includes(lodCode) &&
      t.includes("נחום משה בדיקה") &&
      t.includes("פעילה") &&
      !t.includes("לא זמין כרגע"))(await rowFor(LOD).innerText()),
    (await rowFor(LOD).innerText()).replace(/\s+/g, " ").slice(0, 140),
  );
  await rowFor(LOD).getByRole("button", { name: `פרטי ${LOD}` }).click();
  await po.getByRole("dialog").waitFor({ timeout: 10000 });
  check(
    "F3 ... and the approval is still attached, through the server's own resolution",
    ((t) => t.includes("מצב ההרשאה") && t.includes("הושלמה"))(
      await po.getByRole("dialog").innerText(),
    ),
    (await po.getByRole("dialog").innerText()).replace(/\s+/g, " ").slice(0, 160),
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  // NEGATIVE CONTROL: F1 must not be passing because everything became a
  // workspace row. An approval that really has produced nothing still says so.
  check(
    "F4 an approval with no workspace STILL reads 'המערכת טרם הוקמה'",
    (await rowFor(pendingA.mail).getAttribute("data-kind")) === "approval" &&
      (await rowFor(pendingA.mail).innerText()).includes("המערכת טרם הוקמה"),
    (await rowFor(pendingA.mail).innerText()).replace(/\s+/g, " ").slice(0, 120),
  );

  // Workspace names are NOT unique, so the server-resolved name alone cannot
  // always identify a row. A second system with the SAME name, its own owner
  // and its own approval, must not steal the first one's approval.
  psql(
    `update public.election_owners o set email = ${sqlText(lodMail)}
     where o.workspace_id = (select id from public.election_workspaces where name = ${sqlText(LOD)});`,
  );
  const twin = await makeProvisioned("twin", LOD, ["election_day"], 47);
  // Away and back. The module-assignment destination is retired, so this
  // leaves through Settings - any sibling section forces the same remount.
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.locator('[data-testid="platform-settings-section"]').waitFor({ timeout: 25000 });
  await po.getByRole("link", { name: "מערכות בחירות" }).click();
  await po.waitForFunction(
    (n) =>
      [...document.querySelectorAll('[data-testid="workspaces-list"] > li')].filter((li) =>
        li.textContent.includes(n),
      ).length === 2,
    LOD,
    { timeout: 25000 },
  );
  const sameName = po.locator('[data-testid="workspaces-list"] > li').filter({ hasText: LOD });
  check(
    "F5 two systems share a name: both are workspace rows, neither is 'uncreated'",
    (await sameName.count()) === 2 &&
      (await sameName.nth(0).getAttribute("data-kind")) === "workspace" &&
      (await sameName.nth(1).getAttribute("data-kind")) === "workspace" &&
      (await po
        .locator('[data-testid="workspaces-list"] li[data-kind="approval"]')
        .filter({ hasText: twin.mail })
        .count()) === 0,
    String(await sameName.count()),
  );
  // Each one's drawer must show ITS OWN owner's address, not the other's.
  for (const [id, code, mail] of [
    ["F6", lodCode, lodMail],
    ["F7", twin.code, twin.mail],
  ]) {
    const row = sameName.filter({ hasText: code });
    await row.getByRole("button", { name: `פרטי ${LOD}` }).click();
    await po.getByRole("dialog").waitFor({ timeout: 10000 });
    const t = await po.getByRole("dialog").innerText();
    check(
      `${id} the same-named system with code ${code} shows its OWN owner's approval`,
      t.includes(mail) && t.includes("מצב ההרשאה"),
      t.replace(/\s+/g, " ").slice(0, 140),
    );
    await po.keyboard.press("Escape");
    await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
  }

  // =======================================================================
  section("G. THE LIST REVALIDATES ITSELF - no F5, no navigation");
  // =======================================================================
  // The reported defect: the Platform Owner sits on this screen while an
  // approved Owner creates their workspace in ANOTHER browser. Nothing in this
  // tab can be told about that, and re-reading on navigation does not help
  // someone who simply stays put - so the row kept saying the system had not
  // been created until a manual refresh.
  const kmPw = randomPassword();
  const kmMail = email(`km-${stamp}`);
  // Long on purpose: section H needs a name that the old one-line header
  // truncated ("קרית מ...").
  const KM = `CU קרית מלאכי רבתי מרחב דרום ${stamp}`;

  await po.getByRole("button", { name: "אישור בעלים חדש" }).click();
  const kmForm = po
    .locator("form")
    .filter({ has: po.getByRole("button", { name: "אישור ויצירת קישור" }) });
  await kmForm
    .locator('[data-testid="approval-modules"] input[type="checkbox"]')
    .first()
    .waitFor({ timeout: 20000 });
  await kmForm.getByLabel("שם הבעלים").fill("בעל קרית מלאכי");
  await kmForm.getByLabel("אימייל").fill(kmMail);
  await kmForm.locator('input[name="approve-owner-phone"]').fill("050-111-2222");
  await kmForm.locator('input[name="owner-approval-username"]').fill(`cu km ${stamp}`);
  await kmForm.getByRole("checkbox", { name: "ניהול יום הבחירות" }).check();
  await kmForm.getByRole("button", { name: "אישור ויצירת קישור" }).click();
  await po.getByText("הבעלים אושר").waitFor({ timeout: 25000 });
  const kmActivation = await po
    .locator('[dir="ltr"]')
    .filter({ hasText: "/election-day/owner-set-password" })
    .first()
    .innerText();
  await po.getByRole("button", { name: "סיום" }).click();
  await po.waitForFunction(
    (m) =>
      [...document.querySelectorAll('[data-testid="workspaces-list"] > li')].some((li) =>
        li.textContent.includes(m),
      ),
    kmMail,
    { timeout: 20000 },
  );
  check(
    "G1 the approval is on screen as a system that does not exist yet",
    (await rowFor(kmMail).getAttribute("data-kind")) === "approval",
  );

  // From here on, THIS page must not navigate and must not reload. A sentinel
  // on `window` dies with any document swap, and every main-frame navigation
  // is counted - so either would be caught, not assumed.
  let navigations = 0;
  po.on("framenavigated", (f) => {
    if (f === po.mainFrame()) navigations += 1;
  });
  const urlBefore = po.url();
  await po.evaluate(() => {
    window.__kbSentinel = "alive";
  });

  // ANOTHER browser context: its own storage, its own session - exactly the
  // "in another browser" shape of the report.
  const owCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "he-IL" });
  const owPage = await owCtx.newPage();
  owPage.on("pageerror", (e) => pageErrors.push(String(e)));
  await owPage.goto(kmActivation.trim());
  await owPage.getByText("הגדרת סיסמה לחשבון הבעלים").waitFor({ timeout: 20000 });
  const kmPwFields = owPage.locator('input[type="password"]');
  await kmPwFields.nth(0).fill(kmPw);
  await kmPwFields.nth(1).fill(kmPw);
  await owPage.getByRole("button", { name: "שמירת סיסמה" }).click();
  await owPage.getByText("הסיסמה נשמרה").waitFor({ timeout: 20000 });
  await seedOwnerSession(owPage, EBASE, kmMail, kmPw);
  await owPage.goto(`${EBASE}/election-day/owner/setup`);
  await owPage.getByText("הקמת מערכת הבחירות").first().waitFor({ timeout: 25000 });
  await owPage.locator("#ws-name").fill(KM);
  await owPage.locator("#ws-end").fill("2026-12-31T20:00");
  await owPage.getByRole("button", { name: "יצירת מערכת הבחירות" }).click();
  await owPage.getByText("מערכת הבחירות נוצרה").first().waitFor({ timeout: 25000 });
  const kmCode = psql(
    `select login_code from public.election_workspaces where name = ${sqlText(KM)};`,
  ).trim();
  check("G2 the other session really created the workspace", kmCode.length === 8, kmCode);

  // NOTHING is done to the Platform page. It has to notice on its own - and
  // the wait is TIMED, so "it eventually caught up" cannot pass for "it caught
  // up at the interval the app actually ships".
  const createdAt = Date.now();
  const becameWorkspace = await po
    .waitForFunction(
      ([name, code]) => {
        const rows = [...document.querySelectorAll('[data-testid="workspaces-list"] > li')];
        const row = rows.find((li) => li.textContent.includes(name));
        return (
          row?.getAttribute("data-kind") === "workspace" &&
          row.textContent.includes(code)
        );
      },
      [KM, kmCode],
      { timeout: 90000, polling: 500 },
    )
    .then(() => true, () => false);
  const noticedInMs = Date.now() - createdAt;
  check("G3 the row became the real workspace row ON ITS OWN", becameWorkspace, `${noticedInMs}ms`);
  // Two intervals plus a round trip. At the previous 20s cadence this bound is
  // unreachable, so it measures the shipped interval rather than restating it.
  const bound = REVALIDATE_MS * 2 + 3000;
  check(
    "G3b ... within the interval it ships with, not merely eventually",
    becameWorkspace && noticedInMs <= bound,
    `noticed in ${noticedInMs}ms, bound ${bound}ms (interval ${REVALIDATE_MS}ms)`,
  );
  check(
    "G4 ... and this page never navigated and never reloaded to do it",
    navigations === 0 &&
      po.url() === urlBefore &&
      (await po.evaluate(() => window.__kbSentinel)) === "alive",
    `navigations=${navigations} url=${po.url() === urlBefore} sentinel=${await po.evaluate(() => window.__kbSentinel)}`,
  );
  const kmRow = po.locator('[data-testid="workspaces-list"] > li').filter({ hasText: KM });
  check(
    "G5 ... showing the real name, code, status, modules and the right Owner",
    ((t) =>
      t.includes(KM) &&
      t.includes(kmCode) &&
      t.includes("פעילה") &&
      t.includes("ניהול יום הבחירות") &&
      t.includes("בעל קרית מלאכי"))(await kmRow.innerText()),
    (await kmRow.innerText()).replace(/\s+/g, " ").slice(0, 170),
  );
  check(
    "G6 ... with no duplicate row and no leftover approval row",
    (await kmRow.count()) === 1 &&
      (await po
        .locator('[data-testid="workspaces-list"] li[data-kind="approval"]')
        .filter({ hasText: kmMail })
        .count()) === 0,
    String(await kmRow.count()),
  );
  // NEGATIVE CONTROL: revalidation must not turn every approval into a system.
  check(
    "G7 a genuinely uncreated approval STILL reads 'המערכת טרם הוקמה'",
    (await rowFor(pendingA.mail).getAttribute("data-kind")) === "approval" &&
      (await rowFor(pendingA.mail).innerText()).includes("המערכת טרם הוקמה"),
    (await rowFor(pendingA.mail).innerText()).replace(/\s+/g, " ").slice(0, 110),
  );

  // Cost control: a backgrounded console must issue NO requests at all.
  let reads = 0;
  const countReads = (r) => {
    if (r.url().includes("op=workspace_modules")) reads += 1;
  };
  po.on("request", countReads);
  const hide = (state) =>
    po.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => s,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);

  await hide("hidden");
  reads = 0;
  await po.waitForTimeout(REVALIDATE_MS + 8000);
  const whileHidden = reads;
  check(
    "G8 while the tab is hidden the section issues NO reads at all",
    whileHidden === 0,
    `reads=${whileHidden} over ${REVALIDATE_MS + 8000}ms`,
  );
  reads = 0;
  await hide("visible");
  await po.waitForTimeout(3000);
  const onReturn = reads;
  check(
    "G9 ... and it catches up immediately on becoming visible again",
    onReturn >= 1,
    `reads=${onReturn} within 3000ms`,
  );
  reads = 0;
  await po.waitForTimeout(REVALIDATE_MS + 8000);
  check(
    "G10 ... then keeps revalidating while it stays visible",
    reads >= 1,
    `reads=${reads} over ${REVALIDATE_MS + 8000}ms`,
  );
  po.off("request", countReads);

  // =======================================================================
  section("H. THE WORKSPACE NAME SITS UNDER KOLBOX, IN FULL");
  // =======================================================================
  // A worker inside the workspace created above - that shell is the one that
  // renders the logo block.
  const kmWorkspaceId = psql(
    `select id from public.election_workspaces where name = ${sqlText(KM)};`,
  ).trim();
  const workerName = "עובד קרית מלאכי";
  psql(
    `insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
     select '${kmWorkspaceId}', ${sqlText(workerName)},
            extensions.crypt(${sqlText(kmPw)}, extensions.gen_salt('bf')), r.id
     from public.election_day_roles r where r.workspace_id = '${kmWorkspaceId}' limit 1;
     delete from public.election_day_login_attempts;`,
  );

  const wp = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" })).newPage();
  wp.on("pageerror", (e) => pageErrors.push(String(e)));
  await wp.goto(`${EBASE}/election-day/login`, { waitUntil: "domcontentloaded" });
  await wp.locator('input[name="election-day-workspace-code"]').fill(kmCode);
  await wp.locator('input[name="election-day-username"]').fill(workerName);
  await wp.locator('input[name="election-day-current-password"]').fill(kmPw);
  await wp.getByRole("button", { name: "התחברות" }).click();
  await wp.locator('[data-testid="active-workspace-name"]').waitFor({ timeout: 30000 });

  /** Geometry read from the LIVE layout - not from the class list. */
  const geometry = async (page, testId, titleSelector) =>
    page.evaluate(
      ([id, sel]) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        const title = [...document.querySelectorAll(sel)].find((n) =>
          n.textContent.trim().startsWith("קול"),
        );
        if (!el || !title) return null;
        const e = el.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        const box = el.parentElement.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const tcs = getComputedStyle(title);
        // A long name WRAPS, so the element box fills the column and its own
        // edges say nothing about alignment. The LINES do: measure the text
        // itself and look at the last (short) line - with the text aligned to
        // the end side, that line hugs the left edge in RTL.
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [...range.getClientRects()].filter((r) => r.width > 0);
        const last = lines[lines.length - 1];
        return {
          text: el.textContent.trim(),
          textAlign: cs.textAlign,
          lineCount: lines.length,
          lastLeftGap: last ? Math.round(last.left - e.left) : null,
          lastRightGap: last ? Math.round(e.right - last.right) : null,
          below: e.top >= t.bottom - 1,
          sameLine: e.top < t.bottom - 1 && e.bottom > t.top + 1,
          fontSize: cs.fontSize,
          titleFontSize: tcs.fontSize,
          // Measured against the CONTENT edge: the block's own horizontal
          // padding is shared with the logo above and is not an indent.
          leftGap: Math.round(
            e.left - (box.left + parseFloat(getComputedStyle(el.parentElement).paddingLeft)),
          ),
          rightGap: Math.round(
            box.right - parseFloat(getComputedStyle(el.parentElement).paddingRight) - e.right,
          ),
          clipped: el.scrollWidth > el.clientWidth + 1,
          ellipsis: cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap",
          insideBox: e.left >= box.left - 1 && e.right <= box.right + 1,
        };
      },
      [testId, titleSelector],
    );

  const d = await geometry(wp, "active-workspace-name", "aside span");
  check("H1 desktop: the name is BELOW the KOLBOX title, not beside it", d !== null && d.below && !d.sameLine, JSON.stringify(d));
  check("H2 desktop: it carries the KOLBOX title's own size", d.fontSize === d.titleFontSize, `${d.fontSize} vs ${d.titleFontSize}`);
  check(
    "H3 desktop: the text is aligned to the LEFT (end) side of the logo block",
    d.textAlign === "end" &&
      d.leftGap <= 2 &&
      // Its last line hugs the left edge, which is what alignment means once
      // a long name wraps and the box itself fills the column.
      d.lastLeftGap <= 2 &&
      d.lastRightGap > d.lastLeftGap,
    JSON.stringify({
      textAlign: d.textAlign,
      lineCount: d.lineCount,
      lastLeftGap: d.lastLeftGap,
      lastRightGap: d.lastRightGap,
    }),
  );
  check("H4 desktop: the COMPLETE name is rendered - nothing truncated", d.text === KM && !d.clipped && !d.ellipsis, JSON.stringify({ text: d.text, clipped: d.clipped, ellipsis: d.ellipsis }));
  check("H5 desktop: and it stays inside the sidebar", d.insideBox);
  await wp.screenshot({ path: path.join(outDir, "h-workspace-name-desktop.png") });

  await wp.setViewportSize({ width: 390, height: 844 });
  await wp.locator('[data-testid="active-workspace-name-mobile"]').waitFor({ timeout: 15000 });
  const m = await geometry(wp, "active-workspace-name-mobile", "header span");
  check("H6 phone: the name is BELOW the KOLBOX title there too", m !== null && m.below && !m.sameLine, JSON.stringify(m));
  check(
    "H7 phone: same size as the title, complete text, nothing clipped, left-aligned",
    m.fontSize === m.titleFontSize &&
      m.text === KM &&
      !m.clipped &&
      !m.ellipsis &&
      m.textAlign === "end" &&
      m.lastLeftGap <= 2 &&
      m.lastRightGap > m.lastLeftGap,
    JSON.stringify({
      f: m.fontSize,
      t: m.titleFontSize,
      clipped: m.clipped,
      textAlign: m.textAlign,
      lastLeftGap: m.lastLeftGap,
      lastRightGap: m.lastRightGap,
    }),
  );
  check("H8 phone: no horizontal overflow of the page", !(await wp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await wp.screenshot({ path: path.join(outDir, "h-workspace-name-phone.png") });
  await wp.close();

  // =======================================================================
  section("J. THE OWNER'S PHONE NUMBER IN THE SYSTEM'S DETAILS");
  // =======================================================================
  // It must be the OWNER's number - `election_owners.phone` - and not the
  // approval's copy of it. The two agree for a normally provisioned Owner, so
  // the only way to tell which one is on screen is to make them disagree.
  const openDetails = async (rowText, name) => {
    await po
      .locator('[data-testid="workspaces-list"] > li')
      .filter({ hasText: rowText })
      .getByRole("button", { name: `פרטי ${name}` })
      .click();
    await po.getByRole("dialog").waitFor({ timeout: 10000 });
    const t = await po.getByRole("dialog").innerText();
    await po.keyboard.press("Escape");
    await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });
    return t;
  };

  const kmPhone = psql(
    `select o.phone from public.election_owners o
     join public.election_workspaces w on w.id = o.workspace_id
     where w.name = ${sqlText(KM)};`,
  ).trim();
  check(
    "J1 the Owner really has a number on their own row",
    kmPhone === "0501112222",
    kmPhone,
  );
  let detailText = await openDetails(KM, KM);
  check(
    "J2 the details show the Owner's phone number",
    detailText.includes("טלפון הבעלים") && detailText.includes(kmPhone),
    detailText.replace(/\s+/g, " ").slice(0, 190),
  );

  // Make the two disagree. The approval keeps 0501112222; the Owner's own row
  // gets a different number - and the screen must follow the Owner.
  psql(
    `update public.election_owners o set phone = '0539998888'
     where o.workspace_id = (select id from public.election_workspaces where name = ${sqlText(KM)});`,
  );
  await po.waitForTimeout(REVALIDATE_MS + 3000);
  detailText = await openDetails(KM, KM);
  check(
    "J3 ... from `election_owners`, not the approval's copy of it",
    detailText.includes("0539998888") && !detailText.includes("0501112222"),
    detailText.replace(/\s+/g, " ").slice(0, 190),
  );
  check(
    "J4 ... and it arrived without a reload or a navigation, like everything else here",
    navigations === 0 &&
      (await po.evaluate(() => window.__kbSentinel)) === "alive",
    `navigations=${navigations}`,
  );

  // A workspace whose Owner row predates the phone requirement: the row is
  // still there, and it says so rather than going missing.
  const legacyPhone = psql(
    `select coalesce(o.phone,'<null>') from public.election_owners o
     join public.election_workspaces w on w.id = o.workspace_id
     where w.name = ${sqlText(live.wsName)};`,
  ).trim();
  check("J5 the legacy Owner genuinely has no number recorded", legacyPhone === "<null>", legacyPhone);
  detailText = await openDetails(live.wsName, live.wsName);
  check(
    "J6 ... and the details say so plainly instead of hiding the row",
    detailText.includes("טלפון הבעלים") && detailText.includes("לא הוזן"),
    detailText.replace(/\s+/g, " ").slice(0, 190),
  );
  check(
    "J7 no regression: the details still carry owner, code, status, end date, modules and the module editor",
    ((t) =>
      t.includes("בעלים live") &&
      t.includes(live.code) &&
      t.includes("מצב") &&
      t.includes("סיום הבחירות") &&
      t.includes("ניהול יום הבחירות"))(detailText),
    detailText.replace(/\s+/g, " ").slice(0, 200),
  );
  await po
    .locator('[data-testid="workspaces-list"] > li')
    .filter({ hasText: live.wsName })
    .getByRole("button", { name: `פרטי ${live.wsName}` })
    .click();
  await po.getByRole("dialog").waitFor({ timeout: 10000 });
  await po.getByRole("button", { name: "עריכת מודולים" }).click();
  await po.getByRole("dialog").filter({ hasText: "עריכת מודולים" }).waitFor({ timeout: 10000 });
  check(
    "J8 ... and the module editor still opens from it",
    (await po.getByRole("dialog").getByRole("checkbox").count()) >= 1,
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  // =======================================================================
  section("K. EDITING THE ELECTION OWNER'S OWN ACCOUNT");
  // =======================================================================
  // The dialog acts on the OWNER. Nothing about the system may move: the
  // snapshot below is compared field for field at the end of the section.
  const systemSnapshot = () =>
    psql(`
      select (select w.name || '|' || w.login_code || '|' || w.election_end_at::text
              from public.election_workspaces w where w.name = ${sqlText(KM)})
          || '|mods=' || coalesce((select string_agg(m.module_key, ',' order by m.module_key)
              from public.election_workspace_modules m
              join public.election_workspaces w on w.id = m.workspace_id where w.name = ${sqlText(KM)}), '')
          || '|assign=' || (select count(*)::text from public.multi_entity_assignments a
              join public.election_workspaces w on w.id = a.workspace_id where w.name = ${sqlText(KM)})
          || '|users=' || (select count(*)::text from public.election_day_permission_users u
              join public.election_workspaces w on w.id = u.workspace_id where w.name = ${sqlText(KM)})
          || '|owners=' || (select count(*)::text from public.election_owners o
              join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)})
          || '|ownerauth=' || (select o.auth_user_id::text from public.election_owners o
              join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)});
    `).trim();
  const beforeSystem = systemSnapshot();

  const openOwnerDialog = async (wsName) => {
    await po
      .locator('[data-testid="workspaces-list"] > li')
      .filter({ hasText: wsName })
      .getByRole("button", { name: `פרטי ${wsName}` })
      .click();
    await po.getByRole("dialog").waitFor({ timeout: 10000 });
    await po.getByTestId("edit-owner").click();
    await po.locator('[data-testid="owner-account-dialog"]').waitFor({ timeout: 15000 });
    // The frame renders immediately; its CONTENT waits on the server read.
    await po.locator('input[name="owner-account-username"]').waitFor({ timeout: 20000 });
  };
  const closeOwnerDialog = async () => {
    await po.getByRole("button", { name: "סגירה" }).last().click();
    await po
      .locator('[data-testid="owner-account-dialog"]')
      .waitFor({ state: "detached", timeout: 10000 });
  };

  // The action exists where there IS an Owner, and not where there is none.
  await po
    .locator('[data-testid="workspaces-list"] > li')
    .filter({ hasText: ownerless.name })
    .getByRole("button", { name: `פרטי ${ownerless.name}` })
    .click();
  await po.getByRole("dialog").waitFor({ timeout: 10000 });
  check(
    "K1 a workspace with no Owner offers no Owner editing",
    (await po.getByTestId("edit-owner").count()) === 0,
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  await openOwnerDialog(KM);
  const dialogText = await po.locator('[data-testid="owner-account-dialog"]').innerText();
  const persisted = psql(
    `select o.name || '|' || o.email || '|' || coalesce(o.phone,'') from public.election_owners o
     join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)};`,
  ).trim();
  const [pName, pEmail, pPhone] = persisted.split("|");
  // The details are an editable form, so the values are the fields' values.
  const shownProfile = [
    await po.locator('input[name="owner-account-name"]').inputValue(),
    await po.locator('input[name="owner-account-email"]').inputValue(),
    await po.locator('input[name="owner-account-phone"]').inputValue(),
  ].join("|");
  check(
    "K2 the dialog shows the Owner's persisted name, e-mail and phone",
    shownProfile === `${pName}|${pEmail}|${pPhone}`,
    `${persisted} :: ${shownProfile}`,
  );
  const pwField = po.locator('input[name="owner-account-new-password"]');
  check(
    "K3 the password field is empty and masked - no existing password is ever shown",
    (await pwField.inputValue()) === "" && (await pwField.getAttribute("type")) === "password",
  );
  const storedHash = psql(
    `select substring(u.encrypted_password from 1 for 20) from auth.users u
     join public.election_owners o on o.auth_user_id = u.id
     join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)};`,
  ).trim();
  check(
    "K3b ... and the stored credential appears nowhere on the page",
    storedHash.length > 10 && !(await po.locator("body").innerText()).includes(storedHash),
  );
  check(
    "K4 the Owner's current login username is shown",
    (await po.locator('input[name="owner-account-username"]').inputValue()) ===
      `cu km ${stamp}`,
    await po.locator('input[name="owner-account-username"]').inputValue(),
  );
  check(
    "K5 the login address offered is the SHARED login - not a new route",
    dialogText.includes("kolbox-auth.vercel.app/login") &&
      !dialogText.includes("/election-day/owner-login"),
  );

  // --- username change ----------------------------------------------------
  const newUsername = `cu km renamed ${stamp}`;
  await po.locator('input[name="owner-account-username"]').fill(newUsername);
  await po.getByTestId("owner-username-save").click();
  await po.getByText("שם המשתמש עודכן").waitFor({ timeout: 20000 });
  check(
    "K6 the new username is persisted in the identity directory",
    psql(
      `select count(*)::text from public.auth_identities i
       join public.election_owners o on o.auth_user_id = i.auth_user_id
       join public.election_workspaces w on w.id = o.workspace_id
       where w.name = ${sqlText(KM)} and i.username = ${sqlText(newUsername)} and i.realm = 'election_owner';`,
    ).trim() === "1",
  );
  const resolvesToOwner = psql(
    `select count(*)::text from public.auth_identity_resolve('election_owner', ${sqlText(newUsername)}) r
     where r.auth_user_id = (
       select o.auth_user_id from public.election_owners o
       join public.election_workspaces w on w.id = o.workspace_id
       where w.name = ${sqlText(KM)});`,
  ).trim();
  check(
    "K7 ... and it resolves to THIS Owner through the same resolver the login uses",
    resolvesToOwner === "1",
    `rows=${resolvesToOwner}`,
  );
  const oldResolves = psql(
    `select count(*)::text from public.auth_identity_resolve('election_owner', ${sqlText(`cu km ${stamp}`)});`,
  ).trim();
  check("K8 ... while the OLD username resolves to nobody", oldResolves === "0", `rows=${oldResolves}`);
  await closeOwnerDialog();
  await openOwnerDialog(KM);
  check(
    "K9 reopening the dialog reloads the saved username from the server",
    (await po.locator('input[name="owner-account-username"]').inputValue()) === newUsername,
    await po.locator('input[name="owner-account-username"]').inputValue(),
  );

  // --- password change ----------------------------------------------------
  const newOwnerPw = randomPassword();
  await po.locator('input[name="owner-account-new-password"]').fill("short");
  await po.getByTestId("owner-password-save").click();
  await po.getByText("הסיסמה חייבת להכיל לפחות 8 תווים").waitFor({ timeout: 10000 });
  check("K10 a too-short password is refused before anything is sent", true);
  check(
    "K10b ... and the old password still works after that refusal",
    (await signIn(kmMail, kmPw).then(() => true, () => false)),
  );

  await po.locator('input[name="owner-account-new-password"]').fill(newOwnerPw);
  await po.getByTestId("owner-password-save").click();
  await po.getByText("הסיסמה עודכנה").waitFor({ timeout: 20000 });
  check(
    "K11 the field is cleared the moment the password is set",
    (await po.locator('input[name="owner-account-new-password"]').inputValue()) === "",
  );
  check(
    "K12 the NEW password signs the Owner in",
    await signIn(kmMail, newOwnerPw).then(() => true, () => false),
  );
  check(
    "K13 ... and the OLD password no longer does",
    !(await signIn(kmMail, kmPw).then(() => true, () => false)),
  );
  await closeOwnerDialog();

  // --- nothing about the SYSTEM moved -------------------------------------
  check(
    "K14 the workspace, its code, end date, modules, assignments, users and Owner row are untouched",
    systemSnapshot() === beforeSystem,
    `${beforeSystem} -> ${systemSnapshot()}`,
  );

  // --- authorization ------------------------------------------------------
  const rawPost = (body, headers = {}) =>
    fetch(`${PBASE}/api/platform/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: PBASE, ...headers },
      body: JSON.stringify(body),
    }).then((r) => r.status);
  const wsId = psql(
    `select id from public.election_workspaces where name = ${sqlText(KM)};`,
  ).trim();
  check(
    "K15 the account read is refused without a session",
    (await fetch(`${PBASE}/api/platform/session?op=owner_account&workspaceId=${wsId}`).then(
      (r) => r.status,
    )) === 401,
  );
  check(
    "K16 setting a username is refused without a session",
    (await rawPost({ op: "set_owner_username", workspaceId: wsId, username: "x y" })) === 401,
  );
  check(
    "K17 setting a password is refused without a session",
    (await rawPost({ op: "set_owner_password", workspaceId: wsId, password: "abcdefgh" })) === 401,
  );
  check(
    "K18 a foreign Origin is refused before anything else",
    (await rawPost(
      { op: "set_owner_password", workspaceId: wsId, password: "abcdefgh" },
      { origin: "https://evil.invalid" },
    )) === 403,
  );
  check(
    "K19 an unknown body key is refused pre-auth - no smuggling extra fields",
    (await rawPost({
      op: "set_owner_username",
      workspaceId: wsId,
      username: "x y",
      authUserId: "00000000-0000-4000-8000-000000000000",
    })) === 400,
  );

  // --- profile editing -----------------------------------------------------
  const auditRows = (action) =>
    psql(
      `select count(*)::text from public.platform_owner_account_audit a
       join public.election_workspaces w on w.id = a.target_workspace_id_snapshot
       where w.name = ${sqlText(KM)} and a.action = ${sqlText(action)};`,
    ).trim();

  await openOwnerDialog(KM);
  const editedName = "נחום משה הבעלים";
  const editedEmail = `km-edited-${stamp}@console-ui.invalid`;
  await po.locator('input[name="owner-account-name"]').fill(editedName);
  await po.locator('input[name="owner-account-email"]').fill(editedEmail);
  await po.locator('input[name="owner-account-phone"]').fill("052-777-6655");
  await po.getByTestId("owner-profile-save").click();
  await po.getByText("פרטי הבעלים עודכנו").waitFor({ timeout: 20000 });

  const afterEdit = psql(
    `select o.name || '|' || o.email || '|' || coalesce(o.phone,'') from public.election_owners o
     join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)};`,
  ).trim();
  check(
    "K21 name, e-mail and phone persist - the phone in the canonical form",
    afterEdit === `${editedName}|${editedEmail}|0527776655`,
    afterEdit,
  );
  await closeOwnerDialog();
  await openOwnerDialog(KM);
  check(
    "K22 ... and a reopened dialog reloads exactly what was stored",
    (await po.locator('input[name="owner-account-name"]').inputValue()) === editedName &&
      (await po.locator('input[name="owner-account-email"]').inputValue()) === editedEmail &&
      (await po.locator('input[name="owner-account-phone"]').inputValue()) === "0527776655",
    [
      await po.locator('input[name="owner-account-name"]').inputValue(),
      await po.locator('input[name="owner-account-email"]').inputValue(),
      await po.locator('input[name="owner-account-phone"]').inputValue(),
    ].join("|"),
  );

  // Editing ONE field must leave the others exactly as they were.
  await po.locator('input[name="owner-account-name"]').fill("נחום משה הבעלים ב");
  await po.getByTestId("owner-profile-save").click();
  await po.getByText("פרטי הבעלים עודכנו").waitFor({ timeout: 20000 });
  check(
    "K23 editing one field leaves the others untouched",
    psql(
      `select o.email || '|' || coalesce(o.phone,'') from public.election_owners o
       join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)};`,
    ).trim() === `${editedEmail}|0527776655`,
  );

  // A refusal must not half-apply.
  await po.locator('input[name="owner-account-phone"]').fill("12345");
  await po.getByTestId("owner-profile-save").click();
  await po.getByText("יש להזין מספר טלפון ישראלי תקין").waitFor({ timeout: 15000 });
  check(
    "K24 an invalid phone is refused and nothing at all is written",
    psql(
      `select o.name || '|' || o.email || '|' || coalesce(o.phone,'') from public.election_owners o
       join public.election_workspaces w on w.id = o.workspace_id where w.name = ${sqlText(KM)};`,
    ).trim() === `נחום משה הבעלים ב|${editedEmail}|0527776655`,
  );
  await closeOwnerDialog();

  check(
    "K25 the system itself is STILL untouched after every profile edit",
    systemSnapshot() === beforeSystem,
    `${beforeSystem} -> ${systemSnapshot()}`,
  );
  // The list joins an approval to its workspace; changing the Owner's e-mail
  // must not knock the row back to "not created yet".
  await po.waitForTimeout(REVALIDATE_MS + 2000);
  check(
    "K25b ... and the system still renders as a real workspace row after the e-mail changed",
    (await po
      .locator('[data-testid="workspaces-list"] > li')
      .filter({ hasText: KM })
      .getAttribute("data-kind")) === "workspace",
  );

  // --- the audit trail -----------------------------------------------------
  check("K26 each real profile change wrote exactly one audit row", auditRows("profile_updated") === "2", auditRows("profile_updated"));
  check("K27 the username change is recorded", auditRows("username_changed") === "1", auditRows("username_changed"));
  check("K28 setting a password is recorded", auditRows("password_set") === "1", auditRows("password_set"));
  const auditShape = psql(
    `select a.action || ' actor=' || (a.acting_platform_owner_auth_user_id = p.auth_user_id)::text
         || ' target=' || (a.target_owner_auth_user_id_snapshot = o.auth_user_id)::text
         || ' ws=' || (a.target_workspace_id_snapshot = w.id)::text
         || ' at=' || (a.performed_at is not null)::text
         || ' details=' || a.details::text
     from public.platform_owner_account_audit a
     join public.election_workspaces w on w.id = a.target_workspace_id_snapshot
     join public.election_owners o on o.workspace_id = w.id
     cross join public.platform_owners p
     where w.name = ${sqlText(KM)}
     order by a.performed_at;`,
  ).trim();
  check(
    "K29 every row names the actor, the target, the workspace and a timestamp",
    auditShape.split("\n").every((l) => l.includes("actor=true target=true ws=true at=true")),
    auditShape.replace(/\n/g, " ~ ").slice(0, 320),
  );
  // `details` alone - the action name lives in its own column, so the word
  // "password" appearing here could only come from recorded content.
  const allDetails = psql(
    `select coalesce(string_agg(a.details::text, ' '), '') from public.platform_owner_account_audit a
     join public.election_workspaces w on w.id = a.target_workspace_id_snapshot
     where w.name = ${sqlText(KM)};`,
  ).trim();
  check(
    "K30 the password row carries NO detail at all, and no row carries secret material",
    auditShape.includes("password_set actor=true target=true ws=true at=true details={}") &&
      !/password|secret|token|hash/i.test(allDetails),
    allDetails.slice(0, 200),
  );
  check(
    "K31 the username row records which name replaced which",
    auditShape.includes(`"from": "cu km ${stamp}"`) &&
      auditShape.includes(`"to": "cu km renamed ${stamp}"`),
    auditShape.replace(/\n/g, " ~ ").slice(0, 320),
  );
  check(
    "K32 a save that changes nothing writes no audit row",
    (() => {
      const before = auditRows("profile_updated");
      psql(
        `select public.platform_update_election_owner(
           (select auth_user_id from public.platform_owners limit 1),
           (select id from public.election_workspaces where name = ${sqlText(KM)}),
           'נחום משה הבעלים ב', ${sqlText(editedEmail)}, '0527776655');`,
      );
      return auditRows("profile_updated") === before;
    })(),
  );

  // --- the audit is append-only, and the function is not reachable ---------
  check(
    "K33 the audit refuses UPDATE and DELETE",
    ["update public.platform_owner_account_audit set action = 'password_set';",
     "delete from public.platform_owner_account_audit;"].every((sql) => {
      try {
        psql(sql);
        return false;
      } catch (e) {
        return String(e).includes("AUDIT_IMMUTABLE");
      }
    }),
  );
  const grants = psql(
    `select string_agg(r || '=' || has_function_privilege(r, 'public.platform_update_election_owner(uuid,uuid,text,text,text)', 'execute')::text, ' ')
     from unnest(array['public','anon','authenticated','service_role']) r;`,
  ).trim();
  check(
    "K34 the update function is reachable ONLY by the privileged server role",
    grants === "public=false anon=false authenticated=false service_role=true",
    grants,
  );
  const tableGrants = psql(
    `select string_agg(r || '=' || has_table_privilege(r,'public.platform_owner_account_audit','insert')::text, ' ')
     from unnest(array['anon','authenticated','service_role']) r;`,
  ).trim();
  check(
    "K35 nothing writes the audit directly - not even the server role",
    tableGrants === "anon=false authenticated=false service_role=false",
    tableGrants,
  );
  check(
    "K36 the profile op is refused without a session, and from a foreign Origin",
    (await rawPost({
      op: "set_owner_profile",
      workspaceId: wsId,
      name: "x",
      email: "x@x.test",
      phone: "",
    })) === 401 &&
      (await rawPost(
        { op: "set_owner_profile", workspaceId: wsId, name: "x", email: "x@x.test", phone: "" },
        { origin: "https://evil.invalid" },
      )) === 403,
  );
  check(
    "K37 ... and an attempt to smuggle a workspace or account change is refused pre-auth",
    (await rawPost({
      op: "set_owner_profile",
      workspaceId: wsId,
      name: "x",
      email: "x@x.test",
      phone: "",
      auth_user_id: "00000000-0000-4000-8000-000000000000",
    })) === 400,
  );

  // =======================================================================
  section("L. ONE MODULE SCREEN, A REAL ACTIVITY LOG, AND MY OWN PASSWORD");
  // =======================================================================
  // --- module management is no longer duplicated --------------------------
  await po.goto(`${PBASE}/platform/workspaces`, { waitUntil: "domcontentloaded" });
  await po.locator('[data-testid="workspaces-list"]').waitFor({ timeout: 25000 });
  const navNow = await navLabels();
  check(
    "L1 the separate module-assignment destination is gone from the navigation",
    !navNow.some((l) => l.includes("הקצאת מודולים")),
    navNow.join(" | "),
  );
  check(
    "L1b ... while every other destination is still there",
    ["מערכות בחירות", "רב-מערכות", "יומן פעולות", "הגדרות"].every((l) =>
      navNow.some((x) => x.includes(l)),
    ),
    navNow.join(" | "),
  );
  await po.goto(`${PBASE}/platform/modules`, { waitUntil: "domcontentloaded" });
  await po.locator('[data-testid="workspaces-list"]').waitFor({ timeout: 25000 });
  check(
    "L2 the retired /platform/modules path redirects into the systems list",
    /\/platform\/workspaces$/.test(po.url()),
    po.url(),
  );

  // The one capability that screen uniquely held - the GLOBAL availability
  // switch - moved to Settings and still works.
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.locator('[data-testid="platform-settings-section"]').waitFor({ timeout: 20000 });
  check(
    "L3 the global module-availability control lives in Settings now",
    (await po.getByTestId("module-availability-open").count()) === 1,
  );
  await po.getByTestId("module-availability-open").click();
  const availabilityDialog = po.getByRole("dialog").filter({ hasText: "זמינות מודולים" });
  await availabilityDialog.waitFor({ timeout: 15000 });
  check(
    "L3b ... and it opens with the real catalog, not an empty shell",
    (await availabilityDialog.getByRole("button").count()) >= 1,
  );
  await po.keyboard.press("Escape");
  await po.getByRole("dialog").waitFor({ state: "detached", timeout: 5000 });

  // --- the activity log ----------------------------------------------------
  await po.getByRole("link", { name: "יומן פעולות" }).first().click();
  await po.locator('[data-testid="activity-list"]').waitFor({ timeout: 25000 });
  const activityRows = po.locator('[data-testid="activity-row"]');
  const rowCount = await activityRows.count();
  const dbCount = Number(
    psql(
      `select (select count(*) from public.platform_owner_account_audit)
            + (select count(*) from public.platform_entitlement_audit)
            + (select count(*) from public.platform_module_availability_audit)
            + (select count(*) from public.multi_entity_audit);`,
    ).trim(),
  );
  check(
    "L4 the log renders real recorded events - as many as the audits actually hold",
    rowCount > 0 && rowCount === Math.min(dbCount, 200),
    `rendered=${rowCount} recorded=${dbCount}`,
  );
  const logText = await po.locator('[data-testid="activity-list"]').innerText();
  check(
    "L5 the account actions this run performed are all in it",
    ["עודכנו פרטי הבעלים", "שונה שם המשתמש", "נקבעה סיסמה לבעלים"].every((a) =>
      logText.includes(a),
    ),
    logText.replace(/\s+/g, " ").slice(0, 200),
  );
  check(
    "L6 ... each with what it was about and when",
    (await activityRows.first().innerText()).trim().length > 0 &&
      (await po
        .locator('[data-testid="activity-row"][data-source="owner_account"]')
        .count()) >= 3 &&
      /\d{1,2}\.\d{1,2}\.\d{4}/.test(logText),
  );
  check(
    "L7 NOTHING that looks like credential material is in the log",
    !/password|secret|token|סיסמה:/i.test(logText),
    logText.replace(/\s+/g, " ").slice(0, 160),
  );
  // A log that shows only what was recorded cannot show what was not.
  const unaudited = psql(
    `select count(*)::text from public.platform_owner_account_audit where action = 'workspace_deleted';`,
  ).trim();
  check("L8 ... and no event type that was never recorded appears", unaudited === "0");

  // --- the Platform Owner's own password ----------------------------------
  const newPoPw = randomPassword();
  await po.getByRole("link", { name: "הגדרות" }).first().click();
  await po.getByTestId("own-password-open").click();
  await po.locator('[data-testid="own-password-form"]').waitFor({ timeout: 15000 });

  await po.locator('input[name="platform-owner-current-password"]').fill("wrong-password-1");
  await po.locator('input[name="platform-owner-new-password"]').fill(newPoPw);
  await po.locator('input[name="platform-owner-confirm-password"]').fill(newPoPw);
  await po.getByTestId("own-password-save").click();
  await po.getByText("הסיסמה הנוכחית שגויה").waitFor({ timeout: 20000 });
  check("L9 a wrong current password is refused", true);
  check(
    "L9b ... and the real password still works after that refusal",
    await signIn(email("po"), poPw).then(() => true, () => false),
  );

  await po.locator('input[name="platform-owner-current-password"]').fill(poPw);
  await po.locator('input[name="platform-owner-new-password"]').fill(newPoPw);
  await po.locator('input[name="platform-owner-confirm-password"]').fill(newPoPw);
  await po.getByTestId("own-password-save").click();
  // The FORM closing is the unambiguous success signal. The toast lingers for
  // seconds, so waiting on its text would match the PREVIOUS save's toast and
  // pass before this one had even been sent.
  await po
    .locator('[data-testid="own-password-form"]')
    .waitFor({ state: "detached", timeout: 25000 });
  check(
    "L10 the NEW password signs the Platform Owner in",
    await signIn(email("po"), newPoPw).then(() => true, () => false),
  );
  check(
    "L11 ... and the OLD one no longer does",
    !(await signIn(email("po"), poPw).then(() => true, () => false)),
  );
  check(
    "L12 the change is recorded, with no detail at all",
    psql(
      `select coalesce(string_agg(a.details::text, ','), '') from public.platform_owner_account_audit a
       join public.platform_owners p on p.auth_user_id = a.acting_platform_owner_auth_user_id
       where a.action = 'self_password_set';`,
    ).trim() === "{}",
  );
  check(
    "L13 ... and it names no Election Owner, because none was involved",
    psql(
      `select count(*)::text from public.platform_owner_account_audit a
       join public.platform_owners p on p.auth_user_id = a.acting_platform_owner_auth_user_id
       where a.action = 'self_password_set'
         and a.target_workspace_id_snapshot is null
         and a.target_owner_auth_user_id_snapshot is null;`,
    ).trim() === "1",
  );
  check(
    "L14 the activity op is refused without a session",
    (await fetch(`${PBASE}/api/platform/session?op=activity`).then((r) => r.status)) === 401,
  );
  check(
    "L15 changing a password is refused without a session, and from a foreign Origin",
    (await rawPost({
      op: "change_own_password",
      currentPassword: "x",
      newPassword: "abcdefghijkl",
    })) === 401 &&
      (await rawPost(
        { op: "change_own_password", currentPassword: "x", newPassword: "abcdefghijkl" },
        { origin: "https://evil.invalid" },
      )) === 403,
  );

  // Trying again in the SAME tab is refused, and the reason is worth stating:
  // changing the password invalidated the very token this console is holding.
  // The screen still renders - the guard has not re-resolved yet - but the
  // next privileged call is rejected. An operator who changes their password
  // has to sign in again before doing anything else.
  await po.getByTestId("own-password-open").click();
  await po.locator('[data-testid="own-password-form"]').waitFor({ timeout: 15000 });
  await po.locator('input[name="platform-owner-current-password"]').fill(newPoPw);
  await po.locator('input[name="platform-owner-new-password"]').fill(poPw);
  await po.locator('input[name="platform-owner-confirm-password"]').fill(poPw);
  await po.getByTestId("own-password-save").click();
  await po.getByText("אין הרשאה לביצוע הפעולה").waitFor({ timeout: 20000 });
  check("L16 the session that changed the password can no longer act with it", true);

  // Signed in afresh, the same flow works again - so it is repeatable, not a
  // one-shot. This also puts the fixture password back.
  const pw2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" })).newPage();
  pw2.on("pageerror", (e) => pageErrors.push(String(e)));
  await pw2.goto(`${PBASE}/platform/login`, { waitUntil: "domcontentloaded" });
  await pw2.locator('input[type="email"]').fill(email("po"));
  await pw2.locator('input[autocomplete="current-password"]').fill(newPoPw);
  await pw2.getByRole("button", { name: "התחברות" }).click();
  await pw2.getByRole("heading", { name: "מסוף בעל הפלטפורמה" }).waitFor({ timeout: 25000 });
  check("L17 the NEW password signs in through the real login screen", true);
  await pw2.getByRole("link", { name: "הגדרות" }).first().click();
  await pw2.getByTestId("own-password-open").click();
  await pw2.locator('[data-testid="own-password-form"]').waitFor({ timeout: 15000 });
  await pw2.locator('input[name="platform-owner-current-password"]').fill(newPoPw);
  await pw2.locator('input[name="platform-owner-new-password"]').fill(poPw);
  await pw2.locator('input[name="platform-owner-confirm-password"]').fill(poPw);
  await pw2.getByTestId("own-password-save").click();
  await pw2
    .locator('[data-testid="own-password-form"]')
    .waitFor({ state: "detached", timeout: 20000 });
  check(
    "L17b ... and the change is repeatable - the original password works again",
    await signIn(email("po"), poPw).then(() => true, () => false),
  );
  await pw2.close();

  // NOTE: section I ends with a sign-out, and a sign-out is global - it
  // revokes the session THIS page keeps revalidating with. It has to come
  // last, after every section that still needs the list on screen.
  // =======================================================================
  section("I. THE PLATFORM OWNER'S ACCOUNT BLOCK NAMES THE OWNER");
  // =======================================================================
  // It showed the e-mail address - which mailbox they happened to sign in
  // with, not who they are. The username is the identity the Platform Owner's
  // own login screen resolves, and it is already in the verified session.
  const poUsername = `cu po ${stamp}`;
  psql(
    `select public.auth_identity_assign('platform_owner', ${sqlText(poUsername)}, '${poUser.user.id}', null, null);`,
  );
  // A fresh sign-in, so the session context is re-resolved from the server.
  const ip = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL" })).newPage();
  ip.on("pageerror", (e) => pageErrors.push(String(e)));
  await ip.goto(`${PBASE}/platform/login`, { waitUntil: "domcontentloaded" });
  await ip.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 20000 });
  await ip.locator('input[type="email"]').fill(email("po"));
  await ip.locator('input[autocomplete="current-password"]').fill(poPw);
  await ip.getByRole("button", { name: "התחברות" }).click();
  await ip.locator('[data-testid="admin-account"]').first().waitFor({ timeout: 25000 });

  const acct = await ip.locator('[data-testid="admin-account"]').first().innerText();
  check("I1 the account block names the Platform Owner by USERNAME", acct.includes(poUsername), acct.replace(/\s+/g, " "));
  check("I2 ... and carries no e-mail address at all", !acct.includes("@"), acct.replace(/\s+/g, " "));
  const acctGeo = await ip.evaluate(() => {
    const el = document.querySelector('[data-testid="admin-account"]');
    const aside = el.closest("aside");
    if (!aside) return null;
    const e = el.getBoundingClientRect();
    const a = aside.getBoundingClientRect();
    return { inBottomHalf: e.top > a.top + a.height / 2, atEndSide: e.right < window.innerWidth / 2 };
  });
  check("I3 ... in the bottom-right block, where it was reported", acctGeo !== null && acctGeo.inBottomHalf, JSON.stringify(acctGeo));
  await ip.screenshot({ path: path.join(outDir, "i-account-identity.png") });

  // Sign-out is untouched.
  await ip.getByRole("button", { name: "התנתקות" }).first().click();
  await ip.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 25000 });
  check(
    "I4 logout still ends the session and returns to the login screen",
    /\/platform\/login$/.test(ip.url()) &&
      (await ip.evaluate(() => {
        try {
          return localStorage.getItem("kb-platform-owner-auth-token") === null;
        } catch {
          return false;
        }
      })),
    ip.url(),
  );
  await ip.close();

  check("Z1 no uncaught page errors anywhere in this run", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  check("RUN completed without an exception", false, `${String(err).split(String.fromCharCode(10)).slice(0, 6).join(" | ")} :: url=${po.url()}`);
} finally {
  await browser.close();
  pServer.close();
  eServer.close();
  psql(`
    delete from public.multi_entity_assignments;
    delete from public.multi_entity_owner;
    delete from public.election_owners where email like '%@${DOMAIN}';
    delete from public.election_workspace_pending_owner_access;
    delete from public.platform_owners;
    delete from public.election_workspaces where name like 'CU %';
    -- The audit is append-only BY DESIGN and refuses DELETE (K33 proves it);
  `);
  await purgeDomainUsers();
}

tally();
