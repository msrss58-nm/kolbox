// Platform Stage 5 - REAL-LOCAL API integration suite.
//
// Real GoTrue + real Postgres (the isolated kolboxs5 scratch stack), the REAL
// Vercel handlers (bundled by buildHandlers.mjs), real password + TOTP/aal2
// sessions, synthetic *@stage5-api.invalid identities only.
//
// Covers: rebuilt Stage 4B provisioning coverage (success, duplicate email,
// mint failure, seat failure with confirmed / unconfirmed cleanup, audit-write
// failure, orphan recording + purge, link failure, response contract), every
// existing Platform operation through the shared endpoint, the `me_op`
// partition, Multi-Entity AUTH / MFA / ENTITY scope / freshness, cross-
// principal ROLE ISOLATION (both directions, with positive controls), seat
// replacement + purge, and the GoTrue auth-user-delete cascade.
//
// Run:  S5_STACK_DIR=<scratch>/s5stack node scripts/stage5/api-real-local.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
import { buildHandlers } from "./buildHandlers.mjs";
import {
  admin,
  anon,
  callHandler,
  check,
  enrollTotp,
  installLocalnetGuard,
  jwtHeader,
  jwtPayload,
  loadStack,
  psql,
  randomPassword,
  section,
  signIn,
  tally,
  verifyTotp,
} from "./lib.mjs";

const stackEnv = loadStack();
installLocalnetGuard();
const handlers = await buildHandlers();
const a = admin();

const DOMAIN = "stage5-api.invalid";
const ORIGIN = "http://localhost:5173";
const email = (local) => `${local}@${DOMAIN}`;
// multi_entity_audit is append-only by design, so identities whose audit rows
// are asserted must be unique PER RUN - a fixed email would match a previous
// run's rows (house rule: every test entity carries this run's own marker).
const RUN_ID = crypto.randomBytes(4).toString("hex");
const runEmail = (local) => email(`${local}-${RUN_ID}`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setFaults = (f) => {
  globalThis.__S5_FAULTS = f;
};
const clearFaults = () => {
  globalThis.__S5_FAULTS = {};
};
clearFaults();

const PS = handlers.platformSession;
const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const pGet = (url, token) => callHandler(PS, { method: "GET", url, headers: auth(token) });
const pPost = (body, token, origin = ORIGIN) =>
  callHandler(PS, {
    method: "POST",
    url: "/api/platform/session",
    headers: { ...auth(token), ...(origin ? { origin } : {}) },
    body,
  });
const meGet = (op, token, extra = "") => pGet(`/api/platform/session?me_op=${op}${extra}`, token);
const keys = (o) => Object.keys(o ?? {}).sort().join(",");

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
const userByEmail = async (e) => (await listUsers()).find((u) => u.email === e) ?? null;

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S5API %';
`);
for (const u of await listUsers()) {
  if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

const pw = {};
async function mkUser(local) {
  pw[local] = randomPassword();
  const { data, error } = await a.auth.admin.createUser({
    email: email(local),
    password: pw[local],
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${local}: ${error.message}`);
  return data.user.id;
}

const poId = await mkUser("po");
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${poId}', 'S5 PO', '${email("po")}');`);
const poSession = await signIn(email("po"), pw.po);
const po = await enrollTotp(poSession.client, "s5-po");
const PO = po.token;

const wsRows = psql(`
  insert into public.election_workspaces (name, election_end_at, login_code) values
    ('S5API Alpha', now() + interval '10 days', public.election_day_generate_workspace_login_code()),
    ('S5API Beta',  now() + interval '12 days', public.election_day_generate_workspace_login_code()),
    ('S5API Gamma', now() + interval '14 days', public.election_day_generate_workspace_login_code())
  returning name || '|' || id || '|' || login_code;
`).split("\n");
const WS = Object.fromEntries(
  wsRows.map((r) => {
    const [name, id, code] = r.split("|");
    return [name.replace("S5API ", ""), { id, code }];
  }),
);
const LOGIN_CODES = Object.values(WS).map((w) => w.code);

const eoId = await mkUser("eo");
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WS.Gamma.id}', '${eoId}', 'S5 EO', '${email("eo")}');`);
const EO = (await signIn(email("eo"), pw.eo)).token;

await mkUser("stranger");
const strangerSession = await signIn(email("stranger"), pw.stranger);
const STRANGER = (await enrollTotp(strangerSession.client, "s5-stranger")).token;
check("SETUP fixtures ready", !!PO && !!EO && !!STRANGER && Object.keys(WS).length === 3);

// ---------------------------------------------------------------------------
section("HEALTH");
{
  process.env.VITE_APP_SURFACE = "multi_entity";
  const r1 = await callHandler(handlers.health, {});
  check("HL1 health reports the multi_entity surface", r1.body?.surface === "multi_entity", r1.body?.surface);
  process.env.VITE_APP_SURFACE = "nonsense";
  const r2 = await callHandler(handlers.health, {});
  check("HL2 unknown surface still resolves to election", r2.body?.surface === "election", r2.body?.surface);
  delete process.env.VITE_APP_SURFACE;
}

// ---------------------------------------------------------------------------
section("PLATFORM PATH REGRESSION (shared endpoint)");
{
  const r = await pGet("/api/platform/session", PO);
  check("PL1 default GET -> 200 {platformOwnerId,email} only", r.statusCode === 200 && keys(r.body) === "email,platformOwnerId", keys(r.body));
  const s = await pGet("/api/platform/session?op=multi_entity_state", PO);
  check("PL2 GET op=multi_entity_state -> 200 with the 4 top-level keys", s.statusCode === 200 && keys(s.body) === "pending_auth_cleanup,pending_provisioning_orphans,seat,workspaces", keys(s.body));
  check("PL3 unknown GET op -> 400", (await pGet("/api/platform/session?op=nope", PO)).statusCode === 400);
  check("PL4 POST without Origin -> 403", (await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, PO, null)).statusCode === 403);
  check("PL4 POST foreign Origin -> 403", (await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, PO, "https://evil.example")).statusCode === 403);
  check("PL5 POST unknown op -> 400", (await pPost({ op: "nope" }, PO)).statusCode === 400);
  check("PL5 POST prototype-key op -> 400", (await pPost({ op: "__proto__" }, PO)).statusCode === 400);
  check("PL5 POST extra body key -> 400", (await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id, x: 1 }, PO)).statusCode === 400);
  check("PL6 PUT -> 405", (await callHandler(PS, { method: "PUT", url: "/api/platform/session", headers: auth(PO) })).statusCode === 405);
  check("PL7 stranger aal2 -> 401 (GET)", (await pGet("/api/platform/session", STRANGER)).statusCode === 401);
  check("PL7 stranger aal2 -> 401 (POST)", (await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, STRANGER)).statusCode === 401);
  const pendingEmail = email("pending-eo");
  const co = await pPost({ op: "create_owner_access", name: "Pending EO", email: pendingEmail }, PO);
  const coLink = typeof co.body?.activationLink === "string" ? co.body.activationLink : "";
  check("PL8 create_owner_access -> 201 and its link STILL targets the Election Owner screen", co.statusCode === 201 && coLink.startsWith(`${ORIGIN}/election-day/owner-set-password?`), `status=${co.statusCode}`);
  check("PL9 assign before a seat exists -> 409 MULTI_ENTITY_OWNER_NOT_PROVISIONED", (await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, PO)).body?.error === "MULTI_ENTITY_OWNER_NOT_PROVISIONED");
}

// ---------------------------------------------------------------------------
section("PROVISIONING (rebuilt Stage 4B coverage + Stage 5 link target)");
const CONTRACT_KEYS = "activationLink,alreadyExisted,previousAccountDeleted,previousAuthUserId,replaced,requiresDestructiveApproval,seatAuthUserId";
let me0Id;
let me1Id;
let me1Link;
{
  const r = await pPost({ op: "provision_multi_entity_owner", name: "Me Zero", email: email("me0") }, PO);
  me0Id = r.body?.seatAuthUserId;
  const link = r.body?.activationLink ?? "";
  check("PV1 first provision -> 201 with the exact response contract", r.statusCode === 201 && keys(r.body) === CONTRACT_KEYS, keys(r.body));
  check("PV1 contract values (not replaced, no destructive step)", r.body?.alreadyExisted === false && r.body?.replaced === false && r.body?.previousAuthUserId === null && r.body?.requiresDestructiveApproval === false && UUID_RE.test(me0Id ?? ""));
  check("PV1 link targets /multi-entity/set-password on the local fallback origin", link.startsWith(`${ORIGIN}/multi-entity/set-password?`) && new URL(link).searchParams.get("type") === "recovery" && !!new URL(link).searchParams.get("token_hash"));
  check("PV1 link never targets the Election Owner screen", !link.includes("/election-day/"));

  const dup = await pPost({ op: "provision_multi_entity_owner", name: "Me Zero", email: email("me0") }, PO);
  check("PV2 duplicate email -> 409 EMAIL_ALREADY_REGISTERED", dup.statusCode === 409 && dup.body?.error === "EMAIL_ALREADY_REGISTERED", String(dup.statusCode));

  // Production fail-closed: no configured Multi-Entity origin -> refuse BEFORE createUser.
  process.env.VERCEL_ENV = "production";
  const prodEmail = email("prod-unset");
  const pr = await pPost({ op: "provision_multi_entity_owner", name: "Prod", email: prodEmail }, PO, "https://kolbox-platform.vercel.app");
  delete process.env.VERCEL_ENV;
  check("PV3 production + unset KOLBOX_MULTI_ENTITY_APP_BASE_URL -> 500 SERVER_CONFIG_MISSING", pr.statusCode === 500 && pr.body?.error === "SERVER_CONFIG_MISSING", String(pr.statusCode));
  check("PV3 ... and NO Auth user was created", (await userByEmail(prodEmail)) === null);

  // Configured origin (trailing slash stripped) + replacement contract.
  process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "https://me.example.test/";
  const rep = await pPost({ op: "provision_multi_entity_owner", name: "Me One", email: email("me1") }, PO);
  delete process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL;
  me1Id = rep.body?.seatAuthUserId;
  me1Link = rep.body?.activationLink ?? "";
  check("PV4 configured origin is used (trailing slash stripped)", me1Link.startsWith("https://me.example.test/multi-entity/set-password?"));
  check("PV4 replacement contract (replaced, previous = me0, destructive approval required)", rep.statusCode === 201 && rep.body?.replaced === true && rep.body?.previousAuthUserId === me0Id && rep.body?.requiresDestructiveApproval === true && rep.body?.previousAccountDeleted === false);

  const purge = await pPost({ op: "purge_replaced_auth_user", previousAuthUserId: me0Id }, PO);
  check("PV5 purge_replaced_auth_user -> 200 deleted + audited", purge.statusCode === 200 && purge.body?.previousAccountDeleted === true && purge.body?.auditRecorded === true);
  check("PV5 purged account really gone", (await userByEmail(email("me0"))) === null);
  const purge2 = await pPost({ op: "purge_replaced_auth_user", previousAuthUserId: me0Id }, PO);
  check("PV5 purge is idempotent (alreadyCompleted)", purge2.statusCode === 200 && purge2.body?.alreadyCompleted === true);
  const heldPurge = await pPost({ op: "purge_replaced_auth_user", previousAuthUserId: me1Id }, PO);
  check("PV5 current holder cannot be purged (runbook: purge-first is impossible)", heldPurge.statusCode === 409);

  // Mint failure -> compensating delete, no durable row, no orphan listed.
  setFaults({ rpc: { platform_record_provisioning_auth_mint: () => ({ data: null, error: { message: "boom" } }) } });
  const mf = await pPost({ op: "provision_multi_entity_owner", name: "Mint Fail", email: runEmail("mintfail") }, PO);
  clearFaults();
  check("PV6 mint failure -> 500 SERVER_ERROR, no orphan warning", mf.statusCode === 500 && mf.body?.error === "SERVER_ERROR" && !mf.body?.warning, JSON.stringify(mf.body));
  check("PV6 compensating delete removed the minted account", (await userByEmail(runEmail("mintfail"))) === null);

  // Seat failure + CONFIRMED cleanup -> terminal audit row, nothing pending.
  setFaults({ rpc: { platform_provision_multi_entity_owner: () => ({ data: null, error: { message: "IDENTITY_ALREADY_PRINCIPAL" } }) } });
  const sf = await pPost({ op: "provision_multi_entity_owner", name: "Seat Fail", email: runEmail("seatfail") }, PO);
  clearFaults();
  check("PV7 seat failure -> mapped 409 IDENTITY_ALREADY_PRINCIPAL", sf.statusCode === 409 && sf.body?.error === "IDENTITY_ALREADY_PRINCIPAL" && !sf.body?.warning);
  check("PV7 confirmed cleanup deleted the account", (await userByEmail(runEmail("seatfail"))) === null);
  const sfAudit = psql(`select count(*) from public.multi_entity_audit a join public.multi_entity_audit b on b.orphan_auth_user_id = a.orphan_auth_user_id and b.action = 'provisioning_orphan_deleted' where a.action = 'provisioning_auth_minted' and a.attempted_email = '${runEmail("seatfail")}';`);
  check("PV7 terminal provisioning_orphan_deleted audit row recorded", sfAudit === "1", sfAudit);

  // Seat failure + UNCONFIRMED cleanup -> AUTH_CLEANUP_INCOMPLETE + orphan listed.
  setFaults({
    rpc: { platform_provision_multi_entity_owner: () => ({ data: null, error: { message: "boom" } }) },
    admin: {
      deleteUser: () => ({ data: null, error: { status: 500, message: "simulated" } }),
      getUserById: (id) => ({ data: { user: { id } }, error: null }),
    },
  });
  const uc = await pPost({ op: "provision_multi_entity_owner", name: "Unconfirmed", email: runEmail("unconfirmed") }, PO);
  clearFaults();
  const orphanId = uc.body?.orphanedAuthUserId;
  check("PV8 unconfirmed cleanup -> original code + AUTH_CLEANUP_INCOMPLETE + orphan id", uc.statusCode === 500 && uc.body?.error === "SERVER_ERROR" && uc.body?.warning === "AUTH_CLEANUP_INCOMPLETE" && UUID_RE.test(orphanId ?? ""));
  check("PV8 the account really still exists", !!(await userByEmail(runEmail("unconfirmed"))));
  let st = (await pGet("/api/platform/session?op=multi_entity_state", PO)).body;
  check("PV8 orphan recorded durably (listed by the state RPC)", (st?.pending_provisioning_orphans ?? []).some((o) => o.auth_user_id === orphanId));
  const po1 = await pPost({ op: "purge_provisioning_orphan", authUserId: orphanId }, PO);
  check("PV8 purge_provisioning_orphan -> 200 deleted + audited", po1.statusCode === 200 && po1.body?.accountDeleted === true && po1.body?.auditRecorded === true);
  st = (await pGet("/api/platform/session?op=multi_entity_state", PO)).body;
  check("PV8 orphan no longer listed; account gone", !(st?.pending_provisioning_orphans ?? []).some((o) => o.auth_user_id === orphanId) && (await userByEmail(runEmail("unconfirmed"))) === null);

  // Seat failure + confirmed delete + AUDIT WRITE failure -> truthful warning, converges.
  setFaults({
    rpc: {
      platform_provision_multi_entity_owner: () => ({ data: null, error: { message: "boom" } }),
      platform_record_provisioning_orphan_cleanup: () => ({ data: null, error: { message: "audit down" } }),
    },
  });
  const aw = await pPost({ op: "provision_multi_entity_owner", name: "Audit Fail", email: runEmail("auditfail") }, PO);
  clearFaults();
  check("PV9 audit-write failure -> AUTH_CLEANUP_AUDIT_WRITE_FAILED, accountDeleted true, auditRecorded false", aw.body?.warning === "AUTH_CLEANUP_AUDIT_WRITE_FAILED" && aw.body?.accountDeleted === true && aw.body?.auditRecorded === false && !("orphanedAuthUserId" in (aw.body ?? {})));
  st = (await pGet("/api/platform/session?op=multi_entity_state", PO)).body;
  const awOrphan = (st?.pending_provisioning_orphans ?? []).find((o) => o.attempted_email === runEmail("auditfail"));
  check("PV9 mint row without a terminal row is still listed", !!awOrphan);
  const conv = await pPost({ op: "purge_provisioning_orphan", authUserId: awOrphan?.auth_user_id }, PO);
  check("PV9 purge converges (probes absent, records terminal row)", conv.statusCode === 200 && conv.body?.accountDeleted === true && conv.body?.auditRecorded === true);
}

// ---------------------------------------------------------------------------
section("MULTI-ENTITY ACTIVATION (real one-time link -> password -> TOTP)");
const mePw = randomPassword();
let meFactor;
let ME;
let meClient;
{
  const tokenHash = new URL(me1Link).searchParams.get("token_hash");
  const c = anon();
  const v = await c.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
  check("AC1 one-time link redeems to a session", !v.error && !!v.data.session);
  check("AC1 recovery session is aal1", jwtPayload(v.data.session?.access_token ?? "").aal === "aal1");
  const replay = await anon().auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
  check("AC2 the same link cannot be redeemed twice", !!replay.error);
  const up = await c.auth.updateUser({ password: mePw });
  check("AC3 seat holder sets their own password", !up.error, up.error?.code ?? "");
  await c.auth.signOut();

  const s = await signIn(email("me1"), mePw);
  meClient = s.client;
  check("AC4 password sign-in is only aal1", jwtPayload(s.token).aal === "aal1");
  const aal1Resp = await meGet("session", s.token);
  check("M1 aal1 token called DIRECTLY -> 401", aal1Resp.statusCode === 401);
  const en = await enrollTotp(meClient, "s5-me1");
  meFactor = en;
  ME = en.token;
  check("AC5 TOTP enrollment elevates to aal2", jwtPayload(ME).aal === "aal2");
}

async function meLogin() {
  const s = await signIn(email("me1"), mePw);
  const token = await verifyTotp(s.client, meFactor.factorId, meFactor.secret);
  return { client: s.client, token };
}

// ---------------------------------------------------------------------------
section("AUTH + MFA");
{
  const r = await meGet("session", ME);
  check("AU1 aal2 seat holder -> 200", r.statusCode === 200, String(r.statusCode));
  check("AU1 exact response keys", keys(r.body) === "authUserId,email,name,workspaces", keys(r.body));
  check("AU1 identity is the server-verified seat", r.body?.authUserId === me1Id && r.body?.email === email("me1") && r.body?.name === "Me One");
  check("AU1 zero assignments -> empty list", Array.isArray(r.body?.workspaces) && r.body.workspaces.length === 0);
  check("AU1 Cache-Control: no-store on 200", r.headers["cache-control"] === "no-store");

  const noTok = await meGet("session", null);
  check("AU2 no token -> 401 (+ no-store)", noTok.statusCode === 401 && noTok.headers["cache-control"] === "no-store");
  check("AU2 Basic scheme -> 401", (await callHandler(PS, { url: "/api/platform/session?me_op=session", headers: { authorization: "Basic abc" } })).statusCode === 401);
  check("AU3 garbage token -> 401", (await meGet("session", "not.a.jwt")).statusCode === 401);
  const [h, p, sig] = ME.split(".");
  const tampered = `${h}.${p}.${sig.slice(0, -4)}${sig.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
  check("AU3 tampered signature -> 401", (await meGet("session", tampered)).statusCode === 401);
  const forgedPayload = Buffer.from(JSON.stringify({ ...jwtPayload(ME), sub: poId })).toString("base64url");
  check("AU3 payload swapped to another sub (signature now invalid) -> 401", (await meGet("session", `${h}.${forgedPayload}.${sig}`)).statusCode === 401);

  const alg = jwtHeader(ME).alg;
  if (alg === "HS256" && stackEnv.JWT_SECRET) {
    const exp = { ...jwtPayload(ME), exp: Math.floor(Date.now() / 1000) - 60 };
    const body64 = Buffer.from(JSON.stringify(exp)).toString("base64url");
    const mac = crypto.createHmac("sha256", stackEnv.JWT_SECRET).update(`${h}.${body64}`).digest("base64url");
    check("AU4 validly-signed but EXPIRED token -> 401", (await meGet("session", `${h}.${body64}.${mac}`)).statusCode === 401);
  } else {
    // NOT counted as a pass: a validly-signed expired token cannot be forged
    // without the stack's private signing key. Expiry is still enforced by
    // getUser() and getClaims() (exp) in the verifier.
    console.log(`  [info] AU4 NOT EXECUTED - expired-token forgery needs HS256, stack signs with ${alg}`);
  }

  check("AU5 self-registered aal2 stranger -> 401", (await meGet("session", STRANGER)).statusCode === 401);
  check("AU6 Platform Owner aal2 -> 401", (await meGet("session", PO)).statusCode === 401);
  check("AU7 Election Owner token -> 401", (await meGet("session", EO)).statusCode === 401);

  // Refresh keeps aal2 and keeps working.
  const rs = await meClient.auth.refreshSession();
  const refreshed = rs.data.session?.access_token ?? "";
  check("M2 refreshed session is still aal2", jwtPayload(refreshed).aal === "aal2");
  check("M2 refreshed token -> 200", (await meGet("session", refreshed)).statusCode === 200);

  // Revocation is immediate (getUser runs first).
  const victim = await meLogin();
  check("AU8 fresh aal2 session works", (await meGet("session", victim.token)).statusCode === 200);
  await victim.client.auth.signOut({ scope: "global" });
  check("AU8 after global sign-out, the still-unexpired token -> 401 immediately", (await meGet("session", victim.token)).statusCode === 401);
  const again = await meLogin();
  ME = again.token;
  meClient = again.client;
  check("AU8 re-login restores access", (await meGet("session", ME)).statusCode === 200);
}

// ---------------------------------------------------------------------------
section("API PARTITION");
{
  check("PT1 me_op + POST -> 405", (await callHandler(PS, { method: "POST", url: "/api/platform/session?me_op=session", headers: { ...auth(PO), origin: ORIGIN }, body: { op: "assign_workspace", workspaceId: WS.Alpha.id } })).statusCode === 405);
  check("PT1 ... and that POST did NOT assign anything", psql(`select count(*) from public.multi_entity_assignments;`) === "0");
  check("PT2 me_op + op -> 400 (ambiguous)", (await pGet("/api/platform/session?me_op=session&op=multi_entity_state", PO)).statusCode === 400);
  check("PT3 duplicate me_op -> 400", (await pGet("/api/platform/session?me_op=session&me_op=workspace", ME)).statusCode === 400);
  check("PT4 unknown me_op -> 400", (await meGet("nope", ME)).statusCode === 400);
  check("PT5 session op with workspaceId -> 400", (await meGet("session", ME, `&workspaceId=${WS.Alpha.id}`)).statusCode === 400);
  const bad = await meGet("workspace", null, "&workspaceId=not-a-uuid");
  check("PT6 malformed workspaceId -> 400 BEFORE auth (no token needed)", bad.statusCode === 400);
  check("PT6 missing workspaceId -> 400", (await meGet("workspace", ME)).statusCode === 400);
  check("PT7 empty me_op still belongs to the ME partition -> 400, never the Platform 200", (await pGet("/api/platform/session?me_op=", PO)).statusCode === 400);
}

// ---------------------------------------------------------------------------
section("ENTITY-SCOPED AUTHORIZATION + FRESHNESS");
const bodies = [];
{
  check("EN0 unassigned workspace -> 403", (await meGet("workspace", ME, `&workspaceId=${WS.Alpha.id}`)).statusCode === 403);
  await pPost({ op: "assign_workspace", workspaceId: WS.Alpha.id }, PO);
  const s1 = await meGet("session", ME);
  bodies.push(s1.body);
  check("EN1 newly assigned workspace visible on the very next call", s1.body?.workspaces?.length === 1 && s1.body.workspaces[0].workspaceId === WS.Alpha.id);
  check("EN1 list item keys are exactly the metadata projection", keys(s1.body?.workspaces?.[0]) === "assignedAt,electionEndAt,name,workspaceId");
  const w1 = await meGet("workspace", ME, `&workspaceId=${WS.Alpha.id}`);
  bodies.push(w1.body);
  check("EN2 assigned workspace -> 200 with exact keys", w1.statusCode === 200 && keys(w1.body) === "assignedAt,electionEndAt,name,workspaceId" && w1.body.name === "S5API Alpha");
  check("EN2 Cache-Control: no-store", w1.headers["cache-control"] === "no-store");
  const wBeta = await meGet("workspace", ME, `&workspaceId=${WS.Beta.id}`);
  const wRand = await meGet("workspace", ME, `&workspaceId=${crypto.randomUUID()}`);
  check("EN3 existing-but-unassigned -> 403 FORBIDDEN", wBeta.statusCode === 403 && wBeta.body?.error === "FORBIDDEN");
  check("EN3 nonexistent id -> IDENTICAL 403 body (no enumeration)", wRand.statusCode === 403 && JSON.stringify(wRand.body) === JSON.stringify(wBeta.body));
  await pPost({ op: "assign_workspace", workspaceId: WS.Beta.id }, PO);
  check("EN4 assign Beta -> readable immediately", (await meGet("workspace", ME, `&workspaceId=${WS.Beta.id}`)).statusCode === 200);
  const s2 = await meGet("session", ME);
  bodies.push(s2.body);
  check("EN4 list is in name order (Alpha, Beta)", s2.body?.workspaces?.map((w) => w.name).join(",") === "S5API Alpha,S5API Beta");
  await pPost({ op: "unassign_workspace", workspaceId: WS.Alpha.id }, PO);
  check("EN5 unassigned mid-session -> 403 on the next request", (await meGet("workspace", ME, `&workspaceId=${WS.Alpha.id}`)).statusCode === 403);
  const s3 = await meGet("session", ME);
  bodies.push(s3.body);
  check("EN5 ... and gone from the list", s3.body?.workspaces?.length === 1 && s3.body.workspaces[0].workspaceId === WS.Beta.id);
  const serialized = JSON.stringify(bodies);
  check("EN6 no login_code key and no login_code VALUE in any ME response", !/login_?code/i.test(serialized) && LOGIN_CODES.every((code) => !serialized.includes(code)));
  check("EN7 Election Owner token cannot read an assigned workspace", (await meGet("workspace", EO, `&workspaceId=${WS.Beta.id}`)).statusCode === 401);
  check("EN7 Platform Owner token cannot read an assigned workspace", (await meGet("workspace", PO, `&workspaceId=${WS.Beta.id}`)).statusCode === 401);
}

// ---------------------------------------------------------------------------
section("ROLE ISOLATION (with positive controls)");
{
  check("RI0 control: PO token works on the Platform path", (await pGet("/api/platform/session", PO)).statusCode === 200);
  check("RI1 ME token -> Platform default GET 401", (await pGet("/api/platform/session", ME)).statusCode === 401);
  check("RI1 ME token -> Platform multi_entity_state 401", (await pGet("/api/platform/session?op=multi_entity_state", ME)).statusCode === 401);
  const opBodies = [
    { op: "create_owner_access", name: "x", email: email("x1") },
    { op: "provision_multi_entity_owner", name: "x", email: email("x2") },
    { op: "assign_workspace", workspaceId: WS.Gamma.id },
    { op: "unassign_workspace", workspaceId: WS.Beta.id },
    { op: "purge_replaced_auth_user", previousAuthUserId: crypto.randomUUID() },
    { op: "purge_provisioning_orphan", authUserId: crypto.randomUUID() },
  ];
  for (const b of opBodies) {
    check(`RI1 ME token -> Platform POST ${b.op} 401`, (await pPost(b, ME)).statusCode === 401);
  }
  check("RI1 ... and none of those POSTs changed state", psql(`select count(*) from public.multi_entity_assignments;`) === "1" && (await userByEmail(email("x1"))) === null && (await userByEmail(email("x2"))) === null);

  const ownerSession = (token) => callHandler(handlers.ownerActions, { method: "GET", url: "/api/election-day/owner-actions?op=session", headers: auth(token) });
  check("RI2 control: Election Owner token works on owner-session", (await ownerSession(EO)).statusCode === 200);
  check("RI2 ME token -> Election owner-session 401", (await ownerSession(ME)).statusCode === 401);
  check("RI2 control: Election Owner token works on owner-roles", (await callHandler(handlers.ownerRoles, { method: "GET", url: "/api/election-day/owner-roles", headers: auth(EO) })).statusCode === 200);
  check("RI2 ME token -> Election owner-roles 401", (await callHandler(handlers.ownerRoles, { method: "GET", url: "/api/election-day/owner-roles", headers: auth(ME) })).statusCode === 401);
  const reauth = await callHandler(handlers.ownerReauth, { method: "POST", url: "/api/election-day/owner-reauth", headers: { ...auth(ME), origin: ORIGIN }, body: { password: mePw, action: "create_role" } });
  check("RI2 ME token + CORRECT password -> Election owner-reauth 401", reauth.statusCode === 401, String(reauth.statusCode));
  const pu = await callHandler(handlers.electionSession, { method: "GET", url: "/api/election-day/session", headers: auth(ME) });
  check("RI3 ME token -> PermissionUser session endpoint 401 (cookie-only)", pu.statusCode === 401);

  // D-8: dual principal (simulated reverse direction by direct SQL).
  psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WS.Alpha.id}', '${me1Id}', 'dual', '${email("me1")}');`);
  check("RI4 dual principal (seat + Election Owner) -> ME 401", (await meGet("session", ME)).statusCode === 401);
  check("RI4 dual principal -> ME workspace 401", (await meGet("workspace", ME, `&workspaceId=${WS.Beta.id}`)).statusCode === 401);
  check("RI4 RESIDUAL D-8 (documented, unchanged): the dual identity keeps its Election Owner authority", (await ownerSession(ME)).statusCode === 200);
  psql(`delete from public.election_owners where auth_user_id = '${me1Id}';`);
  check("RI4 exclusivity restored -> ME 200 again", (await meGet("session", ME)).statusCode === 200);
}

// ---------------------------------------------------------------------------
section("SEAT REPLACEMENT (stale seat) + PURGE + LINK FAILURE");
let me2Id;
{
  setFaults({ admin: { generateLink: () => ({ data: null, error: { message: "link down" } }) } });
  const rep = await pPost({ op: "provision_multi_entity_owner", name: "Me Two", email: email("me2") }, PO);
  clearFaults();
  me2Id = rep.body?.seatAuthUserId;
  check("RP1 link-generation failure -> 201, seat written, activationLink null", rep.statusCode === 201 && rep.body?.activationLink === null && rep.body?.replaced === true && rep.body?.previousAuthUserId === me1Id);
  check("RP2 the replaced holder's still-valid aal2 token -> 401 on the next call", (await meGet("session", ME)).statusCode === 401);
  check("RP2 ... including for a workspace that is still assigned", (await meGet("workspace", ME, `&workspaceId=${WS.Beta.id}`)).statusCode === 401);
  check("RP3 assignments carried over to the new seat", psql(`select count(*) from public.multi_entity_list_assigned_workspaces('${me2Id}');`) === "1");
  const pr = await pPost({ op: "purge_replaced_auth_user", previousAuthUserId: me1Id }, PO);
  check("RP4 purge the replaced account -> 200", pr.statusCode === 200 && pr.body?.previousAccountDeleted === true);
}

// ---------------------------------------------------------------------------
section("CASCADE via GoTrue (auth.admin.deleteUser runs as supabase_auth_admin)");
{
  check("CS0 seat row exists for the current holder", psql(`select count(*) from public.multi_entity_owner where auth_user_id = '${me2Id}';`) === "1");
  const del = await a.auth.admin.deleteUser(me2Id);
  check("CS1 GoTrue deletes the CURRENT seat holder's account", !del.error, del.error?.message ?? "");
  check("CS2 FK cascade removed the seat row despite the service_role revoke", psql(`select count(*) from public.multi_entity_owner;`) === "0");
  check("CS3 assignments survive for the next holder", psql(`select count(*) from public.multi_entity_assignments;`) === "1");
  const st = await pGet("/api/platform/session?op=multi_entity_state", PO);
  check("CS4 Platform state RPC reports no seat", st.statusCode === 200 && st.body?.seat === null);
}

process.exitCode = tally("API-REAL-LOCAL") === 0 ? 0 : 1;
