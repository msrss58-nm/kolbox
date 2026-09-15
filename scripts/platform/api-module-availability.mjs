// Budget Stage 7B Gate 4 - REAL-LOCAL API/DB suite: the Platform Owner's audited
// GLOBAL module availability switch (migration 20260922000000 + the
// `set_module_availability` op on api/platform/session.ts).
//
// Proves: the switch is Platform-Owner + aal2 only, strictly shaped, refuses a
// module whose availability is fixed, is idempotent and serialized, writes
// exactly one append-only audit row per real change, and NEVER adds or removes
// a workspace entitlement - effective Budget access = available AND entitlement.
// Real GoTrue + real Postgres (the isolated kolboxs5 scratch stack), the REAL
// bundled handlers, a real password + TOTP Platform Owner, real PermissionUser
// sessions and a real Election Owner. Synthetic data only; nothing secret is
// printed. Re-runnable: fixtures use a per-run prefix (a workspace that holds
// Budget rows is never deleted - the Stage 7A delete guard would refuse it) and
// every audit check is relative to this run's baseline (the audit is
// append-only).
//
// Run:  S5_STACK_DIR=<scratch stack> [S5_PORT_OFFSET=1000] node scripts/platform/api-module-availability.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
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
  tally,
} from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.PLATFORM_ALLOWED_ORIGIN = ORIGIN;
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const H = await buildHandlers();
const a = admin();

const DOMAIN = "g4-availability.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const PFX = `G4AV-${crypto.randomBytes(3).toString("hex")}`;
const COOKIE = "__Host-kb_ed_session";
const PW = "G4-Availability-Pw-7!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
const auth = (t) => (t ? { authorization: `Bearer ${t}` } : {});
const pPost = (body, token, headers = { origin: ORIGIN }) =>
  callHandler(H.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: { ...auth(token), ...headers },
    body,
  });
const setAvail = (moduleKey, available, token) =>
  pPost({ op: "set_module_availability", moduleKey, available }, token);
const pGet = (url, token) => callHandler(H.platformSession, { method: "GET", url, headers: auth(token) });
async function bw(cookie, op) {
  const r = await callHandler(H.budget, {
    method: "POST",
    url: "/api/budget/actions",
    headers: { origin: ORIGIN },
    body: { op },
    cookies: cookie ? { [COOKIE]: cookie } : {},
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data };
}
async function bo(token, op) {
  const r = await callHandler(H.budget, {
    method: "POST",
    url: "/api/budget/actions?principal=owner",
    headers: { origin: ORIGIN, ...auth(token) },
    body: { op },
  });
  return { status: r.statusCode, error: r.body?.error };
}
async function login(c, name) {
  psql("delete from public.election_day_login_attempts;");
  const r = await callHandler(H.electionSession, {
    method: "POST",
    url: "/api/election-day/session",
    headers: { origin: ORIGIN },
    body: { workspaceCode: c, name, password: PW },
  });
  const sc = r.headers?.["set-cookie"];
  return {
    status: r.statusCode,
    modules: r.body?.modules,
    cookie: typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "",
  };
}
const effective = (r) => r.status === 200 && Boolean(r.data?.session);
const inert = (r) => r.status === 200 && r.data?.unavailable === "MODULE_NOT_ENABLED";

// ---------------------------------------------------------------------------
// Read-only probes (psql as postgres, scratch only)
// ---------------------------------------------------------------------------
const avail = (k = "budget") => psql(`select available from public.platform_modules where key = '${k}';`);
const catalogStr = () =>
  psql(`select string_agg(key || ':' || available || ':' || availability_switchable, ',' order by sort_order) from public.platform_modules;`);
const moduleRows = () =>
  psql(`select coalesce(string_agg(workspace_id || ':' || module_key, ',' order by workspace_id, module_key), '') from public.election_workspace_modules;`);
const budgetModuleRows = () => psql(`select count(*) from public.election_workspace_modules where module_key = 'budget';`);
const auditCount = () => psql(`select count(*) from public.platform_module_availability_audit;`);
const entAuditCount = () => psql(`select count(*) from public.platform_entitlement_audit;`);
const lastAudit = () =>
  psql(`select module_key || '|' || previous_available || '|' || new_available || '|' || acting_platform_owner_auth_user_id || '|' || (performed_at > now() - interval '2 minutes')
        from public.platform_module_availability_audit order by performed_at desc, id desc limit 1;`);
/** Row count of every Budget table carrying workspace_id, for one workspace. */
function budgetTableCounts(ws) {
  const out = psql(`select c.relname || '=' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where workspace_id = %L', c.relname, '${ws}'), false, true, '')))[1]::text
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'budget\\_%'
          and exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'workspace_id')
        order by 1;`);
  return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => l.split("=")).map(([k, v]) => [k, Number(v)]));
}
/** Runs SQL expected to FAIL; returns the error text ("" if it succeeded). */
function psqlError(sql) {
  try {
    psql(sql);
    return "";
  } catch (e) {
    return String(e.stderr ?? e.message ?? e);
  }
}

async function listUsers() {
  const out = [];
  for (let p = 1; p < 20; p++) {
    const { data, error } = await a.auth.admin.listUsers({ page: p, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_day_login_attempts;
  update public.platform_modules set available = false where key = 'budget';
`);
for (const u of await listUsers()) if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
const T0 = psql("select now();");
const AUD0 = Number(auditCount());

const poPw = randomPassword();
const { data: po } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${po.user.id}', 'G4 PO', '${email("po")}');`);
const PO = (await enrollTotp((await signIn(email("po"), poPw)).client, "g4-po")).token;
const PO_AAL1 = (await signIn(email("po"), poPw)).token;
const strangerPw = randomPassword();
await a.auth.admin.createUser({ email: email("stranger"), password: strangerPw, email_confirm: true });
const strangerSignIn = await signIn(email("stranger"), strangerPw);
const STRANGER = (await enrollTotp(strangerSignIn.client, "g4-stranger")).token;

const CODES = { T: code(), C: code() };
const mkWs = (label, c) =>
  psql(`insert into public.election_workspaces (name, election_end_at, login_code)
        values ('${PFX} ${label}', now() + interval '30 days', '${c}') returning id;`);
const WT = mkWs("target (election day + budget)", CODES.T);
const WC = mkWs("control (election day only)", CODES.C);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values
  ('${WT}', 'election_day'), ('${WT}', 'budget'), ('${WC}', 'election_day');`);
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings", "voter.viewName"];
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
for (const [w, label] of [[WT, "t"], [WC, "c"]]) {
  const r = psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
                  values ('${label} full', '', ${arr(ALL)}, 'all', '${w}', true) returning id;`);
  psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
        values ('u-${label}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}');`);
}
const { data: ot } = await a.auth.admin.createUser({ email: email("owner-t"), password: PW, email_confirm: true });
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WT}', '${ot.user.id}', 'G4 Owner T', '${email("owner-t")}');`);
const OWNER_T = (await signIn(email("owner-t"), PW)).token;
check("S1 Platform Owner (aal2 + aal1), a stranger (aal2, not a Platform Owner) and the target's Election Owner ready",
  Boolean(PO && PO_AAL1 && STRANGER && OWNER_T));
check("S2 start state: budget available=false; target has election_day+budget, control has election_day only",
  avail() === "f" &&
    psql(`select string_agg(module_key, ',' order by module_key) from public.election_workspace_modules where workspace_id = '${WT}'`) === "budget,election_day" &&
    psql(`select string_agg(module_key, ',' order by module_key) from public.election_workspace_modules where workspace_id = '${WC}'`) === "election_day");

// ---------------------------------------------------------------------------
section("A. DATABASE CATALOG / ACL / IMMUTABILITY");
check("A1 availability_switchable: budget only (voter_management / election_day fixed)",
  catalogStr() === "voter_management:false:false,election_day:true:false,budget:false:true", catalogStr());
check("A2 platform_set_module_availability: SECURITY DEFINER, search_path='', service_role only (no PUBLIC / anon / authenticated)",
  psql(`select p.prosecdef and p.proconfig = array['search_path=""']
          and has_function_privilege('service_role', p.oid, 'EXECUTE')
          and not has_function_privilege('anon', p.oid, 'EXECUTE')
          and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
          and not exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0)
        from pg_proc p where p.oid = 'public.platform_set_module_availability(uuid,text,boolean)'::regprocedure;`) === "t");
check("A3 platform_list_workspace_modules still service_role only",
  psql(`select has_function_privilege('service_role', 'public.platform_list_workspace_modules(uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.platform_list_workspace_modules(uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.platform_list_workspace_modules(uuid)', 'EXECUTE');`) === "t");
check("A4 availability audit: RLS on, 0 policies, no privilege for anon / authenticated / service_role",
  psql(`select c.relrowsecurity
          and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'platform_module_availability_audit') = 0
          and not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
          and not has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
          and not has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        from pg_class c where c.oid = 'public.platform_module_availability_audit'::regclass;`) === "t");
const seed = `insert into public.platform_module_availability_audit (module_key, previous_available, new_available, acting_platform_owner_auth_user_id) values ('budget', false, true, '${po.user.id}');`;
check("A5 audit is append-only: UPDATE, DELETE and TRUNCATE refused (AUDIT_IMMUTABLE), even as postgres",
  /AUDIT_IMMUTABLE/.test(psqlError(`begin; ${seed} update public.platform_module_availability_audit set new_available = false; rollback;`)) &&
    /AUDIT_IMMUTABLE/.test(psqlError(`begin; ${seed} delete from public.platform_module_availability_audit; rollback;`)) &&
    /AUDIT_IMMUTABLE/.test(psqlError(`begin; ${seed} truncate public.platform_module_availability_audit; rollback;`)));
check("A6 audit refuses a no-change row (previous = new)",
  /check constraint/.test(psqlError(`begin; insert into public.platform_module_availability_audit (module_key, previous_available, new_available, acting_platform_owner_auth_user_id) values ('budget', true, true, '${po.user.id}'); rollback;`)));
{
  const i1 = await a.from("platform_module_availability_audit").insert({ module_key: "budget", previous_available: false, new_available: true, acting_platform_owner_auth_user_id: po.user.id });
  const u1 = await a.from("platform_modules").update({ available: true }).eq("key", "budget");
  const anonRpc = await anon().rpc("platform_set_module_availability", { p_platform_owner_auth_user_id: po.user.id, p_module_key: "budget", p_available: true });
  const authRpc = await strangerSignIn.client.rpc("platform_set_module_availability", { p_platform_owner_auth_user_id: po.user.id, p_module_key: "budget", p_available: true });
  check("A7 no direct path: service_role cannot write the audit or the catalog; anon / authenticated cannot call the function",
    Boolean(i1.error) && Boolean(u1.error) && Boolean(anonRpc.error) && Boolean(authRpc.error) && avail() === "f" && Number(auditCount()) === AUD0,
    `${i1.error?.code} ${u1.error?.code} ${anonRpc.error?.code} ${authRpc.error?.code}`);
}
{
  const r = psqlError(`select public.platform_set_module_availability('${crypto.randomUUID()}', 'budget', true);`);
  check("A8 the function re-resolves the Platform Owner itself: an unknown actor id -> UNAUTHORIZED", /UNAUTHORIZED/.test(r) && avail() === "f");
}

// ---------------------------------------------------------------------------
section("B. AUTH / REQUEST SHAPE (every refusal changes nothing)");
const beforeB = { cat: catalogStr(), rows: moduleRows(), audit: auditCount(), ent: entAuditCount() };
{
  const forged = [b64({ alg: "HS256", typ: "JWT" }), b64({ sub: po.user.id, aal: "aal2", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }), b64("not-a-signature")].join(".");
  const r = {
    none: await setAvail("budget", true, null),
    forged: await setAvail("budget", true, forged),
    aal1: await setAvail("budget", true, PO_AAL1),
    stranger: await setAvail("budget", true, STRANGER),
    owner: await setAvail("budget", true, OWNER_T),
  };
  check("B1 no token / forged token / Platform Owner at aal1 / aal2 stranger / Election Owner -> 401",
    Object.values(r).every((x) => x.statusCode === 401), Object.entries(r).map(([k, x]) => `${k}=${x.statusCode}`).join(" "));
  const noOrigin = await pPost({ op: "set_module_availability", moduleKey: "budget", available: true }, PO, {});
  const badOrigin = await pPost({ op: "set_module_availability", moduleKey: "budget", available: true }, PO, { origin: "https://evil.example" });
  check("B2 no Origin / foreign Origin -> 403 FORBIDDEN_ORIGIN", noOrigin.statusCode === 403 && badOrigin.statusCode === 403);
  const shapes = [
    { op: "set_module_availability", moduleKey: "budget", available: true, platformOwnerAuthUserId: po.user.id },
    { op: "set_module_availability", moduleKey: "budget", available: true, actorId: po.user.id },
    { op: "set_module_availability", moduleKey: "budget" },
    { op: "set_module_availability", moduleKey: "budget", available: "true" },
    { op: "set_module_availability", moduleKey: "budget", available: 1 },
    { op: "set_module_availability", moduleKey: "budget", available: null },
    { op: "set_module_availability", available: true },
    { op: "set_module_availability", moduleKey: "Budget!", available: true },
    { op: "set_module_availability", moduleKey: ["budget"], available: true },
    { op: "set_module_availability", moduleKey: "budget'; update public.platform_modules set available = true; --", available: true },
  ];
  const codes = [];
  for (const b of shapes) codes.push((await pPost(b, PO)).statusCode);
  check("B3 client-supplied actor, missing / non-boolean state, bad / injected / non-string module key -> 400",
    codes.every((c) => c === 400), codes.join(","));
  const unknown = await setAvail("no_such_module", true, PO);
  check("B4 unknown module -> 404 MODULE_NOT_FOUND", unknown.statusCode === 404 && unknown.body?.error === "MODULE_NOT_FOUND");
  const fixed = [await setAvail("election_day", false, PO), await setAvail("voter_management", true, PO), await setAvail("election_day", true, PO)];
  check("B5 fixed modules (election_day, voter_management) -> 409 MODULE_AVAILABILITY_FIXED, even for an identical state",
    fixed.every((x) => x.statusCode === 409 && x.body?.error === "MODULE_AVAILABILITY_FIXED"), fixed.map((x) => x.statusCode).join(","));
}
check("B6 after every refusal: catalog, entitlements, availability audit and entitlement audit unchanged",
  catalogStr() === beforeB.cat && moduleRows() === beforeB.rows && auditCount() === beforeB.audit && entAuditCount() === beforeB.ent);

// ---------------------------------------------------------------------------
section("C. ENTITLED BUT UNAVAILABLE = INERT");
const LT0 = await login(CODES.T, "u-t");
const LC0 = await login(CODES.C, "u-c");
check("C1 target worker login modules = [election_day] while Budget is unavailable",
  LT0.status === 200 && JSON.stringify(LT0.modules) === '["election_day"]', `${LT0.status} ${JSON.stringify(LT0.modules)}`);
check("C2 target: probe unavailable, Budget op 403, Owner Budget op 403",
  inert(await bw(LT0.cookie, "probe")) && (await bw(LT0.cookie, "get_dashboard")).status === 403 && (await bo(OWNER_T, "get_dashboard")).status === 403);
check("C3 refused Budget calls wrote nothing (target and control hold 0 Budget rows)",
  Object.values(budgetTableCounts(WT)).every((n) => n === 0) && Object.values(budgetTableCounts(WC)).every((n) => n === 0) && LC0.status === 200);

// ---------------------------------------------------------------------------
section("D. false -> true (through the official op)");
const rowsBefore = moduleRows();
const entBefore = entAuditCount();
const budgetEntitled = budgetModuleRows();
const auditBefore = Number(auditCount());
{
  const r = await setAvail("budget", true, PO);
  check("D1 200 {changed:true, previousAvailable:false, available:true, entitledWorkspaces = the budget entitlement count}",
    r.statusCode === 200 && r.body?.changed === true && r.body?.previousAvailable === false && r.body?.available === true &&
      r.body?.moduleKey === "budget" && String(r.body?.entitledWorkspaces) === budgetEntitled, JSON.stringify(r.body));
  check("D2 catalog: budget available=true; nothing else in the catalog changed",
    catalogStr() === "voter_management:false:false,election_day:true:false,budget:true:true");
  check("D3 exactly ONE audit row: budget, false -> true, actor = the Platform Owner, now",
    Number(auditCount()) === auditBefore + 1 && lastAudit() === `budget|false|true|${po.user.id}|true`, lastAudit());
  check("D4 no entitlement added or removed; the entitlement audit untouched",
    moduleRows() === rowsBefore && budgetModuleRows() === budgetEntitled && entAuditCount() === entBefore);
  check("D4b the switch itself created no Budget row anywhere in the target", Object.values(budgetTableCounts(WT)).every((n) => n === 0));
}
const LT = await login(CODES.T, "u-t");
const LC = await login(CODES.C, "u-c");
check("D5 target is now EFFECTIVE: login modules [election_day, budget], probe = session, Budget op 200, Owner 200",
  JSON.stringify(LT.modules) === '["election_day","budget"]' && effective(await bw(LT.cookie, "probe")) &&
    (await bw(LT.cookie, "get_dashboard")).status === 200 && (await bo(OWNER_T, "get_dashboard")).status === 200,
  JSON.stringify(LT.modules));
check("D6 the earlier target session (logged in while unavailable) is effective on its next request",
  effective(await bw(LT0.cookie, "probe")));
check("D7 control (NOT entitled) stays inert: login modules [election_day], probe unavailable, Budget op 403",
  JSON.stringify(LC.modules) === '["election_day"]' && inert(await bw(LC.cookie, "probe")) && (await bw(LC.cookie, "get_dashboard")).status === 403);
{
  // The first real Budget op in an entitled workspace runs budget_ensure_initialized
  // (Stage 3/4 design): 1 settings row + the 11 system document types + the 7
  // default party rules, each insert audited. Those are configuration defaults,
  // not business data - every business table must stay empty.
  const DEFAULTS = new Set(["budget_settings", "budget_document_types", "budget_document_rules", "budget_audit_events"]);
  const t = budgetTableCounts(WT);
  const c = budgetTableCounts(WC);
  const business = Object.entries(t).filter(([k]) => !DEFAULTS.has(k)).reduce((s, [, n]) => s + n, 0);
  const auditNonInsert = psql(`select count(*) from public.budget_audit_events e where e.workspace_id = '${WT}' and e.action is distinct from 'insert'`);
  const systemTypes = psql(`select count(*) from public.budget_document_types where workspace_id = '${WT}' and is_system`);
  check("D8 opening Budget created NO business row: only the designed lazy defaults (1 settings, 11 system document types, 7 rules) + their 19 insert audit rows; the control has 0 Budget rows",
    business === 0 && t.budget_settings === 1 && t.budget_document_types === 11 && systemTypes === "11" && t.budget_document_rules === 7 &&
      t.budget_audit_events === 19 && auditNonInsert === "0" && Object.values(c).every((n) => n === 0),
    `business=${business} settings=${t.budget_settings} types=${t.budget_document_types} rules=${t.budget_document_rules} audit=${t.budget_audit_events} control=${Object.values(c).reduce((s, n) => s + n, 0)}`);
}

// ---------------------------------------------------------------------------
section("E. IDEMPOTENT true -> true");
{
  const n = auditCount();
  const r = await setAvail("budget", true, PO);
  check("E1 identical retry -> 200 changed:false, no audit row, still available",
    r.statusCode === 200 && r.body?.changed === false && r.body?.available === true && auditCount() === n && avail() === "t");
}

// ---------------------------------------------------------------------------
section("F. true -> false (two identical requests in parallel)");
{
  const n = Number(auditCount());
  const [r1, r2] = await Promise.all([setAvail("budget", false, PO), setAvail("budget", false, PO)]);
  const changed = [r1, r2].filter((x) => x.body?.changed === true).length;
  check("F1 both 200; exactly one changed (row lock serializes); exactly ONE audit row true -> false",
    r1.statusCode === 200 && r2.statusCode === 200 && changed === 1 && Number(auditCount()) === n + 1 &&
      lastAudit() === `budget|true|false|${po.user.id}|true`, `${r1.statusCode}/${r1.body?.changed} ${r2.statusCode}/${r2.body?.changed}`);
  check("F2 unavailable does NOT remove the entitlement (module rows identical)", moduleRows() === rowsBefore && avail() === "f");
  check("F3 kill switch is immediate: the live target session and the Owner are refused (probe unavailable, 403)",
    inert(await bw(LT.cookie, "probe")) && (await bw(LT.cookie, "get_dashboard")).status === 403 && (await bo(OWNER_T, "get_dashboard")).status === 403);
}

// ---------------------------------------------------------------------------
section("G. IDEMPOTENT false -> false");
{
  const n = auditCount();
  const r = await setAvail("budget", false, PO);
  check("G1 identical retry -> 200 changed:false, no audit row", r.statusCode === 200 && r.body?.changed === false && auditCount() === n);
}

// ---------------------------------------------------------------------------
section("H. RE-ENABLE restores exactly the entitled workspaces");
{
  const r = await setAvail("budget", true, PO);
  check("H1 false -> true again: 200 changed, one more audit row", r.statusCode === 200 && r.body?.changed === true && lastAudit() === `budget|false|true|${po.user.id}|true`);
  check("H2 the SAME target session is effective again (no re-login, no re-grant)", effective(await bw(LT.cookie, "probe")) && (await bw(LT.cookie, "get_dashboard")).status === 200);
  check("H3 control still inert; entitlement rows identical; budget entitlement count unchanged",
    inert(await bw(LC.cookie, "probe")) && moduleRows() === rowsBefore && budgetModuleRows() === budgetEntitled);
  const WZ = mkWs("created while available", code());
  psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WZ}', 'election_day');`);
  check("H4 a workspace created while Budget is available gets NO Budget entitlement",
    psql(`select string_agg(module_key, ',') from public.election_workspace_modules where workspace_id = '${WZ}'`) === "election_day" &&
      psql(`select public.budget_workspace_entitled('${WZ}')`) === "f" && psql(`select public.budget_workspace_entitled('${WT}')`) === "t" &&
      psql(`select public.budget_workspace_entitled('${WC}')`) === "f");
}

// ---------------------------------------------------------------------------
section("I. PLATFORM READ reflects the switch");
{
  const g = await pGet("/api/platform/session?op=workspace_modules", PO);
  const b = g.body?.catalog?.find((m) => m.key === "budget");
  const e = g.body?.catalog?.find((m) => m.key === "election_day");
  check("I1 catalog entries carry availability_switchable + entitled_workspaces (budget switchable + available, election_day fixed)",
    g.statusCode === 200 && b?.available === true && b?.availability_switchable === true && String(b?.entitled_workspaces) === budgetModuleRows() &&
      e?.availability_switchable === false && e?.available === true, JSON.stringify(g.body?.catalog));
  check("I2 aal1 / stranger cannot read it (401)",
    (await pGet("/api/platform/session?op=workspace_modules", PO_AAL1)).statusCode === 401 &&
      (await pGet("/api/platform/session?op=workspace_modules", STRANGER)).statusCode === 401);
}

// ---------------------------------------------------------------------------
section("J. EXISTING ENTITLEMENT EDIT still works and is independent");
{
  const off = await pPost({ op: "set_workspace_modules", workspaceId: WT, modules: ["election_day"] }, PO);
  check("J1 removing the target's Budget entitlement (Stage 9 op) -> 200; target inert while Budget stays globally available",
    off.statusCode === 200 && avail() === "t" && psql(`select public.budget_workspace_entitled('${WT}')`) === "f");
  const on = await pPost({ op: "set_workspace_modules", workspaceId: WT, modules: ["election_day", "budget"] }, PO);
  check("J2 granting it back -> 200; effective again; both entitlement edits audited in the entitlement audit, not the availability audit",
    on.statusCode === 200 && psql(`select public.budget_workspace_entitled('${WT}')`) === "t" &&
      Number(entAuditCount()) === Number(entBefore) + 2 && lastAudit() === `budget|false|true|${po.user.id}|true`);
}

// ---------------------------------------------------------------------------
section("Z. RESTORE (scratch): budget unavailable, through the official op");
{
  const r = await setAvail("budget", false, PO);
  check("Z1 budget.available restored to false (audited)", r.statusCode === 200 && avail() === "f");
  check("Z2 availability audit for this run: exactly 4 rows (on, off, on, off) in order, all by this Platform Owner",
    psql(`select string_agg(previous_available || '>' || new_available, ',' order by performed_at, id) from public.platform_module_availability_audit where performed_at >= '${T0}'`) ===
      "false>true,true>false,false>true,true>false" &&
      psql(`select count(*) from public.platform_module_availability_audit where performed_at >= '${T0}' and acting_platform_owner_auth_user_id <> '${po.user.id}'`) === "0" &&
      Number(auditCount()) === AUD0 + 4);
}

tally("MODULE AVAILABILITY");
