// CONSOLE CONSOLIDATION - "בעלי מערכות" folded into "מערכות בחירות".
//
// Builds the `platform` surface against the isolated kolboxs5 scratch stack,
// serves it through scripts/stage5/localServer.mjs (the real vercel.json
// rewrites -> the real bundled handlers) and drives headless Chromium.
// Synthetic *@console-ui.invalid identities only; nothing secret is printed.
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
  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator('[data-testid="workspace-modules-list"]').waitFor({ timeout: 25000 });
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
  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator('[data-testid="workspace-modules-list"]').waitFor({ timeout: 25000 });
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

  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator('[data-testid="workspace-modules-list"]').waitFor({ timeout: 25000 });
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
  await po.getByRole("link", { name: "הקצאת מודולים" }).click();
  await po.locator('[data-testid="workspace-modules-list"]').waitFor({ timeout: 25000 });
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

  check("Z1 no uncaught page errors anywhere in this run", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  check("RUN completed without an exception", false, String(err).split("\n")[0]);
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
  `);
  await purgeDomainUsers();
}

tally();
