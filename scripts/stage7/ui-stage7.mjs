// Platform Stage 7 - REAL-LOCAL UI suite for the Multi-Entity Owner dashboard.
//
// Builds the multi_entity surface against the isolated kolboxs5 scratch stack
// (scripts/stage5/mkScratchStack.mjs), serves it through
// scripts/stage5/localServer.mjs (vercel.json rewrites -> the REAL bundled
// handlers) and drives it in headless Chromium with a REAL seat holder (real
// GoTrue password + TOTP/aal2) and REAL Stage 6 aggregates computed from
// fixture contacts. Covers data states, "null is never zero", server-totals
// fidelity, freshness, the workspace detail view, forced error paths (500,
// network, malformed body, 401), expired session, seat replacement, privacy
// (DOM + browser storage), accessibility assertions, keyboard use, and
// responsive screenshots with an overflow check at 360/390/768/1280.
//
// Run:  S5_STACK_DIR=<scratch>/s5stack node scripts/stage7/ui-stage7.mjs <outDir>
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-stage7-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const handlers = await buildHandlers();
const a = admin();
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
const DOMAIN = "stage7-ui.invalid";
const RUN_ID = crypto.randomBytes(4).toString("hex");
const email = (l) => `${l}-${RUN_ID}@${DOMAIN}`;
const SECRET = `S7SECRET${RUN_ID}`;
const AGG_PATH = "/api/multi-entity/aggregates";
const ONE_PATH = "/api/multi-entity/workspace-aggregates";
const SESSION_PATH = "/api/multi-entity/session";
const STORAGE_KEY = "kb-multi-entity-owner-auth-token";

section("BUILD multi_entity surface against the scratch stack");
const distDir = path.join(outDir, "dist-multi_entity");
execFileSync(
  process.execPath,
  [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", distDir, "--emptyOutDir", "--logLevel", "error"],
  {
    cwd: repoRoot,
    env: { ...process.env, VITE_APP_SURFACE: "multi_entity", VITE_SUPABASE_URL: stackEnv.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
check("B1 multi_entity bundle built", fs.existsSync(path.join(distDir, "index.html")));

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.platform_owners;
  delete from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S7UI %');
  delete from public.election_day_not_voting_reasons where workspace_id in (select id from public.election_workspaces where name like 'S7UI %');
  delete from public.election_workspaces where name like 'S7UI %';
`);
{
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'S7 PO', '${email("po")}');`);
const PO = (await enrollTotp((await signIn(email("po"), poPw)).client, "s7-po")).token;
const pPost = (body) =>
  callHandler(handlers.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: { authorization: `Bearer ${PO}`, origin: "http://localhost:5173" },
    body,
  });

// Stage 9: raw-SQL fixture workspaces carry no module entitlement; these are
// Election Day workspaces, so they are granted election_day explicitly (as
// provisioning and the Stage 9 backfill do for real ones).
const wsRows = psql(`
  with w as (
    insert into public.election_workspaces (name, election_end_at, login_code) values
      ('S7UI Alpha', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S7UI Beta',  now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S7UI Gamma', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S7UI Delta', now() - interval '1 day',   public.election_day_generate_workspace_login_code()),
      ('S7UI Eta',   now() + interval '10 days', public.election_day_generate_workspace_login_code())
    returning id, name, login_code
  ), m as (
    insert into public.election_workspace_modules (workspace_id, module_key)
    select id, 'election_day' from w
  )
  select name || '|' || id || '|' || login_code from w;
`).split("\n");
const WS = Object.fromEntries(wsRows.map((r) => { const [n, id, code] = r.split("|"); return [n.replace("S7UI ", ""), { id, code, name: n }]; }));
const LOGIN_CODES = Object.values(WS).map((w) => w.code);
const reasons = psql(`
  insert into public.election_day_not_voting_reasons (workspace_id, name, description, is_active, sort_order, requires_follow_up) values
    ('${WS.Alpha.id}', '${SECRET} closed', '${SECRET}', true, 1, false),
    ('${WS.Alpha.id}', '${SECRET} closed inactive', '${SECRET}', false, 2, false),
    ('${WS.Alpha.id}', '${SECRET} follow', '${SECRET}', true, 3, true),
    ('${WS.Eta.id}', '${SECRET} foreign', '${SECRET}', true, 1, false)
  returning id;`).split("\n");
const [rC, rCi, rF, rX] = reasons;
const pii = `'${SECRET}-first', '${SECRET}-last', '0539${RUN_ID.replace(/[a-f]/g, "1").slice(0, 6)}', '${SECRET}-street', '${SECRET}-city', '${SECRET}-masad', '${SECRET}-notes', '${SECRET}-coord'`;
const mix = [
  [true, true, true, true, null], [true, false, false, false, null], [true, false, false, false, rC],
  [false, false, false, false, rC], [false, false, false, false, rCi], [false, false, false, false, rF],
  [false, true, false, false, null], [false, true, true, false, null], [false, true, true, true, null],
  [false, false, false, false, rX], [false, false, false, true, null], [false, false, false, false, null],
];
psql(
  `insert into public.election_day_voters (workspace_id, first_name, last_name, phone, street, city, masad, notes, coordinator, voted, ride_requested, ride_arranged, ride_completed, not_voting_reason_id) values ` +
    mix.map(([v, rq, ar, co, r]) => `('${WS.Alpha.id}', ${pii}, ${v}, ${rq}, ${ar}, ${co}, ${r ? `'${r}'` : "null"})`).join(",\n") + ";",
);
const bulk = (ws, n, votedUpTo, rides = false) =>
  psql(`insert into public.election_day_voters (workspace_id, first_name, last_name, phone, notes, voted, ride_requested, ride_arranged, ride_completed)
        select '${ws}', '${SECRET}-first', '${SECRET}-last' || g, '${SECRET}', '${SECRET}', g <= ${votedUpTo}, ${rides}, ${rides}, ${rides} from generate_series(1, ${n}) g;`);
bulk(WS.Beta.id, 10, 4);
bulk(WS.Gamma.id, 3, 3);
bulk(WS.Delta.id, 20, 20);
bulk(WS.Eta.id, 15, 15, true);
const VOTER_IDS = psql(`select string_agg(id::text, ',') from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S7UI %');`).split(",");

// Seat: provisioned through the real Platform op, activated through its real
// one-time link, TOTP enrolled here (the UI enrollment flow is Stage 5's).
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = BASE;
const prov = await pPost({ op: "provision_multi_entity_owner", name: "בעל רב-מערכות S7", email: email("me") });
const setup = anon();
await setup.auth.verifyOtp({ token_hash: new URL(prov.body.activationLink).searchParams.get("token_hash"), type: "recovery" });
const mePw = randomPassword();
await setup.auth.updateUser({ password: mePw });
await setup.auth.signOut();
const meTotp = await enrollTotp((await signIn(email("me"), mePw)).client, "s7-me");
check("SETUP seat provisioned, activated and TOTP-enrolled; 5 workspaces with fixture contacts", prov.statusCode === 201 && !!meTotp.secret && Object.keys(WS).length === 5);

const server = await startLocalServer({ distDir, port: PORT, handlers: { "/api/platform/session": handlers.platformSession, "/api/health": handlers.health } });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
const page = await context.newPage();
const calls = { agg: 0, one: 0, session: 0 };
const aggBodies = [];
page.on("request", (req) => {
  const p = new URL(req.url()).pathname;
  if (p === AGG_PATH) calls.agg++;
  else if (p === ONE_PATH) calls.one++;
  else if (p === SESSION_PATH) calls.session++;
});
page.on("response", async (res) => {
  if (new URL(res.url()).pathname === AGG_PATH && res.status() === 200) {
    try { aggBodies.push(await res.json()); } catch { /* aborted by a test route */ }
  }
});
const shot = (name) => page.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const bodyText = () => page.locator("body").innerText();
const bodyHtml = () => page.locator("body").innerHTML();
const htmlSeen = [];
const capture = async () => htmlSeen.push(await bodyHtml());
const metricValues = (scope) => page.locator(`${scope} [data-metric]`).evaluateAll((els) => Object.fromEntries(els.map((e) => [e.getAttribute("data-metric"), e.textContent.trim()])));
const cardBy = (name) => page.locator('[data-testid="workspace-card"]').filter({ has: page.getByRole("heading", { name, exact: true }) });
const waitCards = (n) => page.waitForFunction((k) => document.querySelectorAll('[data-testid="workspace-card"]').length === k, n, { timeout: 15000 });
const refreshBtn = () => page.getByRole("button", { name: "רענון" });
const visible = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function loginUi() {
  await page.goto(`${BASE}/multi-entity/login`);
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 15000 });
  await page.locator('input[type="email"]').fill(email("me"));
  await page.locator('input[autocomplete="current-password"]').fill(mePw);
  await page.getByRole("button", { name: "התחברות" }).click();
  await page.getByText("אימות דו-שלבי", { exact: true }).waitFor({ timeout: 15000 });
}
async function passMfa() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.locator('input[autocomplete="one-time-code"]').fill(totp(meTotp.secret, Date.now() + attempt * 30000));
    await page.getByRole("button", { name: "אימות" }).click();
    const ok = await page.getByRole("heading", { name: "המערכות שלי" }).waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

try {
  // -------------------------------------------------------------------------
  section("AUTH (anonymous, aal1, aal2)");
  await page.goto(`${BASE}/multi-entity`);
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 15000 });
  check("AU1 anonymous -> redirected to the Multi-Entity login", page.url().endsWith("/multi-entity/login"));
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Alpha.id}`);
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 15000 });
  check("AU1 anonymous deep link to a workspace -> login", page.url().endsWith("/multi-entity/login"));
  await loginUi();
  check("AU2 password sign-in (aal1) is diverted to the TOTP challenge", !(await bodyText()).includes("המערכות שלי"));
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Alpha.id}`);
  await page.getByText("אימות דו-שלבי", { exact: true }).waitFor({ timeout: 15000 });
  check("AU2 aal1 deep link still shows MFA", !(await bodyText()).includes(WS.Alpha.name));
  check("AU2 ZERO aggregate or session requests at aal1", calls.agg === 0 && calls.one === 0 && calls.session === 0, JSON.stringify(calls));
  // Back to the dashboard URL: after aal2 the guard reveals whatever route is
  // current, and this suite completes MFA on the dashboard.
  await page.goto(`${BASE}/multi-entity`);
  await page.getByText("אימות דו-שלבי", { exact: true }).waitFor({ timeout: 15000 });
  check("AU3 TOTP -> aal2 -> dashboard", await passMfa());

  // -------------------------------------------------------------------------
  section("ZERO ASSIGNMENTS");
  await page.getByText("אין מערכות משויכות").waitFor({ timeout: 15000 });
  check("Z1 zero assignments -> empty state (not an error)", (await page.locator('[data-testid="dashboard-error"]').count()) === 0);
  check("Z1 no summary and no metric on the empty dashboard", (await page.locator('[data-testid="summary"]').count()) === 0 && (await page.locator("[data-metric]").count()) === 0);
  check("Z1 aggregates fetched after aal2", calls.agg >= 1, `agg=${calls.agg}`);
  await shot("01-empty-390");
  await capture();

  // -------------------------------------------------------------------------
  section("DATA STATES + SEMANTICS (mixed: reported x2, suppressed, ended)");
  for (const n of ["Alpha", "Beta", "Gamma", "Delta"]) await pPost({ op: "assign_workspace", workspaceId: WS[n].id });
  await refreshBtn().click();
  await waitCards(4);
  const names = await page.locator('[data-testid="workspace-card"] h3').allInnerTexts();
  check("DS1 four cards in the server's order (name, then id)", names.join(",") === "S7UI Alpha,S7UI Beta,S7UI Delta,S7UI Gamma", names.join(","));
  check("DS1 Stage 5 compatible list: 4 <li> under workspace-list", (await page.locator('[data-testid="workspace-list"] li').count()) === 4);
  const statuses = await page.locator('[data-testid="workspace-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
  check("DS2 statuses reported, reported, ended, suppressed", statuses.join(",") === "reported,reported,ended,suppressed", statuses.join(","));
  const badgeTexts = await page.locator('[data-testid="workspace-status"]').allInnerTexts();
  check("DS2 every status is stated in words (not color alone)", badgeTexts.join("|") === "פעילה|פעילה|הבחירות הסתיימו|פעילה · נתונים מוסתרים", badgeTexts.join("|"));
  const alpha = await metricValues(`[data-testid="workspace-card"][data-status="reported"]:has(h3:text-is("S7UI Alpha"))`);
  check("DS3 Alpha shows exactly the Stage 6 counts (+ voted share from released counts)",
    JSON.stringify(alpha) === JSON.stringify({ contactsTotal: "12", voted: "3", votedPct: "25%", followUpRemaining: "7", followUpClosed: "2", rideNeeded: "1", rideArranged: "1", rideCompleted: "3" }), JSON.stringify(alpha));
  const beta = await metricValues(`[data-testid="workspace-card"]:has(h3:text-is("S7UI Beta"))`);
  check("DS3 Beta (exactly 10 contacts) counts", JSON.stringify(beta) === JSON.stringify({ contactsTotal: "10", voted: "4", votedPct: "40%", followUpRemaining: "6", followUpClosed: "0", rideNeeded: "0", rideArranged: "0", rideCompleted: "0" }), JSON.stringify(beta));
  for (const n of ["Gamma", "Delta"]) {
    const card = cardBy(WS[n].name);
    check(`DS4 ${n} (withheld) renders NO metric element at all`, (await card.locator("[data-metric]").count()) === 0 && (await card.locator("dd").count()) === 0);
    check(`DS4 ${n} shows its privacy/ended notice`, (await card.locator('[data-testid="withheld-notice"]').count()) === 1);
    check(`DS4 ${n} has no detail link (nothing more to show)`, (await card.getByRole("link").count()) === 0);
  }
  const summary = await metricValues('[data-testid="summary"]');
  const serverTotals = aggBodies.at(-1)?.totals;
  check("DS5 summary basis: 2 of 4, withheld workspaces counted separately", (await page.locator('[data-testid="summary-basis"]').innerText()).includes("2 מתוך 4") && (await page.locator('[data-testid="summary-excluded"]').innerText()).includes("1 עם נתונים מוסתרים"));
  check("DS5 summary shows the SERVER totals exactly (no recomputation)",
    serverTotals && ["contactsTotal", "voted", "followUpRemaining", "followUpClosed", "rideNeeded", "rideArranged", "rideCompleted"].every((k) => summary[k] === String(serverTotals.metrics[k])),
    JSON.stringify(summary));
  check("DS5 summary = released rows only (22 contacts, not 22+3+20)", summary.contactsTotal === "22" && summary.voted === "7" && summary.votedPct === "32%");
  await capture();
  for (const [w, h] of [[360, 780], [390, 844], [768, 1024], [1280, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    await shot(`02-dashboard-mixed-${w}`);
    check(`RS1 dashboard: no horizontal overflow at ${w}px`, await noOverflow());
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // -------------------------------------------------------------------------
  section("ACCESSIBILITY + KEYBOARD");
  check("AX1 document is Hebrew RTL", await page.evaluate(() => document.documentElement.dir === "rtl" && document.documentElement.lang.startsWith("he")));
  const heads = await page.locator("h1,h2,h3,h4,h5,h6").evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
  const noSkip = heads.every((lvl, i) => i === 0 || lvl <= heads[i - 1] + 1);
  check("AX2 exactly one h1, first heading is h1, no skipped levels", heads[0] === 1 && heads.filter((l) => l === 1).length === 1 && noSkip, heads.join(""));
  const unnamed = await page.locator("button, a[href]").evaluateAll((els) => els.filter((e) => !(e.getAttribute("aria-label") || e.innerText).trim()).length);
  check("AX3 every button/link has an accessible name", unnamed === 0, `unnamed=${unnamed}`);
  const small = await page.locator("main button, main a[href], header button").evaluateAll((els) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 44 || r.width < 44); }).map((e) => `${e.tagName}:${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
  check("AX4 every control is at least 44x44 px at 390px", small.length === 0, small.join(","));
  await refreshBtn().focus();
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? "").includes("S7UI Alpha"));
  }
  check("AX5 keyboard Tab reaches the Alpha detail link", reached);
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { level: 1, name: WS.Alpha.name }).waitFor({ timeout: 15000 });
  check("AX5 Enter opens the detail view", page.url().endsWith(`/multi-entity/workspaces/${WS.Alpha.id}`));

  // -------------------------------------------------------------------------
  section("WORKSPACE DETAIL");
  const detail = await metricValues('[data-testid="workspace-detail"]');
  check("DT1 detail shows the same counts as the dashboard card", JSON.stringify(detail) === JSON.stringify(alpha), JSON.stringify(detail));
  check("DT1 detail read the single-workspace endpoint", calls.one >= 1, `one=${calls.one}`);
  await shot("03-detail-reported-390");
  await capture();
  for (const w of [360, 768, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await sleep(200);
    await shot(`03-detail-reported-${w}`);
    check(`RS2 detail: no horizontal overflow at ${w}px`, await noOverflow());
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Gamma.id}`);
  await page.locator('[data-testid="workspace-detail"][data-status="suppressed"]').waitFor({ timeout: 15000 });
  check("DT2 suppressed detail: notice, no metric", (await page.locator("[data-metric]").count()) === 0 && (await page.locator('[data-testid="withheld-notice"]').count()) === 1);
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Delta.id}`);
  await page.locator('[data-testid="workspace-detail"][data-status="ended"]').waitFor({ timeout: 15000 });
  check("DT3 ended detail: notice, no metric (no historical numbers)", (await page.locator("[data-metric]").count()) === 0);
  await shot("04-detail-ended-390");
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Eta.id}`);
  await page.locator('[data-testid="workspace-not-available"]').waitFor({ timeout: 15000 });
  check("DT4 existing-but-unassigned id -> not available (server 403)", (await page.locator("[data-metric]").count()) === 0 && !(await bodyText()).includes(WS.Eta.name));
  await page.goto(`${BASE}/multi-entity/workspaces/${crypto.randomUUID()}`);
  await page.locator('[data-testid="workspace-not-available"]').waitFor({ timeout: 15000 });
  check("DT4 nonexistent id -> the same not-available state", true);
  const oneBefore = calls.one;
  await page.goto(`${BASE}/multi-entity/workspaces/not-a-uuid`);
  await page.locator('[data-testid="workspace-not-available"]').waitFor({ timeout: 15000 });
  check("DT5 malformed id -> not available WITHOUT any request", calls.one === oneBefore);
  await shot("05-detail-not-available-390");
  await page.getByTestId("back-to-dashboard").click();
  await waitCards(4);
  check("DT6 back link returns to the dashboard", page.url().endsWith("/multi-entity"));

  // -------------------------------------------------------------------------
  // Stage 9: an assigned workspace WITHOUT the Election Day entitlement stays
  // on the dashboard, marked unavailable, with no number anywhere. Self-
  // contained: the workspace is unassigned again so later checks see 4 cards.
  section("STAGE 9: ASSIGNED WORKSPACE WITHOUT ELECTION DAY");
  const theta = psql(`insert into public.election_workspaces (name, election_end_at, login_code) values ('S7UI Theta', now() + interval '10 days', public.election_day_generate_workspace_login_code()) returning id;`);
  bulk(theta, 12, 12, true);
  await pPost({ op: "assign_workspace", workspaceId: theta });
  await refreshBtn().click();
  await waitCards(5);
  const thetaCard = cardBy("S7UI Theta");
  check("EN1 the unentitled workspace stays on the dashboard, marked unavailable in words",
    (await thetaCard.getAttribute("data-status")) === "unavailable" &&
      (await thetaCard.locator('[data-testid="workspace-status"]').innerText()) === "מודול יום הבחירות אינו פעיל");
  check("EN2 it renders NO metric, shows a notice, and has no detail link",
    (await thetaCard.locator("[data-metric]").count()) === 0 &&
      (await thetaCard.locator('[data-testid="withheld-notice"]').count()) === 1 &&
      (await thetaCard.getByRole("link").count()) === 0);
  await sleep(500); // let the captured response body land in aggBodies
  const lastAgg = aggBodies.at(-1);
  const thetaRow = lastAgg?.workspaces?.find((w) => w.workspaceId === theta);
  check("EN3 the server row is status unavailable with metrics null; totals exclude its 12 contacts",
    thetaRow?.status === "unavailable" && thetaRow?.metrics === null &&
      lastAgg?.totals?.unavailableWorkspaceCount === 1 && lastAgg?.totals?.metrics?.contactsTotal === 22,
    JSON.stringify(lastAgg?.totals));
  check("EN4 the summary names the excluded workspace",
    (await page.locator('[data-testid="summary-excluded"]').innerText()).includes("1 ללא מודול יום הבחירות"));
  await shot("05b-dashboard-unavailable-390");
  await page.goto(`${BASE}/multi-entity/workspaces/${theta}`);
  await page.locator('[data-testid="workspace-detail"][data-status="unavailable"]').waitFor({ timeout: 15000 });
  check("EN5 detail view: unavailable notice, no metric", (await page.locator("[data-metric]").count()) === 0 && (await page.locator('[data-testid="withheld-notice"]').count()) === 1);
  await pPost({ op: "unassign_workspace", workspaceId: theta });
  await page.getByTestId("back-to-dashboard").click();
  await waitCards(4);
  check("EN6 unassigning restores the four-card dashboard", page.url().endsWith("/multi-entity"));

  // -------------------------------------------------------------------------
  section("FRESHNESS");
  const aggBeforeIdle = calls.agg;
  await sleep(6000);
  check("FR1 no polling: zero aggregate requests while idle for 6 s", calls.agg === aggBeforeIdle, `${aggBeforeIdle}->${calls.agg}`);
  await pPost({ op: "unassign_workspace", workspaceId: WS.Beta.id });
  await visible();
  await waitCards(3);
  check("FR2 unassignment disappears on the tab-visible revalidation", !(await bodyText()).includes(WS.Beta.name) && calls.agg > aggBeforeIdle);
  await pPost({ op: "assign_workspace", workspaceId: WS.Eta.id });
  await refreshBtn().click();
  await waitCards(4);
  const eta = await metricValues(`[data-testid="workspace-card"]:has(h3:text-is("S7UI Eta"))`);
  check("FR3 new assignment appears on manual refresh with its own counts", eta.contactsTotal === "15" && eta.voted === "15" && eta.rideCompleted === "15", JSON.stringify(eta));
  await page.goto(`${BASE}/multi-entity/workspaces/${WS.Eta.id}`);
  await page.locator('[data-testid="workspace-detail"]').waitFor({ timeout: 15000 });
  await pPost({ op: "unassign_workspace", workspaceId: WS.Eta.id });
  await refreshBtn().click();
  await page.locator('[data-testid="workspace-not-available"]').waitFor({ timeout: 15000 });
  check("FR4 stale detail corrected: unassigned while open -> not available after refresh, numbers gone", (await page.locator("[data-metric]").count()) === 0);
  await pPost({ op: "unassign_workspace", workspaceId: WS.Alpha.id });
  await page.goto(`${BASE}/multi-entity`);
  await waitCards(2);
  await page.locator('[data-testid="summary-empty"]').waitFor({ timeout: 15000 });
  check("FR5 only withheld workspaces left -> summary says so, shows no zeros", (await page.locator('[data-testid="summary"] [data-metric]').count()) === 0 && (await page.locator('[data-testid="summary-basis"]').innerText()).includes("0 מתוך 2"));
  await shot("06-dashboard-withheld-only-390");
  for (const n of ["Alpha", "Beta"]) await pPost({ op: "assign_workspace", workspaceId: WS[n].id });
  await refreshBtn().click();
  await waitCards(4);

  // -------------------------------------------------------------------------
  section("ERROR + LOADING STATES (forced through route interception)");
  const withRoute = async (pattern, handler, fn) => {
    await page.route(pattern, handler);
    try { await fn(); } finally { await page.unroute(pattern, handler); }
  };
  await withRoute(`**${AGG_PATH}`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"SERVER_ERROR"}' }), async () => {
    await refreshBtn().click();
    await page.locator('[data-testid="dashboard-error"]').waitFor({ timeout: 15000 });
    check("ER1 500 -> error alert, previous numbers removed", (await page.locator("[data-metric]").count()) === 0 && (await page.locator('[data-testid="workspace-card"]').count()) === 0);
    check("ER1 error alert has role=alert and receives focus", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "dashboard-error" && document.activeElement?.getAttribute("role") === "alert"));
    check("ER1 no raw server text shown", !(await bodyText()).includes("SERVER_ERROR"));
    await shot("07-error-390");
  });
  await page.getByRole("button", { name: "נסו שוב" }).click();
  await waitCards(4);
  check("ER2 retry after recovery restores the dashboard", (await page.locator("[data-metric]").count()) > 0);
  await withRoute(`**${AGG_PATH}`, (r) => r.abort("internetdisconnected"), async () => {
    await refreshBtn().click();
    await page.locator('[data-testid="dashboard-error"]').waitFor({ timeout: 15000 });
    check("ER3 network failure -> the same safe error state", (await page.locator("[data-metric]").count()) === 0);
  });
  const good = aggBodies.at(-1);
  const leaky = structuredClone(good);
  const withheldRow = leaky.workspaces.find((w) => w.status !== "reported");
  withheldRow.metrics = { contactsTotal: 3, voted: 3, followUpClosed: 0, followUpRemaining: 0, rideNeeded: 0, rideArranged: 0, rideCompleted: 0 };
  await withRoute(`**${AGG_PATH}`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(leaky) }), async () => {
    await refreshBtn().click();
    await page.locator('[data-testid="dashboard-error"]').waitFor({ timeout: 15000 });
    check("ER4 a withheld row carrying numbers is REFUSED by the client (error, nothing rendered)", (await page.locator("[data-metric]").count()) === 0);
  });
  const broken = structuredClone(good);
  broken.totals.workspaceCount += 1;
  await withRoute(`**${AGG_PATH}`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(broken) }), async () => {
    await refreshBtn().click();
    await page.locator('[data-testid="dashboard-error"]').waitFor({ timeout: 15000 });
    check("ER5 totals that do not describe the rows -> refused", (await page.locator("[data-metric]").count()) === 0);
  });
  const sessBefore = calls.session;
  await withRoute(`**${AGG_PATH}`, (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"UNAUTHORIZED"}' }), async () => {
    await refreshBtn().click();
    await page.locator('[data-testid="dashboard-error"]').waitFor({ timeout: 15000 });
    await sleep(1500);
    check("ER6 aggregate 401 -> the store re-resolves the seat (guard authority), no numbers shown", calls.session >= sessBefore + 2 && (await page.locator("[data-metric]").count()) === 0, `session ${sessBefore}->${calls.session}`);
  });
  await withRoute(`**${AGG_PATH}`, async (r) => { await sleep(2500); await r.continue(); }, async () => {
    await page.goto(`${BASE}/multi-entity`);
    const loadingShown = await page.locator('[data-testid="dashboard-loading"][role="status"]').waitFor({ timeout: 15000 }).then(() => true, () => false);
    check("LD1 first load shows an announced loading state with no numbers", loadingShown && (await page.locator("[data-metric]").count()) === 0);
    await shot("08-loading-390");
    await waitCards(4);
  });
  check("LD1 data arrives after the delayed response", (await page.locator("[data-metric]").count()) > 0);

  // -------------------------------------------------------------------------
  section("PRIVACY (DOM + browser storage)");
  await capture();
  const allHtml = htmlSeen.join("\n") + (await bodyHtml());
  check("PR1 no marker from any PII / free-text fixture column in any rendered DOM", !allHtml.includes(SECRET));
  check("PR2 no login_code value", LOGIN_CODES.every((c) => !allHtml.includes(c)));
  check("PR3 no voter/contact id and no reason id in the DOM", VOTER_IDS.every((id) => !allHtml.includes(id)) && reasons.every((id) => !allHtml.includes(id)));
  const storage = await page.evaluate(async () => ({
    local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
    session: Object.keys(sessionStorage),
    idb: (await indexedDB.databases()).map((d) => d.name),
    caches: typeof caches === "undefined" ? [] : await caches.keys(),
  }));
  check("PR4 localStorage holds ONLY the auth-session key", JSON.stringify(Object.keys(storage.local)) === JSON.stringify([STORAGE_KEY]), Object.keys(storage.local).join(","));
  const sessionBlob = storage.local[STORAGE_KEY] ?? "";
  check("PR4 ...and it carries no aggregate data (no metric names, no workspace names)", !/contactsTotal|followUp|ride(Needed|Arranged|Completed)|metrics|S7UI/.test(sessionBlob));
  check("PR5 sessionStorage, IndexedDB and Cache Storage are empty", storage.session.length === 0 && storage.idb.length === 0 && storage.caches.length === 0, JSON.stringify({ s: storage.session, i: storage.idb, c: storage.caches }));
  await page.reload();
  await page.getByRole("heading", { name: "המערכות שלי" }).waitFor({ timeout: 15000 });
  check("PR6 after a reload the numbers come from a NEW server read (nothing restored)", calls.agg > 0);

  // -------------------------------------------------------------------------
  section("EXPIRED SESSION");
  await page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key));
    s.expires_at = Math.floor(Date.now() / 1000) - 60;
    s.refresh_token = "invalid-refresh-token";
    localStorage.setItem(key, JSON.stringify(s));
  }, STORAGE_KEY);
  await page.reload();
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 20000 });
  check("EX1 expired session with no valid refresh -> login screen, no dashboard numbers", (await page.locator("[data-metric]").count()) === 0);
  await loginUi();
  check("EX2 re-login with TOTP restores the dashboard", await passMfa());
  await waitCards(4);

  // -------------------------------------------------------------------------
  section("SEAT REPLACEMENT -> FORBIDDEN");
  const rep = await pPost({ op: "provision_multi_entity_owner", name: "מחליף S7", email: email("me2") });
  check("RP1 seat replaced through the real Platform op", rep.statusCode === 201 && rep.body?.replaced === true);
  await refreshBtn().click();
  await page.getByText("אין הרשאת גישה").waitFor({ timeout: 15000 });
  check("RP1 replaced holder -> forbidden screen with NO numbers or workspace names", (await page.locator("[data-metric]").count()) === 0 && !(await bodyText()).includes("S7UI"));
  await shot("09-forbidden-390");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await page.getByRole("heading", { name: "כניסת בעל רב-מערכות" }).waitFor({ timeout: 15000 });
  check("RP2 logout clears the Multi-Entity session", !(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)));

  // -------------------------------------------------------------------------
  section("API THROUGH THE REWRITE TABLE");
  const r1 = await fetch(`${BASE}${AGG_PATH}`);
  check("AP1 /api/multi-entity/aggregates without a token -> 401 + no-store", r1.status === 401 && r1.headers.get("cache-control") === "no-store");
  const r2 = await fetch(`${BASE}${ONE_PATH}?workspaceId=not-a-uuid`);
  check("AP2 /api/multi-entity/workspace-aggregates forwards the query (400 pre-auth)", r2.status === 400);
} catch (err) {
  check("UI suite aborted", false, String(err?.message ?? err).split("\n")[0]);
  await shot("99-aborted").catch(() => {});
} finally {
  await browser.close();
  server.close();
  delete process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL;
}

console.log(`\nscreenshots: ${screens}`);
process.exitCode = tally("STAGE 7 UI") === 0 ? 0 : 1;
