// Platform Stage 6 - REAL-LOCAL API suite for the aggregate-only
// cross-workspace read backend (GET /api/multi-entity/aggregates and
// /api/multi-entity/workspace-aggregates, i.e. me_op=aggregates |
// workspace_aggregates on api/platform/session.ts).
//
// Real GoTrue + real Postgres (the isolated kolboxs5 scratch stack built by
// scripts/stage5/mkScratchStack.mjs), the REAL bundled Vercel handlers, real
// password + TOTP/aal2 sessions, a real PermissionUser cookie session, and
// synthetic *@stage6-api.invalid identities only.
//
// Run:  S5_STACK_DIR=<scratch>/s5stack node scripts/stage6/api-stage6.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else,
// and a localnet guard blocks every non-local request).
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import {
  admin,
  anon,
  callHandler,
  check,
  enrollTotp,
  installLocalnetGuard,
  jwtPayload,
  loadStack,
  psql,
  randomPassword,
  section,
  signIn,
  tally,
  verifyTotp,
} from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const handlers = await buildHandlers();
const a = admin();

const DOMAIN = "stage6-api.invalid";
const ORIGIN = "http://localhost:5173";
const RUN_ID = crypto.randomBytes(4).toString("hex");
const email = (local) => `${local}-${RUN_ID}@${DOMAIN}`;
const SECRET = `S6SECRET${RUN_ID}`; // marker planted in every PII/free-text fixture column

const setFaults = (f) => {
  globalThis.__S5_FAULTS = f;
};
const clearFaults = () => {
  globalThis.__S5_FAULTS = {};
};
clearFaults();

const PS = handlers.platformSession;
const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const pGet = (url, token, extra = {}) => callHandler(PS, { method: "GET", url, headers: auth(token), ...extra });
const pPost = (body, token) =>
  callHandler(PS, { method: "POST", url: "/api/platform/session", headers: { ...auth(token), origin: ORIGIN }, body });
const aggList = (token, extra = "", opts) => pGet(`/api/platform/session?me_op=aggregates${extra}`, token, opts);
const aggOne = (token, wsId, extra = "", opts) =>
  pGet(`/api/platform/session?me_op=workspace_aggregates&workspaceId=${wsId}${extra}`, token, opts);
const keys = (o) => Object.keys(o ?? {}).sort().join(",");
const collected = []; // every Stage 6 response body, for the privacy scan

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

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.platform_owners;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_day_sessions where workspace_id in (select id from public.election_workspaces where name like 'S6API %');
  delete from public.election_day_permission_users where workspace_id in (select id from public.election_workspaces where name like 'S6API %');
  delete from public.election_day_roles where workspace_id in (select id from public.election_workspaces where name like 'S6API %');
  delete from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S6API %');
  delete from public.election_day_not_voting_reasons where workspace_id in (select id from public.election_workspaces where name like 'S6API %');
  delete from public.election_workspaces where name like 'S6API %';
`);
for (const u of await listUsers()) {
  if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

const pw = {};
async function mkUser(local) {
  pw[local] = randomPassword();
  const { data, error } = await a.auth.admin.createUser({ email: email(local), password: pw[local], email_confirm: true });
  if (error) throw new Error(`createUser ${local}: ${error.message}`);
  return data.user.id;
}

const poId = await mkUser("po");
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poId}', 'S6 PO', '${email("po")}');`);
const PO = (await enrollTotp((await signIn(email("po"), pw.po)).client, "s6-po")).token;

// Stage 9: a workspace created outside provisioning has no module
// entitlement, so these fixtures also grant Election Day (as provisioning and
// the Stage 9 backfill do) - otherwise worker login is correctly refused.
const wsRows = psql(`
  with w as (
    insert into public.election_workspaces (name, election_end_at, login_code) values
      ('S6API Alpha', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S6API Beta',  now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S6API Gamma', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
      ('S6API Delta', now() - interval '1 day',   public.election_day_generate_workspace_login_code()),
      ('S6API Eta',   now() + interval '10 days', public.election_day_generate_workspace_login_code())
    returning id, name, login_code
  ), m as (
    insert into public.election_workspace_modules (workspace_id, module_key)
    select id, 'election_day' from w
  )
  select name || '|' || id || '|' || login_code from w;
`).split("\n");
const WS = Object.fromEntries(
  wsRows.map((r) => {
    const [name, id, code] = r.split("|");
    return [name.replace("S6API ", ""), { id, code }];
  }),
);
const LOGIN_CODES = Object.values(WS).map((w) => w.code);

// Alpha: the 12-contact mix (expected reported|12|3|2|7|1|1|3). Every PII /
// free-text column carries SECRET so a leak anywhere is detectable.
const reasons = psql(`
  insert into public.election_day_not_voting_reasons (workspace_id, name, description, is_active, sort_order, requires_follow_up) values
    ('${WS.Alpha.id}', '${SECRET} closed active',   '${SECRET}', true,  1, false),
    ('${WS.Alpha.id}', '${SECRET} closed inactive', '${SECRET}', false, 2, false),
    ('${WS.Alpha.id}', '${SECRET} follow up',       '${SECRET}', true,  3, true),
    ('${WS.Eta.id}',   '${SECRET} foreign closed',  '${SECRET}', true,  1, false)
  returning id;
`).split("\n");
const [rClose, rCloseInactive, rFollow, rForeign] = reasons;
const pii = `'${SECRET}-first', '${SECRET}-last', '05${RUN_ID.slice(0, 8).replace(/[a-f]/g, "7")}', '${SECRET}-street', '${SECRET}-city', '${SECRET}-masad', '${SECRET}-notes', '${SECRET}-coord'`;
const alphaMix = [
  [true, true, true, true, null],
  [true, false, false, false, null],
  [true, false, false, false, rClose],
  [false, false, false, false, rClose],
  [false, false, false, false, rCloseInactive],
  [false, false, false, false, rFollow],
  [false, true, false, false, null],
  [false, true, true, false, null],
  [false, true, true, true, null],
  [false, false, false, false, rForeign],
  [false, false, false, true, null],
  [false, false, false, false, null],
];
psql(
  `insert into public.election_day_voters (workspace_id, first_name, last_name, phone, street, city, masad, notes, coordinator, voted, ride_requested, ride_arranged, ride_completed, not_voting_reason_id) values ` +
    alphaMix
      .map(([v, rq, ar, co, reason]) => `('${WS.Alpha.id}', ${pii}, ${v}, ${rq}, ${ar}, ${co}, ${reason ? `'${reason}'` : "null"})`)
      .join(",\n") +
    ";",
);
const bulk = (ws, n, votedUpTo, rides = false) =>
  psql(`insert into public.election_day_voters (workspace_id, first_name, last_name, phone, notes, voted, ride_requested, ride_arranged, ride_completed)
        select '${ws}', '${SECRET}-first', '${SECRET}-last' || g, '${SECRET}', '${SECRET}', g <= ${votedUpTo}, ${rides}, ${rides}, ${rides}
        from generate_series(1, ${n}) g;`);
bulk(WS.Beta.id, 10, 4);
bulk(WS.Gamma.id, 3, 3);
bulk(WS.Delta.id, 20, 20);
bulk(WS.Eta.id, 15, 15, true);
const VOTER_IDS = psql(`select string_agg(id::text, ',') from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S6API %');`).split(",");

// Election Owner (aal1 is its normal level) on Beta.
const eoId = await mkUser("eo");
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WS.Beta.id}', '${eoId}', 'S6 EO', '${email("eo")}');`);
const EO = (await signIn(email("eo"), pw.eo)).token;

// Self-registered stranger with a verified TOTP factor (aal2, no role).
await mkUser("stranger");
const STRANGER = (await enrollTotp((await signIn(email("stranger"), pw.stranger)).client, "s6-stranger")).token;

// A REAL PermissionUser session on Alpha via the real Election session handler.
const puName = `s6api-pu-${RUN_ID}`;
const puPw = randomPassword();
psql(`
  with r as (
    insert into public.election_day_roles (workspace_id, name, description, permissions, scope_type)
    values ('${WS.Alpha.id}', 'S6API role ${RUN_ID}', '', '{}', 'all') returning id)
  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  select '${WS.Alpha.id}', '${puName}', extensions.crypt('${puPw}', extensions.gen_salt('bf')), id from r;
`);
const puLogin = await callHandler(handlers.electionSession, {
  method: "POST",
  url: "/api/election-day/session",
  headers: { origin: ORIGIN },
  body: { name: puName, password: puPw, workspaceCode: WS.Alpha.code },
});
const cookieHeader = String(puLogin.headers["set-cookie"] ?? "");
const PU_COOKIE = /^__Host-kb_ed_session=([^;]+)/.exec(cookieHeader)?.[1] ?? "";
const puControl = await callHandler(handlers.electionSession, {
  method: "GET",
  url: "/api/election-day/session",
  headers: {},
  cookies: { "__Host-kb_ed_session": PU_COOKIE },
});

// The Multi-Entity seat, provisioned through the REAL Platform op, activated
// through its real one-time link, then elevated with TOTP.
const prov = await pPost({ op: "provision_multi_entity_owner", name: "S6 Seat", email: email("me") }, PO);
const meId = prov.body?.seatAuthUserId;
const meLink = prov.body?.activationLink ?? "";
const meSetup = anon();
await meSetup.auth.verifyOtp({ token_hash: new URL(meLink).searchParams.get("token_hash"), type: "recovery" });
const mePw = randomPassword();
await meSetup.auth.updateUser({ password: mePw });
await meSetup.auth.signOut();
const meAal1 = await signIn(email("me"), mePw);
const ME_AAL1 = meAal1.token;
const meFactor = await enrollTotp(meAal1.client, "s6-me");
let ME = meFactor.token;

check(
  "SETUP fixtures ready (PO aal2, 5 workspaces, EO, stranger, PermissionUser session, seat aal2)",
  !!PO && Object.keys(WS).length === 5 && !!EO && !!STRANGER && puLogin.statusCode === 200 && !!PU_COOKIE &&
    puControl.statusCode === 200 && prov.statusCode === 201 && jwtPayload(ME).aal === "aal2" &&
    jwtPayload(ME_AAL1).aal === "aal1",
  `pu=${puLogin.statusCode}/${puControl.statusCode} prov=${prov.statusCode}`,
);

const EXPECT = {
  Alpha: { contactsTotal: 12, voted: 3, followUpClosed: 2, followUpRemaining: 7, rideNeeded: 1, rideArranged: 1, rideCompleted: 3 },
  Beta: { contactsTotal: 10, voted: 4, followUpClosed: 0, followUpRemaining: 6, rideNeeded: 0, rideArranged: 0, rideCompleted: 0 },
  Eta: { contactsTotal: 15, voted: 15, followUpClosed: 0, followUpRemaining: 0, rideNeeded: 0, rideArranged: 0, rideCompleted: 15 },
};
const METRIC_KEYS = "contactsTotal,followUpClosed,followUpRemaining,rideArranged,rideCompleted,rideNeeded,voted";
const ROW_KEYS = "assignedAt,electionEndAt,metrics,name,status,workspaceId";
// Stage 9 added unavailableWorkspaceCount (workspaces without Election Day).
const TOTALS_KEYS = "endedWorkspaceCount,metrics,reportedWorkspaceCount,suppressedWorkspaceCount,unavailableWorkspaceCount,workspaceCount";
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// ---------------------------------------------------------------------------
section("ZERO ASSIGNMENTS");
{
  const r = await aggList(ME);
  collected.push(r.body);
  check("Z1 aal2 seat holder, zero assignments -> 200", r.statusCode === 200, String(r.statusCode));
  check("Z1 exact top-level keys {workspaces,totals}", keys(r.body) === "totals,workspaces", keys(r.body));
  check("Z1 empty list and all-zero totals",
    Array.isArray(r.body?.workspaces) && r.body.workspaces.length === 0 &&
      same(r.body?.totals, { workspaceCount: 0, reportedWorkspaceCount: 0, suppressedWorkspaceCount: 0, endedWorkspaceCount: 0, unavailableWorkspaceCount: 0,
        metrics: { contactsTotal: 0, voted: 0, followUpClosed: 0, followUpRemaining: 0, rideNeeded: 0, rideArranged: 0, rideCompleted: 0 } }),
    JSON.stringify(r.body?.totals));
  check("Z1 Cache-Control: no-store", r.headers["cache-control"] === "no-store");
  const one = await aggOne(ME, WS.Alpha.id);
  check("Z2 any workspace while nothing is assigned -> 403 FORBIDDEN", one.statusCode === 403 && same(one.body, { error: "FORBIDDEN" }));
}

// ---------------------------------------------------------------------------
section("AUTHORIZATION (every principal, both ops)");
for (const wsName of ["Alpha", "Beta", "Gamma", "Delta"]) {
  await pPost({ op: "assign_workspace", workspaceId: WS[wsName].id }, PO);
}
{
  const cases = [
    ["anonymous", null, {}],
    ["seat holder at aal1", ME_AAL1, {}],
    ["self-registered aal2 stranger", STRANGER, {}],
    ["Platform Owner aal2", PO, {}],
    ["Election Owner", EO, {}],
    ["PermissionUser (real cookie session)", null, { cookies: { "__Host-kb_ed_session": PU_COOKIE } }],
    ["PermissionUser token presented as Bearer", PU_COOKIE, {}],
    ["garbage token", "not.a.jwt", {}],
  ];
  for (const [label, token, opts] of cases) {
    const l = await aggList(token, "", opts);
    const o = await aggOne(token, WS.Alpha.id, "", opts);
    collected.push(l.body, o.body);
    check(`AZ ${label} -> 401 on aggregates`, l.statusCode === 401 && same(l.body, { error: "UNAUTHORIZED" }) && l.headers["cache-control"] === "no-store", String(l.statusCode));
    check(`AZ ${label} -> 401 on workspace-aggregates (assigned ws)`, o.statusCode === 401 && same(o.body, { error: "UNAUTHORIZED" }), String(o.statusCode));
  }
  const [h, p, sig] = ME.split(".");
  const tampered = `${h}.${p}.${sig.slice(0, -4)}${sig.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
  check("AZ tampered-signature seat token -> 401", (await aggList(tampered)).statusCode === 401);
  const swapped = `${h}.${Buffer.from(JSON.stringify({ ...jwtPayload(ME), sub: poId })).toString("base64url")}.${sig}`;
  check("AZ payload swapped to another sub -> 401", (await aggList(swapped)).statusCode === 401);
  check("AZ control: aal2 seat holder -> 200", (await aggList(ME)).statusCode === 200);
}

// ---------------------------------------------------------------------------
section("AGGREGATE CORRECTNESS + CROSS-WORKSPACE TOTALS");
let listBody;
{
  const r = await aggList(ME);
  listBody = r.body;
  collected.push(r.body);
  const rows = r.body?.workspaces ?? [];
  check("AC1 exactly the 4 current assignments, ordered by name", rows.map((w) => w.name).join(",") === "S6API Alpha,S6API Beta,S6API Delta,S6API Gamma", rows.map((w) => w.name).join(","));
  check("AC1 every row has exactly the approved keys", rows.every((w) => keys(w) === ROW_KEYS), rows.map(keys).join(" / "));
  const by = Object.fromEntries(rows.map((w) => [w.name.replace("S6API ", ""), w]));
  check("AC2 Alpha reported with the exact dashboard-definition counts", by.Alpha?.status === "reported" && same(by.Alpha?.metrics, EXPECT.Alpha), JSON.stringify(by.Alpha?.metrics));
  check("AC2 Alpha metrics keys exact", keys(by.Alpha?.metrics) === METRIC_KEYS);
  check("AC3 Beta (exactly 10 contacts) reported", by.Beta?.status === "reported" && same(by.Beta?.metrics, EXPECT.Beta), JSON.stringify(by.Beta?.metrics));
  check("AC4 Gamma (3 contacts) suppressed with metrics null", by.Gamma?.status === "suppressed" && by.Gamma?.metrics === null);
  check("AC5 Delta (ended, 20 contacts) ended with metrics null", by.Delta?.status === "ended" && by.Delta?.metrics === null);
  check("AC6 metadata carried per row (id, name, end, assignedAt)", by.Alpha?.workspaceId === WS.Alpha.id && typeof by.Alpha?.electionEndAt === "string" && typeof by.Alpha?.assignedAt === "string");
  check("AC7 totals keys exact", keys(r.body?.totals) === TOTALS_KEYS && keys(r.body?.totals?.metrics) === METRIC_KEYS);
  check("AC7 totals = sum over REPORTED rows only (suppressed/ended contribute nothing)",
    same(r.body?.totals, { workspaceCount: 4, reportedWorkspaceCount: 2, suppressedWorkspaceCount: 1, endedWorkspaceCount: 1, unavailableWorkspaceCount: 0,
      metrics: { contactsTotal: 22, voted: 7, followUpClosed: 2, followUpRemaining: 13, rideNeeded: 1, rideArranged: 1, rideCompleted: 3 } }),
    JSON.stringify(r.body?.totals));
  const r2 = await aggList(ME);
  check("AC8 deterministic: an immediate second call is byte-identical", JSON.stringify(r2.body) === JSON.stringify(r.body));

  const one = await aggOne(ME, WS.Alpha.id);
  collected.push(one.body);
  check("AC9 single-workspace op returns exactly the list row (one definition, two paths)", one.statusCode === 200 && same(one.body, by.Alpha), JSON.stringify(one.body));
  check("AC9 Cache-Control: no-store on 200", one.headers["cache-control"] === "no-store");
  const g = await aggOne(ME, WS.Gamma.id);
  const d = await aggOne(ME, WS.Delta.id);
  collected.push(g.body, d.body);
  check("AC10 single-workspace suppressed -> 200 status suppressed, metrics null", g.statusCode === 200 && g.body?.status === "suppressed" && g.body?.metrics === null);
  check("AC10 single-workspace ended -> 200 status ended, metrics null", d.statusCode === 200 && d.body?.status === "ended" && d.body?.metrics === null);
}

// ---------------------------------------------------------------------------
section("WORKSPACE SCOPE + FRESHNESS");
{
  const eta = await aggOne(ME, WS.Eta.id);
  const rand = await aggOne(ME, crypto.randomUUID());
  const flipped = WS.Alpha.id.slice(0, -1) + (WS.Alpha.id.endsWith("0") ? "1" : "0");
  const tam = await aggOne(ME, flipped);
  collected.push(eta.body, rand.body, tam.body);
  check("WS1 existing-but-unassigned -> 403 FORBIDDEN", eta.statusCode === 403 && same(eta.body, { error: "FORBIDDEN" }));
  check("WS2 nonexistent id -> IDENTICAL 403 body (no enumeration)", rand.statusCode === 403 && same(rand.body, eta.body));
  check("WS3 tampered (one-char-changed) id -> 403", tam.statusCode === 403 && same(tam.body, eta.body));
  check("WS4 upper-case form of an assigned id is the same uuid -> 200 (not a bypass, same authorization)", (await aggOne(ME, WS.Alpha.id.toUpperCase())).statusCode === 200);

  await pPost({ op: "unassign_workspace", workspaceId: WS.Alpha.id }, PO);
  const afterUn = await aggOne(ME, WS.Alpha.id);
  const listUn = await aggList(ME);
  check("WS5 unassigned mid-session -> 403 on the very next request", afterUn.statusCode === 403);
  check("WS5 ... and absent from the list, totals recomputed without it",
    !(listUn.body?.workspaces ?? []).some((w) => w.workspaceId === WS.Alpha.id) && listUn.body?.totals?.reportedWorkspaceCount === 1 && listUn.body?.totals?.metrics?.contactsTotal === 10,
    JSON.stringify(listUn.body?.totals));

  await pPost({ op: "assign_workspace", workspaceId: WS.Eta.id }, PO);
  const etaNow = await aggOne(ME, WS.Eta.id);
  collected.push(etaNow.body);
  check("WS6 newly assigned workspace readable on the very next request", etaNow.statusCode === 200 && etaNow.body?.status === "reported" && same(etaNow.body?.metrics, EXPECT.Eta), JSON.stringify(etaNow.body?.metrics));
  check("WS7 the foreign-workspace reason in Eta never closed an Alpha case (Alpha counts stay 2 closed)",
    same(listBody?.workspaces?.find((w) => w.workspaceId === WS.Alpha.id)?.metrics, EXPECT.Alpha));
  await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, PO);
  check("WS8 re-assigned Alpha readable again", (await aggOne(ME, WS.Alpha.id)).statusCode === 200);

  // Concurrency: responses taken while an assignment flips must each be
  // internally consistent (totals == recomputation from that response's own
  // rows) - never a torn mix of two snapshots.
  const flips = [];
  const reads = [];
  for (let i = 0; i < 6; i++) {
    reads.push(aggList(ME));
    flips.push(pPost({ op: i % 2 === 0 ? "unassign_workspace" : "assign_workspace", workspaceId: WS.Beta.id }, PO));
    reads.push(aggList(ME));
  }
  await Promise.all(flips);
  const snaps = await Promise.all(reads);
  const consistent = snaps.every((s) => {
    if (s.statusCode !== 200) return false;
    const rows = s.body.workspaces;
    const rep = rows.filter((w) => w.status === "reported");
    const sum = (k) => rep.reduce((acc, w) => acc + w.metrics[k], 0);
    return s.body.totals.workspaceCount === rows.length && s.body.totals.reportedWorkspaceCount === rep.length &&
      METRIC_KEYS.split(",").every((k) => s.body.totals.metrics[k] === sum(k));
  });
  check("WS9 12 concurrent reads during 6 assignment flips: every response 200 and internally consistent", consistent);
  const betaAssigned = psql(`select count(*) from public.multi_entity_assignments where workspace_id = '${WS.Beta.id}';`);
  if (betaAssigned === "0") await pPost({ op: "assign_workspace", workspaceId: WS.Beta.id }, PO);
}

// ---------------------------------------------------------------------------
section("API INPUT VALIDATION + BYPASS ATTEMPTS");
{
  const noTokBad = await aggOne(null, "not-a-uuid");
  check("IV1 malformed workspaceId -> 400 BEFORE auth (no token needed)", noTokBad.statusCode === 400 && same(noTokBad.body, { error: "INVALID_REQUEST" }) && noTokBad.headers["cache-control"] === "no-store");
  check("IV2 SQL-injection-shaped workspaceId -> 400", (await aggOne(ME, encodeURIComponent("' or 1=1 --"))).statusCode === 400);
  check("IV3 missing workspaceId on workspace-aggregates -> 400", (await pGet("/api/platform/session?me_op=workspace_aggregates", ME)).statusCode === 400);
  check("IV4 duplicate workspaceId -> 400", (await aggOne(ME, WS.Alpha.id, `&workspaceId=${WS.Eta.id}`)).statusCode === 400);
  check("IV5 workspaceId on the list op -> 400 (no client-supplied scope)", (await aggList(ME, `&workspaceId=${WS.Alpha.id}`)).statusCode === 400);
  check("IV5 workspaceIds[] list param on the list op is ignored scope-wise (server-derived set)",
    same((await aggList(ME, `&workspaceIds=${WS.Eta.id}`)).body?.workspaces?.map((w) => w.workspaceId).sort(),
      (await aggList(ME)).body?.workspaces?.map((w) => w.workspaceId).sort()));
  check("IV6 duplicate me_op -> 400", (await pGet("/api/platform/session?me_op=aggregates&me_op=session", ME)).statusCode === 400);
  check("IV7 me_op + op -> 400 (ambiguous principal)", (await pGet("/api/platform/session?me_op=aggregates&op=multi_entity_state", PO)).statusCode === 400);
  const before = psql(`select count(*) from public.multi_entity_assignments;`);
  const post = await callHandler(PS, { method: "POST", url: "/api/platform/session?me_op=aggregates", headers: { ...auth(PO), origin: ORIGIN }, body: { op: "unassign_workspace", workspaceId: WS.Alpha.id } });
  check("IV8 POST to an aggregate op -> 405 + no-store", post.statusCode === 405 && post.headers["cache-control"] === "no-store");
  check("IV8 ... and it changed nothing", psql(`select count(*) from public.multi_entity_assignments;`) === before);
  check("IV9 every error body is exactly {error}", [noTokBad, post].every((x) => keys(x.body) === "error"));

  // Direct PostgREST bypass: neither the anon key nor the seat holder's own
  // aal2 JWT may execute any Stage 6 function directly.
  const { url, key } = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY };
  const asMe = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${ME}` } } });
  for (const [label, client] of [["anon key", anon()], ["seat holder's own aal2 JWT", asMe]]) {
    const l = await client.rpc("multi_entity_list_workspace_aggregates", { p_auth_user_id: meId });
    const g = await client.rpc("multi_entity_get_workspace_aggregate", { p_auth_user_id: meId, p_workspace_id: WS.Alpha.id });
    const c = await client.rpc("multi_entity_compute_workspace_aggregate", { p_auth_user_id: meId, p_workspace_id: WS.Alpha.id });
    check(`BY1 ${label}: direct RPC to all three Stage 6 functions refused`, !!l.error && !!g.error && !!c.error && !l.data && !g.data && !c.data,
      [l.error?.code, g.error?.code, c.error?.code].join(","));
  }
}

// ---------------------------------------------------------------------------
section("STRICT MAPPING (fault-injected RPC rows) + SERVER ERRORS");
{
  const good = { workspace_id: WS.Alpha.id, name: "S6API Alpha", election_end_at: "2099-01-01T00:00:00+00:00", assigned_at: "2026-01-01T00:00:00+00:00",
    report_status: "reported", contacts_total: 10, voted: 4, follow_up_closed: 0, follow_up_remaining: 6, ride_needed: 0, ride_arranged: 0, ride_completed: 0 };
  const run = async (rows, op = "list") => {
    setFaults({ rpc: { [op === "list" ? "multi_entity_list_workspace_aggregates" : "multi_entity_get_workspace_aggregate"]: () => ({ data: rows, error: null }) } });
    const r = op === "list" ? await aggList(ME) : await aggOne(ME, WS.Alpha.id);
    clearFaults();
    return r;
  };
  const extra = await run([{ ...good, login_code: "LEAKME01", first_name: "LEAK" }]);
  check("SM1 an extra column in an RPC row is DROPPED (new object built, never passed through)",
    extra.statusCode === 200 && !JSON.stringify(extra.body).includes("LEAK") && keys(extra.body.workspaces[0]) === ROW_KEYS);
  check("SM2 reported row violating voted+closed+remaining=total -> 500", (await run([{ ...good, follow_up_remaining: 7 }])).statusCode === 500);
  check("SM3 reported row with rides > total -> 500", (await run([{ ...good, ride_needed: 11 }])).statusCode === 500);
  check("SM4 suppressed row carrying a number -> 500 (never publish a withheld count)", (await run([{ ...good, report_status: "suppressed" }])).statusCode === 500);
  check("SM5 unknown status -> 500", (await run([{ ...good, report_status: "partial" }])).statusCode === 500);
  check("SM6 negative / fractional count -> 500", (await run([{ ...good, voted: -1, follow_up_remaining: 11 }])).statusCode === 500 && (await run([{ ...good, voted: 4.5, follow_up_remaining: 5.5 }])).statusCode === 500);
  check("SM7 string count -> 500", (await run([{ ...good, voted: "4" }])).statusCode === 500);
  check("SM8 single op: zero rows -> 403 (fail closed)", (await run([], "one")).statusCode === 403);
  setFaults({ rpc: { multi_entity_list_workspace_aggregates: () => ({ data: null, error: { message: 'relation "x" does not exist at character 42' } }) } });
  const se = await aggList(ME);
  clearFaults();
  check("SM9 raw DB error -> 500 {error:SERVER_ERROR}, no DB text leaked", se.statusCode === 500 && same(se.body, { error: "SERVER_ERROR" }));
  setFaults({ rpc: { multi_entity_get_workspace_aggregate: () => ({ data: null, error: { message: "UNAUTHORIZED" } }) } });
  check("SM10 seat lost between verifier and read (RPC UNAUTHORIZED) -> 401", (await aggOne(ME, WS.Alpha.id)).statusCode === 401);
  clearFaults();
}

// ---------------------------------------------------------------------------
section("REGRESSION (Stage 5 ops, Platform path)");
{
  const s = await pGet("/api/platform/session?me_op=session", ME);
  check("RG1 Stage 5 session op unchanged: keys + metadata-only items", s.statusCode === 200 && keys(s.body) === "authUserId,email,name,workspaces" && s.body.workspaces.every((w) => keys(w) === "assignedAt,electionEndAt,name,workspaceId"));
  check("RG1 Stage 5 session still lists ended/suppressed workspaces as metadata (5 assigned)", s.body?.workspaces?.length === 5);
  const w = await pGet(`/api/platform/session?me_op=workspace&workspaceId=${WS.Gamma.id}`, ME);
  check("RG2 Stage 5 workspace op unchanged", w.statusCode === 200 && keys(w.body) === "assignedAt,electionEndAt,name,workspaceId");
  check("RG3 Platform default GET unchanged", keys((await pGet("/api/platform/session", PO)).body) === "email,platformOwnerId");
  check("RG4 seat token still refused on the Platform path", (await pGet("/api/platform/session", ME)).statusCode === 401);
}

// ---------------------------------------------------------------------------
section("PRIVACY SCAN (every Stage 6 response body collected above)");
{
  const all = JSON.stringify(collected);
  check("PR1 no marker from ANY PII/free-text fixture column (names, phone, street, city, masad, notes, coordinator, reason text)", !all.includes(SECRET));
  check("PR2 no login_code key and no login_code value", !/login_?code/i.test(all) && LOGIN_CODES.every((c) => !all.includes(c)));
  check("PR3 no voter/contact id anywhere", VOTER_IDS.every((id) => !all.includes(id)));
  check("PR4 no identifying key names", !/"(first_?name|last_?name|phone|street|city|masad|notes|coordinator|email|authUserId|reasonId|contactId)"/i.test(all));
  check("PR5 no reason id anywhere", reasons.every((id) => !all.includes(id)));
}

// ---------------------------------------------------------------------------
section("REVOCATION + SEAT REPLACEMENT");
{
  const victim = await signIn(email("me"), mePw);
  const { verifyTotp } = await import("../stage5/lib.mjs");
  const vTok = await verifyTotp(victim.client, meFactor.factorId, meFactor.secret);
  check("RV1 fresh aal2 session works", (await aggList(vTok)).statusCode === 200);
  await victim.client.auth.signOut({ scope: "global" });
  check("RV1 after global sign-out the unexpired token -> 401 immediately", (await aggList(vTok)).statusCode === 401 && (await aggOne(vTok, WS.Beta.id)).statusCode === 401);
  const again = await signIn(email("me"), mePw);
  ME = await verifyTotp(again.client, meFactor.factorId, meFactor.secret);

  const rep = await pPost({ op: "provision_multi_entity_owner", name: "S6 Seat Two", email: email("me2") }, PO);
  check("RV2 seat replaced through the real Platform op", rep.statusCode === 201 && rep.body?.replaced === true);
  check("RV2 replaced holder's still-valid aal2 token -> 401 on aggregates", (await aggList(ME)).statusCode === 401);
  check("RV2 ... and 401 on workspace-aggregates", (await aggOne(ME, WS.Beta.id)).statusCode === 401);
  const n = anon();
  await n.auth.verifyOtp({ token_hash: new URL(rep.body.activationLink).searchParams.get("token_hash"), type: "recovery" });
  const me2Pw = randomPassword();
  await n.auth.updateUser({ password: me2Pw });
  await n.auth.signOut();
  const me2 = await enrollTotp((await signIn(email("me2"), me2Pw)).client, "s6-me2");
  const r = await aggList(me2.token);
  check("RV3 new holder sees the SAME current assignments (no owner column)", r.statusCode === 200 && r.body?.workspaces?.length === 5, String(r.body?.workspaces?.length));
}

process.exitCode = tally("STAGE 6 API") > 0 ? 1 : 0;
