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
const PBASE = `http://127.0.0.1:${P_PORT}`;

process.env.PLATFORM_ALLOWED_ORIGIN = PBASE;
process.env.KOLBOX_ELECTION_APP_BASE_URL = "http://127.0.0.1:5177";
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "http://127.0.0.1:5176";

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

section("BUILD the platform surface against the scratch stack");
const pDist = path.join(outDir, "dist-platform");
build("platform", pDist);
check("B1 the platform bundle built", fs.existsSync(path.join(pDist, "index.html")));

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

const pServer = await startLocalServer({
  distDir: pDist,
  port: P_PORT,
  handlers: { "/api/platform/session": H.platformSession, "/api/health": H.health },
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

  check("Z1 no uncaught page errors anywhere in this run", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (err) {
  check("RUN completed without an exception", false, String(err).split("\n")[0]);
} finally {
  await browser.close();
  pServer.close();
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
