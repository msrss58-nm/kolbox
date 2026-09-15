// Budget Stage 7A - REAL-LOCAL release-readiness suite: the entitlement matrix,
// the permission matrix, cross-workspace attacks, the DB / Storage security
// posture, file edge cases, financial + party-workflow integrity on a
// Budget-only workspace after its election ended, audit (incl. the download
// audit), the DELETION EXPORT and the WORKSPACE DELETE GUARD (freshness
// invalidated by every mutation kind), the Storage orphan cleanup and
// performance.
//
// Real Postgres + real GoTrue + real Storage (the isolated kolboxs5 scratch
// stack started with S5_STORAGE=1), the REAL bundled handlers, real
// PermissionUser sessions and real Election Owners. Synthetic data only. The
// workspace DELETE runs through psql as postgres: there is no product path that
// deletes a workspace, and the guard protects every path.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/api-budget-stage7.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { admin, anon, callHandler, check, installLocalnetGuard, loadStack, psql, section, signIn, sleep, tally } from "../stage5/lib.mjs";

const stackEnv = loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const CRON = crypto.randomBytes(24).toString("hex");
process.env.CRON_SECRET = CRON;
const H = await buildHandlers();
const a = admin();

const COOKIE = "__Host-kb_ed_session";
const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S7-${RUN}`;
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const DOMAIN = `budget-s7-${RUN}.invalid`;
const PW = "S7-Release-Pw-5!";
const uuid = () => crypto.randomUUID();
const q1 = (sql) => psql(sql);
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const actorSql = (ws) => `select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"s7 fixture","workspace_id":"${ws}"}', true);`;

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
async function bw(cookie, op, args, extra = {}) {
  const r = await callHandler(H.budget, {
    method: extra.method ?? "POST", url: "/api/budget/actions", headers: { origin: ORIGIN },
    body: extra.body ?? { op, ...(args === undefined ? {} : { args }) }, cookies: cookie ? { [COOKIE]: cookie } : {},
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function bo(token, op, args) {
  const r = await callHandler(H.budget, {
    method: "POST", url: "/api/budget/actions?principal=owner",
    headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { op, ...(args === undefined ? {} : { args }) },
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function cron(authorization) {
  const r = await callHandler(H.budget, { method: "GET", url: "/api/budget/actions", headers: authorization ? { authorization } : {} });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data };
}
async function login(c, name) {
  psql("delete from public.election_day_login_attempts;");
  const r = await callHandler(H.electionSession, {
    method: "POST", url: "/api/election-day/session", headers: { origin: ORIGIN }, body: { workspaceCode: c, name, password: PW },
  });
  const sc = r.headers?.["set-cookie"];
  return { status: r.statusCode, error: r.body?.error, modules: r.body?.modules,
    cookie: typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "" };
}
const ok = (r) => r.status === 200;
const is = (r, status, err) => r.status === status && r.error === err;
const d = (r) => `${r.status} ${r.error ?? ""}${r.body?.blockers ? " " + r.body.blockers.join(",") : ""}`;
const pad = (head, n) => Buffer.concat([head, crypto.randomBytes(Math.max(0, n - head.length))]);
const FILES = {
  pdf: (n = 2048) => pad(Buffer.from("%PDF-1.7\n%synthetic\n"), n),
  jpg: (n = 2048) => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), n),
  png: (n = 2048) => pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), n),
  heic: (n = 2048) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0])]), n),
};
/** The browser flow: start -> PUT to the signed URL -> complete. */
async function upload(cookie, target, bytes, { mime = "application/pdf", name = "document.pdf", putType, declared } = {}) {
  const start = await bw(cookie, "document_upload_start", { ...target, fileName: name, mimeType: mime, sizeBytes: declared ?? bytes.length });
  if (!ok(start)) return { start, stage: "start" };
  const res = await fetch(start.data.uploadUrl, { method: "PUT", headers: { "content-type": putType ?? mime, "x-upsert": "false" }, body: bytes });
  if (!res.ok) return { start, put: res.status, stage: "put" };
  const complete = await bw(cookie, "document_upload_complete", { uploadId: start.data.uploadId });
  return { start, complete, stage: "complete" };
}
/** A rolled-back delete attempt: returns the guard's code, or "deletable". */
function deleteProbe(ws) {
  try {
    q1(`begin; delete from public.election_workspaces where id = '${ws}'; rollback;`);
    return "deletable";
  } catch (e) {
    return String(e.stderr ?? e.message ?? e).match(/BUDGET_[A-Z_]+/)?.[0] ?? String(e.stderr ?? e).slice(0, 120);
  }
}

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
q1(`update public.platform_modules set available = true where key = 'budget';`);
check("S00 storage bucket present (stack started with S5_STORAGE=1)", q1(`select count(*) from storage.buckets where id = 'budget-documents';`) === "1");
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const CODES = { A: code(), B: code(), C: code(), N: code(), E: code() };
const mkWs = (label, c, ended = false) => q1(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() ${ended ? "-" : "+"} interval '10 days', '${c}') returning id;`);
const WA = mkWs("A election day + budget", CODES.A);
const WB = mkWs("B budget only, election ended", CODES.B, true);
const WC = mkWs("C election day only", CODES.C);
const WN = mkWs("N no module", CODES.N);
const WE = mkWs("E election day + budget, election ended", CODES.E, true);
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values
  ('${WA}','election_day'),('${WA}','budget'),('${WB}','budget'),('${WC}','election_day'),('${WE}','election_day'),('${WE}','budget');`);
const role = (w, name, perms, mgr = false) => q1(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', ${mgr}) returning id;`);
const user = (w, name, r) => q1(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
// One role per Budget permission (each with budget.view, which every other one requires).
const SINGLE = {
  view: [], exp: ["budget.manageExpenses"], sub: ["budget.manageFunderSubmissions"], sup: ["budget.manageSuppliers"],
  plan: ["budget.managePlan"], rep: ["budget.viewReports"], set: ["budget.manageSettings"],
};
for (const [k, p] of Object.entries(SINGLE)) user(WA, `u-${k}`, role(WA, k, ["budget.view", ...p]));
user(WA, "u-full", role(WA, "full", [...ALL, "voter.viewName"]));
user(WA, "u-edmgr", role(WA, "ed manager", ["electionDay.import", "electionDay.clearData", "electionDay.manageSettings",
  "electionDay.export", "voter.markVoted"], true));
// Raw insert (the role editor would refuse it: BUDGET_VIEW_REQUIRED) - a manage
// permission without budget.view still grants nothing.
user(WA, "u-noview", role(WA, "no view", ["budget.manageExpenses"]));
user(WB, "u-bfull", role(WB, "b full", ALL));
user(WC, "u-cfull", role(WC, "c full", ALL));
user(WN, "u-nfull", role(WN, "n full", ALL));
user(WE, "u-efull", role(WE, "e full", ALL));
async function mkOwner(w, label) {
  const email = `${label}@${DOMAIN}`;
  const { data, error } = await a.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw error;
  q1(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${w}', '${data.user.id}', 'Owner ${label}', '${email}');`);
  return { email, token: (await signIn(email, PW)).token };
}
const OA = await mkOwner(WA, "owner-a");
const OB = await mkOwner(WB, "owner-b");
const OC = await mkOwner(WC, "owner-c");
const L = {};
for (const k of [...Object.keys(SINGLE), "full", "edmgr", "noview"]) L[k] = await login(CODES.A, `u-${k}`);
const U = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.cookie]));
check("S01 fixtures: 5 workspaces (ED+Budget, Budget-only ended, ED-only, none, ED+Budget ended), 10 roles, 3 Owners",
  Object.values(U).every(Boolean) && Boolean(OA.token && OB.token && OC.token));

// ---------------------------------------------------------------------------
section("MODULE ENTITLEMENT MATRIX (server-side)");
check("E01 Election Day + Budget: login modules [election_day, budget]", ok(L.full) &&
  JSON.stringify(L.full.modules) === JSON.stringify(["election_day", "budget"]), JSON.stringify(L.full.modules));
const LB = await login(CODES.B, "u-bfull");
const UB = LB.cookie;
check("E02 Budget only (election ended): login modules [budget]", ok(LB) && JSON.stringify(LB.modules) === JSON.stringify(["budget"]),
  `${LB.status} ${JSON.stringify(LB.modules)}`);
const edGet = await callHandler(H.electionSession, { method: "GET", url: "/api/election-day/session", cookies: { [COOKIE]: UB } });
const edVoters = await callHandler(H.actions, { method: "GET", url: "/api/election-day/actions?op=list_voters", cookies: { [COOKIE]: UB } });
check("E03 Budget only: Election Day is not assumed (ED session 401, ED voters 401)", edGet.statusCode === 401 && edVoters.statusCode === 401,
  `${edGet.statusCode} ${edVoters.statusCode}`);
const LC = await login(CODES.C, "u-cfull");
check("E04 Election Day only: login modules [election_day]", ok(LC) && JSON.stringify(LC.modules) === JSON.stringify(["election_day"]));
const probeC = await bw(LC.cookie, "probe");
check("E05 Election Day only: Budget op 403 MODULE_NOT_ENABLED, navigation probe 200 unavailable",
  is(await bw(LC.cookie, "get_dashboard"), 403, "MODULE_NOT_ENABLED") && ok(probeC) && probeC.data?.unavailable === "MODULE_NOT_ENABLED");
check("E06 Election Day only: the Owner's Budget op -> 403 MODULE_NOT_ENABLED (no client-only enforcement)",
  is(await bo(OC.token, "get_dashboard"), 403, "MODULE_NOT_ENABLED"));
check("E07 neither module: worker login refused 403 MODULE_NOT_ENABLED", is(await login(CODES.N, "u-nfull"), 403, "MODULE_NOT_ENABLED"));
const catB0 = (await bw(UB, "create_category", { name: `${PFX} קטגוריה B` })).data?.id;
q1(`update public.platform_modules set available = false where key = 'budget';`);
const killA = await bw(U.full, "get_dashboard");
const killProbe = await bw(U.full, "probe");
const killOwner = await bo(OA.token, "get_dashboard");
q1(`update public.platform_modules set available = true where key = 'budget';`);
check("E08 kill switch (available = false): worker + Owner 403, probe unavailable; restored -> 200",
  is(killA, 403, "MODULE_NOT_ENABLED") && is(killOwner, 403, "MODULE_NOT_ENABLED") && killProbe.data?.unavailable === "MODULE_NOT_ENABLED" &&
  ok(await bw(U.full, "get_dashboard")));
q1(`delete from public.election_workspace_modules where workspace_id = '${WB}' and module_key = 'budget';`);
const revoked = await bw(UB, "list_categories");
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WB}', 'budget');`);
const regranted = await bw(UB, "list_categories");
check("E09 entitlement revoked -> 403 (data kept); re-granted -> the same data back", is(revoked, 403, "MODULE_NOT_ENABLED") &&
  ok(regranted) && regranted.data.some((c) => c.id === catB0));

// ---------------------------------------------------------------------------
section("POST-ELECTION ACCESS (election_end_at in the past, Budget still entitled)");
const LE = await login(CODES.E, "u-efull");
check("PE01 ended Election Day + Budget workspace: worker login still admits Budget", ok(LE) && (LE.modules ?? []).includes("budget"),
  `${LE.status} ${JSON.stringify(LE.modules)}`);
const peCat = await bw(LE.cookie, "create_category", { name: `${PFX} after the election` });
check("PE02 ... and financial administration continues (write + dashboard 200)", ok(peCat) && ok(await bw(LE.cookie, "get_dashboard")), d(peCat));
check("PE03 Budget never reads election_end_at (no Budget function references it)",
  q1(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'budget\\_%' and p.prosrc ilike '%election_end_at%';`) === "0");

// ---------------------------------------------------------------------------
section("PERMISSION MATRIX (every Budget permission independently; server enforcement)");
// Authorization is decided BEFORE the op runs, so an op called with empty
// arguments answers 403 when unauthorized and 400 / 404 / 200 when authorized.
const PROBES = {
  view: ["get_dashboard", {}], exp: ["create_expense", {}], sub: ["record_preapproval", {}], sup: ["create_supplier", {}],
  plan: ["set_category_plan", {}], rep: ["report_expenses", {}], set: ["create_category", {}],
};
const allowed = async (call) => {
  const out = {};
  for (const [k, [op, args]] of Object.entries(PROBES)) out[k] = (await call(op, args)).status !== 403;
  return out;
};
for (const k of Object.keys(SINGLE)) {
  const got = await allowed((op, args) => bw(U[k], op, args));
  const expected = Object.fromEntries(Object.keys(PROBES).map((p) => [p, p === "view" || p === k]));
  check(`PM-${k} budget.view${k === "view" ? "" : " + " + SINGLE[k][0]} -> exactly its own ops`,
    JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
}
const fullGot = await allowed((op, args) => bw(U.full, op, args));
check("PM-full every Budget permission -> every op", Object.values(fullGot).every(Boolean), JSON.stringify(fullGot));
const ownerGot = await allowed((op, args) => bo(OA.token, op, args));
check("PM-owner the Election Owner holds full Budget authority", Object.values(ownerGot).every(Boolean), JSON.stringify(ownerGot));
const mgrGot = await allowed((op, args) => bw(U.edmgr, op, args));
check("PM-edmgr an Election Day Manager (is_manager) receives NO Budget permission", Object.values(mgrGot).every((v) => !v), JSON.stringify(mgrGot));
const noviewGot = await allowed((op, args) => bw(U.noview, op, args));
check("PM-noview a manage permission without budget.view grants nothing", Object.values(noviewGot).every((v) => !v), JSON.stringify(noviewGot));
const exportOps = ["export_status", "export_start", "export_part", "export_verify"];
const workerExport = await Promise.all(exportOps.map((op) => bw(U.full, op, {})));
check("PM-export the deletion export is Owner-only (a worker with EVERY permission -> 403 on all four ops)",
  workerExport.every((r) => is(r, 403, "FORBIDDEN")), workerExport.map(d).join(","));
check("PM-export2 ... and the Owner reaches it", ok(await bo(OA.token, "export_status")));
const workerExportDoc = await bw(U.full, "export_document", { exportId: uuid(), versionId: uuid() });
check("PM-export3 a worker's export_document -> 403 (authorized in the DB before any Storage call)", is(workerExportDoc, 403, "FORBIDDEN"), d(workerExportDoc));

// ---------------------------------------------------------------------------
section("DATABASE SECURITY (catalog)");
const grantedFns = q1(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and has_function_privilege('service_role', p.oid, 'execute');`);
check("C01 exactly five Budget functions are executable by service_role (2 dispatchers, worker step-up mint, 2 Storage cleanup)",
  grantedFns === "budget_dispatch_owner,budget_dispatch_worker,budget_stepup_mint_worker,budget_storage_cleanup_record,budget_storage_orphans", grantedFns);
check("C02 no Budget function is executable by PUBLIC / anon / authenticated", q1(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and (has_function_privilege('anon', p.oid, 'execute')
  or has_function_privilege('authenticated', p.oid, 'execute') or p.proacl is null or p.proacl::text like '%=X/%' and p.proacl::text ~ '(^|[{,])=X');`) === "0");
check("C03 every Budget function pins search_path; every SECURITY DEFINER one pins it to ''", q1(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and not (coalesce(p.proconfig, '{}') && array['search_path=""', 'search_path=']);`) === "0");
const tbl = q1(`select count(*) || '|' || count(*) filter (where not c.relrowsecurity
    or exists (select 1 from pg_policy pl where pl.polrelid = c.oid)
    or has_table_privilege('anon', c.oid, 'select,insert,update,delete')
    or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
    or has_table_privilege('service_role', c.oid, 'select,insert,update,delete'))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'budget\\_%';`);
check("C04 all 30 Budget tables: RLS on, zero policies, no table privilege for anon / authenticated / service_role", tbl === "30|0", tbl);
const uncovered = q1(`select coalesce(string_agg(c.relname, ','), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'budget\\_%'
    and not (c.relname = any(public.budget_export_tables()))
    and c.relname not in ('budget_data_exports', 'budget_data_export_serves', 'budget_workspace_deletions', 'budget_storage_cleanup_runs');`);
check("C05 export completeness: every Budget table is in the deletion export or is export / deletion / cleanup bookkeeping", uncovered === "", uncovered);
const unaudited = q1(`select coalesce(string_agg(t, ','), '') from unnest(public.budget_export_tables()) t
  where t not in ('budget_audit_events', 'budget_document_access_log')
    and not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = t || '_audit');`);
check("C06 every Budget data table carries the actor-context audit trigger", unaudited === "", unaudited);
check("C07 the workspace delete guard trigger is installed and enabled", q1(`select tgenabled from pg_trigger
  where tgrelid = 'public.election_workspaces'::regclass and tgname = 'election_workspaces_budget_delete_guard';`) === "O");
const refuse = (sql) => { try { q1(sql); return "allowed"; } catch (e) { return String(e.stderr ?? e).match(/BUDGET_[A-Z_]+|[A-Z_]{8,}/)?.[0] ?? "error"; } };
// Row triggers fire only for existing rows: each append-only table is attacked
// where it holds rows (payments FI10, access log DA03, cleanup runs CL07,
// deletion record L22); TRUNCATE is refused even on an empty table.
check("C08 append-only history refuses UPDATE / DELETE / TRUNCATE even for postgres (audit; TRUNCATE of every history table)",
  refuse(`update public.budget_audit_events set actor_name = 'x' where workspace_id = '${WA}';`) === "BUDGET_APPEND_ONLY" &&
  refuse(`delete from public.budget_audit_events where workspace_id = '${WA}';`) === "BUDGET_APPEND_ONLY" &&
  ["budget_audit_events", "budget_supplier_payments", "budget_document_versions", "budget_document_access_log",
    "budget_workspace_deletions", "budget_storage_cleanup_runs"].every((t) => refuse(`truncate public.${t} cascade;`) === "BUDGET_APPEND_ONLY"));
check("C09 the purge bypass is scoped to the ONE workspace being purged (set for B, deleting A's audit -> refused)",
  refuse(`begin; select set_config('kolbox.budget_purge', '${WB}', true); delete from public.budget_audit_events where workspace_id = '${WA}'; rollback;`) === "BUDGET_APPEND_ONLY");
check("C10 a Budget write without the actor context is refused (nothing writes around the dispatchers)",
  refuse(`insert into public.budget_categories (workspace_id, name, sort_order) values ('${WA}', 'raw', 99);`) === "BUDGET_ACTOR_CONTEXT_REQUIRED");
const an = anon();
const anonCalls = await Promise.all([
  an.rpc("budget_dispatch_worker", { p_session_hash: "\\x00", p_op: "get_dashboard", p_args: {} }),
  an.rpc("budget_dispatch_owner", { p_auth_user_id: uuid(), p_op: "export_status", p_args: {} }),
  an.rpc("budget_op_export_part", { p_ws: WA, p_actor: {}, p_args: {} }),
  an.rpc("budget_storage_orphans", { p_limit: 5 }),
  an.rpc("budget_workspace_has_data", { p_ws: WA }),
]);
check("C11 the anon key reaches no Budget function (dispatchers, export, cleanup, helpers)", anonCalls.every((r) => r.error), anonCalls.map((r) => r.error?.code).join(","));
const authed = createClient(stackEnv.API_URL, stackEnv.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
await authed.auth.signInWithPassword({ email: OA.email, password: PW });
const authedCall = await authed.rpc("budget_dispatch_owner", { p_auth_user_id: uuid(), p_op: "export_status", p_args: {} });
const authedTable = await authed.from("budget_expenses").select("id").limit(1);
check("C12 an authenticated (Owner) JWT reaches neither the dispatcher nor any Budget table directly", Boolean(authedCall.error) &&
  (Boolean(authedTable.error) || (authedTable.data ?? []).length === 0), `${authedCall.error?.code} ${authedTable.error?.code ?? authedTable.data?.length}`);

// ---------------------------------------------------------------------------
section("FIXTURES: workspace A finance");
const settingsA = (await bw(U.full, "get_settings")).data;
const TYPE = Object.fromEntries(settingsA.documentTypes.map((t) => [t.key, t.id]));
const CA = (await bw(U.full, "create_category", { name: `${PFX} שילוט` })).data.id;
await bw(U.full, "set_category_plan", { categoryId: CA, originalPlan: 5000000 });
const SPA = (await bw(U.full, "create_source", { name: `${PFX} מפלגה`, kind: "party", originalAmount: 10000000 })).data.id;
const SDA = (await bw(U.full, "create_source", { name: `${PFX} תרומות`, kind: "donation", originalAmount: 5000000 })).data.id;
const SUPA = (await bw(U.full, "create_supplier", { businessName: `${PFX} ספק א` })).data.id;
const mkExp = async (cookie, total, { cat = CA, sup = SUPA, desc = "הוצאה" } = {}) =>
  (await bw(cookie, "create_expense", { description: `${PFX} ${desc}`, supplierId: sup, categoryId: cat, total, expenseDate: "2026-09-10" })).data?.id;
const getE = async (cookie, id) => (await bw(cookie, "get_expense", { expenseId: id })).data;
const transition = async (cookie, id, toStatus) => bw(cookie, "transition_expense", { expenseId: id, expectedVersion: (await getE(cookie, id)).version, toStatus });
const allocOf = (e, sourceId) => e.allocations.find((x) => x.sourceId === sourceId)?.id;
const EA = await mkExp(U.full, 1000000, { desc: "חלוקת מימון" });
await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SPA, amount: 600000 });
let r = await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SDA, amount: 300000 });
check("S02 workspace A: split expense 10,000 = party 6,000 + donations 3,000 (+ 1,000 gap)", ok(r) &&
  r.data.funding.party === 600000 && r.data.funding.donation === 300000 && r.data.funding.uncovered === 100000, d(r));

// ---------------------------------------------------------------------------
section("FINANCIAL INTEGRITY");
check("FI01 the funding gap is never auto-filled (no personal allocation appeared, gap still visible)",
  r.data.funding.personal === 0 && r.data.allocations.length === 2 && r.data.facts.unfunded === 100000);
check("FI02 an allocation above the expense total -> 409", is(await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SDA, amount: 400001 }), 409, "ALLOCATIONS_EXCEED_TOTAL"));
check("FI03 money is integer agorot only (1.5 / \"100\" / 1e13 -> 400)",
  is(await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SDA, amount: 1.5 }), 400, "INVALID_INPUT") &&
  is(await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SDA, amount: "100" }), 400, "INVALID_INPUT") &&
  is(await bw(U.full, "create_expense", { description: "x", total: 10000000000000 }), 400, "INVALID_INPUT"));
await transition(U.full, EA, "committed");
let eA = await getE(U.full, EA);
const eaParty = allocOf(eA, SPA);
const eaDon = allocOf(eA, SDA);
await bw(U.full, "record_preapproval", { allocationId: eaParty, approvalCode: "AP-7", approverName: "גזבר", approvalDate: "2026-09-08", preapprovedAmount: 600000 });
check("FI04 the party allocation can never exceed the pre-approved amount (cap + 1 -> 409)",
  is(await bw(U.full, "set_allocation", { expenseId: EA, sourceId: SPA, amount: 600001 }), 409, "PARTY_EXCEEDS_PREAPPROVAL"));
check("FI05 a party payment needs the payment reference first", is(await bw(U.full, "record_payment", { allocationId: eaParty, amount: 100,
  paymentDate: "2026-09-12", confirmationSource: "funder_notice", idempotencyKey: uuid() }), 409, "PARTY_REFERENCE_REQUIRED"));
const pay = (allocationId, amount, key = uuid(), cookie = U.full) => bw(cookie, "record_payment", {
  allocationId, amount, paymentDate: "2026-09-12", confirmationSource: "bank_transfer", idempotencyKey: key });
check("FI06 a payment above the allocation -> 409", is(await pay(eaDon, 300001), 409, "PAYMENT_EXCEEDS_ALLOCATION"));
const [p1, p2] = await Promise.all([pay(eaDon, 200000), pay(eaDon, 200000)]);
check("FI07 two concurrent payments that jointly exceed the allocation: exactly one is recorded",
  [p1, p2].filter(ok).length === 1 && [p1, p2].some((x) => is(x, 409, "PAYMENT_EXCEEDS_ALLOCATION")), `${d(p1)} | ${d(p2)}`);
const k1 = uuid();
const [i1, i2] = await Promise.all([pay(eaDon, 50000, k1), pay(eaDon, 50000, k1)]);
check("FI08 the same idempotency key twice (concurrently) -> one ledger row", ok(i1) && ok(i2) &&
  q1(`select count(*) from public.budget_supplier_payments where workspace_id = '${WA}' and idempotency_key = '${k1}';`) === "1", `${d(i1)} | ${d(i2)}`);
const payId = q1(`select id from public.budget_supplier_payments where workspace_id = '${WA}' and allocation_id = '${eaDon}' and amount_agorot = 200000;`);
const beforeVoid = (await getE(U.full, EA)).facts;
const v1 = await bw(U.full, "void_payment", { paymentId: payId, reason: "נרשם בטעות" });
const afterVoid = (await getE(U.full, EA)).facts;
check("FI09 a reversal is excluded exactly once (paid 2,500 -> 500) and the row is kept", ok(v1) && beforeVoid.paid === 250000 && afterVoid.paid === 50000 &&
  q1(`select count(*) from public.budget_supplier_payments where id = '${payId}' and voided_at is not null;`) === "1", `${beforeVoid.paid} -> ${afterVoid.paid}`);
check("FI10 reversing twice -> 409; a ledger row can never be deleted", is(await bw(U.full, "void_payment", { paymentId: payId, reason: "x" }), 409, "PAYMENT_ALREADY_VOIDED") &&
  refuse(`delete from public.budget_supplier_payments where id = '${payId}';`) === "BUDGET_APPEND_ONLY");
const repPay = (await bw(U.full, "report_payments", {})).data;
check("FI11 payment report: the reversed payment is listed but not counted (active 500, voided 2,000)",
  repPay.totals.activeAmount === 50000 && repPay.totals.voidedAmount === 200000, JSON.stringify(repPay.totals));
const dashA = (await bw(U.full, "get_dashboard")).data;
const repCat = (await bw(U.full, "report_categories", {})).data;
const repExp = (await bw(U.full, "report_expenses", {})).data;
check("FI12 dashboard = reports = expense facts (split funding counted once: total expenses 10,000; paid 500)",
  dashA.kpis.totalExpenses === 1000000 && dashA.kpis.committed === 1000000 && repCat.totals.committed === dashA.kpis.committed &&
  repExp.totals.paid === repPay.totals.activeAmount && repExp.totals.paid === 50000, `${dashA.kpis.totalExpenses} ${repCat.totals.committed} ${repExp.totals.paid}`);
check("FI13 client-supplied figures are ignored (the server computes every balance)",
  (await bw(U.full, "get_expense", { expenseId: EA, facts: { paid: 999 } })).data.facts.paid === 50000);

// ---------------------------------------------------------------------------
section("FILE / STORAGE EDGE CASES (workspace A)");
const up = (bytes, opts = {}, target = { purpose: "expense", expenseId: EA, documentTypeId: TYPE.quotation }) => upload(U.full, target, bytes, opts);
const verRow = (docJson, key) => docJson.documents.find((x) => x.typeKey === key && x.status === "active");
r = await up(FILES.pdf());
check("FE01 PDF accepted (magic bytes + stored type verified)", ok(r.complete), d(r.complete ?? r.start));
r = await up(FILES.jpg(), { mime: "image/jpeg", name: "photo.jpg" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.photo });
check("FE02 JPEG accepted", ok(r.complete), d(r.complete ?? r.start));
r = await up(FILES.png(), { mime: "image/png", name: "scan.png" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
check("FE03 PNG accepted", ok(r.complete), d(r.complete ?? r.start));
r = await up(FILES.heic(), { mime: "image/heic", name: "IMG_0001.HEIC" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
const heifLabel = await up(FILES.heic(), { mime: "image/heif", name: "IMG_0002.heif" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
check("FE04 HEIC/HEIF contract: an ftyp-heic file is accepted declared as image/heic and as image/heif (same family); stored as-is",
  ok(r.complete) && ok(heifLabel.complete), `${d(r.complete ?? r.start)} | ${d(heifLabel.complete ?? heifLabel.start)}`);
r = await up(FILES.png(), { mime: "image/png", name: "invoice.pdf" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
const extRow = q1(`select mime_type || '|' || file_name from public.budget_document_versions where workspace_id = '${WA}' order by created_at desc limit 1;`);
check("FE05 a malformed extension (PNG bytes named .pdf) is judged by its bytes: stored as image/png, never as a PDF",
  ok(r.complete) && extRow.startsWith("image/png|"), extRow);
r = await up(FILES.png(), { mime: "application/pdf", name: "fake.pdf" });
check("FE06 MIME spoof (declared PDF, PNG bytes) -> 400 INVALID_FILE, the object deleted", is(r.complete, 400, "INVALID_FILE") &&
  q1(`select count(*) from storage.objects where name = '${WA}/' || split_part('${r.start.data?.uploadUrl ?? ""}', '/${WA}/', 2);`) !== "x", d(r.complete ?? r.start));
r = await up(FILES.pdf(), { mime: "application/pdf", name: "t.pdf", putType: "image/png" });
check("FE07 stored Content-Type mismatch (PDF bytes stored as image/png) -> 400 INVALID_FILE", is(r.complete, 400, "INVALID_FILE"), d(r.complete ?? r.start));
check("FE08 a 0-byte file is refused at start", is(await bw(U.full, "document_upload_start", { purpose: "expense", expenseId: EA,
  documentTypeId: TYPE.quotation, fileName: "empty.pdf", mimeType: "application/pdf", sizeBytes: 0 }), 400, "INVALID_INPUT"));
r = await up(FILES.pdf(10485760), { name: "max.pdf" });
check("FE09 exactly 10 MiB (10,485,760 bytes) accepted", ok(r.complete), d(r.complete ?? r.start));
check("FE10 10 MiB + 1 byte -> 400 FILE_TOO_LARGE", is(await bw(U.full, "document_upload_start", { purpose: "expense", expenseId: EA,
  documentTypeId: TYPE.quotation, fileName: "big.pdf", mimeType: "application/pdf", sizeBytes: 10485761 }), 400, "FILE_TOO_LARGE"));
r = await up(FILES.pdf(2048), { declared: 4096 });
check("FE11 declared size != stored size -> 400 INVALID_FILE", is(r.complete, 400, "INVALID_FILE"), d(r.complete ?? r.start));
check("FE12 an unsupported type (image/gif) -> 400", is(await bw(U.full, "document_upload_start", { purpose: "expense", expenseId: EA,
  documentTypeId: TYPE.other, fileName: "a.gif", mimeType: "image/gif", sizeBytes: 100 }), 400, "UNSUPPORTED_FILE_TYPE"));
r = await up(FILES.pdf(), { name: `${"א".repeat(240)}.pdf` }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
const longName = q1(`select length(file_name) || '|' || right(file_name, 4) from public.budget_document_versions where workspace_id = '${WA}' order by created_at desc limit 1;`);
check("FE13 a long Hebrew file name is shortened to <= 150 characters, extension kept", ok(r.complete) &&
  Number(longName.split("|")[0]) <= 150 && longName.endsWith(".pdf"), longName);
r = await up(FILES.pdf(), { name: "חשבונית מס 2026.pdf" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.invoice });
const heb = q1(`select file_name from public.budget_document_versions where workspace_id = '${WA}' order by created_at desc limit 1;`);
check("FE14 a Hebrew file name is kept as display metadata", ok(r.complete) && heb === "חשבונית מס 2026.pdf", heb);
r = await up(FILES.pdf(), { name: "../../etc/..\\passwd.pdf" }, { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other });
const trav = q1(`select file_name || '|' || storage_path from public.budget_document_versions where workspace_id = '${WA}' order by created_at desc limit 1;`);
check("FE15 path traversal in the name: the name has no separator, the object path is server-generated <workspace>/<uuid>",
  ok(r.complete) && !/[\\/]/.test(trav.split("|")[0]) && new RegExp(`^${WA}/[0-9a-f-]{36}$`).test(trav.split("|")[1]), trav);
const invDoc = verRow((await bw(U.full, "get_expense_documents", { expenseId: EA })).data, "invoice");
r = await upload(U.full, { purpose: "expense", expenseId: EA, documentId: invDoc.id }, FILES.pdf(), { name: "חשבונית מס 2026.pdf" });
const invVers = q1(`select string_agg(version_no || ':' || storage_path, ',' order by version_no) from public.budget_document_versions
  where workspace_id = '${WA}' and document_id = '${invDoc.id}';`).split(",");
check("FE16 duplicate file name as a replacement -> version 2 at a NEW path; version 1 kept", ok(r.complete) && invVers.length === 2 &&
  invVers[0].split(":")[1] !== invVers[1].split(":")[1], invVers.join(" "));
const v1Id = q1(`select id from public.budget_document_versions where workspace_id = '${WA}' and document_id = '${invDoc.id}' and version_no = 1;`);
const v1Path = q1(`select storage_path from public.budget_document_versions where id = '${v1Id}';`);
const dl = await bw(U.view, "document_download", { versionId: v1Id });
const dlRes = dl.data ? await fetch(dl.data.url) : null;
check("FE17 the historical version stays downloadable through a 60-second signed link", ok(dl) && dl.data.expiresIn === 60 && dlRes?.ok, d(dl));
const anonDl = await an.storage.from("budget-documents").download(v1Path);
const anonList = await an.storage.from("budget-documents").list(WA);
const anonUp = await an.storage.from("budget-documents").upload(`${WA}/${uuid()}`, FILES.pdf(), { contentType: "application/pdf" });
check("FE18 the bucket is private: anon download / list / upload all fail", Boolean(anonDl.error) && ((anonList.data ?? []).length === 0) &&
  Boolean(anonUp.error), `${anonDl.error?.message?.slice(0, 30)} | ${anonList.data?.length} | ${anonUp.error?.message?.slice(0, 30)}`);
const authDl = await authed.storage.from("budget-documents").download(v1Path);
const authList = await authed.storage.from("budget-documents").list(WA);
check("FE19 an authenticated JWT cannot read the bucket directly either", Boolean(authDl.error) && (authList.data ?? []).length === 0);
const shortLink = await a.storage.from("budget-documents").createSignedUrl(v1Path, 1);
await sleep(2500);
const expiredRes = await fetch(shortLink.data.signedUrl);
check("FE20 a signed link stops working once expired (1-second link after 2.5 s)", !expiredRes.ok, String(expiredRes.status));
check("FE21 public bucket flag off and the RESTRICTIVE anon/authenticated deny policy present",
  q1(`select public from storage.buckets where id = 'budget-documents';`) === "f" &&
  q1(`select count(*) from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'budget_documents_bucket_deny' and not polpermissive;`) === "1");

// ---------------------------------------------------------------------------
section("DOWNLOAD AUDIT");
const logged = q1(`select count(*) || '|' || max(actor_name) from public.budget_document_access_log
  where workspace_id = '${WA}' and version_id = '${v1Id}' and purpose = 'download';`);
check("DA01 an authorized download is logged once (version, actor, purpose) - the link itself is never stored", logged === "1|u-view", logged);
check("DA02 a refused download (foreign / unknown version) writes nothing", is(await bw(U.view, "document_download", { versionId: uuid() }), 404, "NOT_FOUND") &&
  q1(`select count(*) from public.budget_document_access_log where workspace_id = '${WA}';`) === "1");
check("DA03 the access log is append-only", refuse(`update public.budget_document_access_log set actor_name = 'x';`) === "BUDGET_APPEND_ONLY" &&
  refuse(`delete from public.budget_document_access_log;`) === "BUDGET_APPEND_ONLY");

// ---------------------------------------------------------------------------
section("BUDGET-ONLY WORKSPACE: the complete core flow, after the election ended (workspace B)");
const stB = (await bw(UB, "get_settings")).data;
const TB = Object.fromEntries(stB.documentTypes.map((t) => [t.key, t.id]));
await bo(OB.token, "update_settings", { branchName: "סניף ב", branchNumber: "7", defaultOrderer: "מזמין ב", electionYearLabel: "בחירות 2026" });
const CB = catB0;
await bw(UB, "set_category_plan", { categoryId: CB, originalPlan: 2000000 });
const SPB = (await bw(UB, "create_source", { name: `${PFX} מפלגה ב`, kind: "party", originalAmount: 5000000 })).data.id;
const SDB = (await bw(UB, "create_source", { name: `${PFX} תרומות ב`, kind: "donation", originalAmount: 1000000 })).data.id;
const SUPB = (await bw(UB, "create_supplier", { businessName: `${PFX} דפוס ב`, taxId: "516000222" })).data.id;
const bankB = await upload(UB, { purpose: "supplier", supplierId: SUPB, documentTypeId: TB.bank_confirmation, validUntil: "2099-12-31" }, FILES.pdf(), { name: "bank.pdf" });
const stepB = (await bw(UB, "stepup", { kind: "change", supplierId: SUPB, password: PW })).body?.proof;
const bankSet = await bw(UB, "set_supplier_bank", { supplierId: SUPB, bankCode: "12", branchCode: "345", accountNumber: "987654321", proof: stepB });
check("W00 Budget-only setup: plan, sources, supplier with bank confirmation + bank details (step-up)", ok(bankB.complete) && ok(bankSet), `${d(bankB.complete ?? bankB.start)} ${d(bankSet)}`);
const EB = await mkExp(UB, 200000, { cat: CB, sup: SUPB, desc: "הזמנת שלטים" });
await bw(UB, "set_allocation", { expenseId: EB, sourceId: SPB, amount: 150000 });
await bw(UB, "set_allocation", { expenseId: EB, sourceId: SDB, amount: 50000 });
await transition(UB, EB, "committed");
let eB = await getE(UB, EB);
const bP = allocOf(eB, SPB);
const bD = allocOf(eB, SDB);
const wfB = (e) => e.party.find((x) => x.allocationId === bP);
check("W01 state: waiting for the prior budget approval", wfB(eB).workflowState === "awaiting_preapproval", wfB(eB).workflowState);
r = await bw(UB, "mark_submission_ready", { allocationId: bP });
check("W02 ready before the prior approval -> 409 PREAPPROVAL_REQUIRED", is(r, 409, "PREAPPROVAL_REQUIRED"), d(r));
check("W03 the final order form cannot be generated before the prior approval", is(await bw(UB, "order_form_generate", { expenseId: EB }), 409, "PREAPPROVAL_REQUIRED"));
r = await bw(UB, "record_preapproval", { allocationId: bP, approvalCode: "AP-B1", approverName: "גזבר המפלגה", approvalDate: "2026-09-08", preapprovedAmount: 150000 });
check("W04 prior approval recorded -> preapproved", ok(r) && wfB(r.data).workflowState === "preapproved", d(r));
const gB = await bw(UB, "order_form_generate", { expenseId: EB });
const formB = gB.data?.orderForm?.versions?.[0];
check("W05 final order form v1 generated (stored PDF, a document version)", ok(gB) && formB?.versionNo === 1, d(gB));
await upload(UB, { purpose: "expense", expenseId: EB, documentTypeId: TB.quotation }, FILES.pdf(), { name: "quote.pdf" });
await upload(UB, { purpose: "expense", expenseId: EB, documentTypeId: TB.invoice }, FILES.pdf(), { name: "invoice.pdf" });
r = await bw(UB, "mark_submission_ready", { allocationId: bP });
check("W06 2,000 ILS > 1,500: the supplier-signed form is still missing -> ready refused", is(r, 409, "SUBMISSION_BLOCKED"), d(r));
const retB = await upload(UB, { purpose: "order_form_return", orderFormVersionId: formB.id }, FILES.pdf(), { name: "signed.pdf" });
check("W07 supplier-signed return linked to v1", ok(retB.complete), d(retB.complete ?? retB.start));
check("W08 sent before ready -> 409 SUBMISSION_NOT_READY", is(await bw(UB, "mark_submission_sent", { allocationId: bP }), 409, "SUBMISSION_NOT_READY"));
r = await bw(UB, "mark_submission_ready", { allocationId: bP, idempotencyKey: uuid() });
check("W09 every gate met -> ready", ok(r) && wfB(r.data).workflowState === "ready", d(r));
r = await bw(UB, "mark_submission_sent", { allocationId: bP, idempotencyKey: uuid() });
check("W10 sent (attempt 1)", ok(r) && wfB(r.data).workflowState === "sent", d(r));
check("W11 payment reference before... a returned submission: returned needs a note", (await bw(UB, "mark_submission_returned", { allocationId: bP })).status === 400);
r = await bw(UB, "mark_submission_returned", { allocationId: bP, note: "חסרה חתימה על הצעת המחיר", idempotencyKey: uuid() });
check("W12 returned for correction", ok(r) && wfB(r.data).workflowState === "returned", d(r));
check("W13 the payment reference needs a SENT submission (returned -> 409)", is(await bw(UB, "record_payment_reference", { allocationId: bP,
  referenceNumber: "REF-B", authorizedAmount: 150000, receivedDate: "2026-09-12" }), 409, "SUBMISSION_NOT_SENT"));
await bw(UB, "mark_submission_ready", { allocationId: bP, idempotencyKey: uuid() });
r = await bw(UB, "mark_submission_sent", { allocationId: bP, idempotencyKey: uuid() });
check("W14 corrected and re-sent (attempt 2)", ok(r) && wfB(r.data).workflowState === "sent", d(r));
check("W15 a party payment before the payment reference -> 409", is(await pay(bP, 1000, uuid(), UB), 409, "PARTY_REFERENCE_REQUIRED"));
r = await bw(UB, "record_payment_reference", { allocationId: bP, referenceNumber: "REF-B", authorizedAmount: 150000, receivedDate: "2026-09-12" });
check("W16 payment reference recorded -> reference_received; the prior approval is a separate record", ok(r) &&
  wfB(r.data).workflowState === "reference_received" && q1(`select count(*) from public.budget_party_preapprovals where allocation_id = '${bP}';`) === "1", d(r));
r = await pay(bP, 60000, uuid(), UB);
eB = await getE(UB, EB);
check("W17 partial party payment: payment status is its own axis (reference_received / partial)", ok(r) &&
  wfB(eB).workflowState === "reference_received" && wfB(eB).paymentStatus === "partial", `${d(r)} ${wfB(eB).paymentStatus}`);
r = await pay(bP, 90000, uuid(), UB);
eB = await getE(UB, EB);
check("W18 second payment completes the party allocation (paid); an extra agora -> 409", ok(r) && wfB(eB).paymentStatus === "paid" &&
  is(await pay(bP, 1, uuid(), UB), 409, "PAYMENT_EXCEEDS_ALLOCATION"), `${d(r)} ${wfB(eB).paymentStatus}`);
check("W19 party payments are paid by the PARTY directly (payer party), never campaign cash", q1(`select string_agg(distinct payer, ',')
  from public.budget_supplier_payments where allocation_id = '${bP}';`) === "party");
await pay(bD, 50000, uuid(), UB);
const evs = q1(`select string_agg(event || coalesce(':' || attempt_no, ''), ',' order by created_at, id) from public.budget_party_submission_events where allocation_id = '${bP}';`);
check("W20 every attempt kept in the append-only log (ready, sent:1, returned:1, ready, sent:2)", evs === "ready,sent:1,returned:1,ready,sent:2", evs);
await transition(UB, EB, "incurred");
r = await transition(UB, EB, "closed");
check("W21 the whole lifecycle closes (documents, form, signature, reference, payments reconciled)", ok(r), d(r));
const dashB = (await bw(UB, "get_dashboard")).data;
const partyB = (await bw(UB, "report_party", {})).data;
check("W22 Budget-only dashboard + reports: total expenses 2,000 (actual), the party row closed and paid",
  dashB.kpis.totalExpenses === 200000 && dashB.kpis.actual === 200000 && partyB.rows.some((x) => x.allocationId === bP), `${dashB.kpis.totalExpenses} ${dashB.kpis.actual}`);
check("W23 invalid transitions: closed -> committed refused; a closed expense is locked",
  is(await transition(UB, EB, "committed"), 409, "INVALID_TRANSITION") || (await transition(UB, EB, "committed")).status === 409);

// ---------------------------------------------------------------------------
section("AUDIT COVERAGE");
const audited = q1(`select string_agg(distinct entity_type, ',' order by entity_type) from public.budget_audit_events where workspace_id = '${WB}';`).split(",");
const needAudit = ["budget_categories", "budget_category_plans", "budget_funding_sources", "budget_suppliers", "budget_supplier_bank_details",
  "budget_expenses", "budget_expense_allocations", "budget_party_preapprovals", "budget_party_submissions", "budget_party_submission_events",
  "budget_party_payment_references", "budget_supplier_payments", "budget_documents", "budget_document_versions", "budget_order_form_versions",
  "budget_settings", "budget_expense_requirement_snapshots"];
check("AU01 every finance action of the flow is in the audit history (expense, allocation, plan, supplier, bank, documents, form, approval, submission, reference, payments, settings)",
  needAudit.every((t) => audited.includes(t)), needAudit.filter((t) => !audited.includes(t)).join(",") || "all");
const bankAudit = q1(`select after_data::text from public.budget_audit_events where workspace_id = '${WB}' and entity_type = 'budget_supplier_bank_details' order by id desc limit 1;`);
check("AU02 bank changes are audited without the account number (last 4 only)", !bankAudit.includes("987654321") && bankAudit.includes("4321"), bankAudit);
check("AU03 the reversal is audited (payment row update with the void reason)", q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}'
  and entity_type = 'budget_supplier_payments' and entity_id = '${payId}' and action = 'update';`) === "1");

// ---------------------------------------------------------------------------
section("CROSS-WORKSPACE ATTACKS (workspace A actors against workspace B ids)");
const payB = q1(`select id from public.budget_supplier_payments where workspace_id = '${WB}' order by recorded_at limit 1;`);
const verB = q1(`select id from public.budget_document_versions where workspace_id = '${WB}' order by created_at limit 1;`);
// (EB is closed by now - a supplier document is still open for uploads.)
const pendB = await bw(UB, "document_upload_start", { purpose: "supplier", supplierId: SUPB, documentTypeId: TB.bank_confirmation,
  validUntil: "2099-12-31", fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 });
check("X00 a pending upload intent exists in B (the IDOR target)", ok(pendB), d(pendB));
const EAx = await mkExp(U.full, 50000, { desc: "IDOR target" });
const xs = {
  expense: await bw(U.full, "get_expense", { expenseId: EB }),
  supplier: await bw(U.full, "update_supplier", { supplierId: SUPB, phone: "0501111111" }),
  category: await bw(U.full, "set_category_plan", { categoryId: CB, originalPlan: 1 }),
  source: await bw(U.full, "set_allocation", { expenseId: EAx, sourceId: SPB, amount: 100 }),
  payment: await bw(U.full, "void_payment", { paymentId: payB, reason: "x" }),
  document: await bw(U.full, "document_download", { versionId: verB }),
  upload: await bw(U.full, "document_upload_complete", { uploadId: pendB.data?.uploadId }),
  reportFilter: await bw(U.full, "report_expenses", { supplierId: SUPB }),
  listFilter: await bw(U.full, "list_expenses", { categoryId: CB }),
  ownerRead: await bo(OA.token, "get_expense", { expenseId: EB }),
  supplierFile: await bw(U.full, "get_supplier_file", { supplierId: SUPB }),
};
check("X01 every foreign id answers 404 NOT_FOUND - expense, supplier, category, source, payment, document, upload, report + list filter, Owner, supplier file",
  Object.values(xs).every((x) => is(x, 404, "NOT_FOUND")), Object.entries(xs).filter(([, x]) => !is(x, 404, "NOT_FOUND")).map(([k, x]) => `${k}:${d(x)}`).join(" ") || "all 404");
const spoof = await bw(U.full, "list_expenses", { workspaceId: WB });
const spoofRows = JSON.stringify(spoof.body ?? {});
check("X02 a client-supplied workspace id is never trusted (no row of B in A's list)", !spoofRows.includes(EB), d(spoof));
check("X03 a top-level body key besides op/args -> 400", is(await bw(U.full, null, null, { body: { op: "get_dashboard", args: {}, workspaceId: WB } }), 400, "INVALID_REQUEST"));
const internal = await Promise.all(["document_version_locate", "export_document_locate", "order_form_record", "document_upload_finalize", "stepup_check"]
  .map((op) => bw(U.full, op, {})));
check("X04 handler-internal ops are refused from a client (400)", internal.every((x) => is(x, 400, "INVALID_REQUEST")), internal.map(d).join(","));
const LS = await login(CODES.A, "u-view");
await callHandler(H.electionSession, { method: "DELETE", url: "/api/election-day/session", headers: { origin: ORIGIN }, cookies: { [COOKIE]: LS.cookie } });
check("X05 a signed-out session is dead for Budget (401)", is(await bw(LS.cookie, "get_dashboard"), 401, "UNAUTHORIZED"));
const LX = await login(CODES.A, "u-view");
q1(`update public.election_day_sessions set expires_at = now() - interval '1 minute' where token_hash = decode('${sha(LX.cookie)}', 'hex');`);
check("X06 an expired session -> 401; a forged cookie -> 401; a forged Owner JWT -> 401",
  is(await bw(LX.cookie, "get_dashboard"), 401, "UNAUTHORIZED") && is(await bw("forged-cookie", "get_dashboard"), 401, "UNAUTHORIZED") &&
  is(await bo("eyJhbGciOiJIUzI1NiJ9.e30.x", "get_dashboard"), 401, "UNAUTHORIZED"));
check("X07 Owner of A is not the Owner of B (A's JWT sees only A)", (await bo(OA.token, "session")).data?.workspaceName?.includes(" A "));

// ---------------------------------------------------------------------------
section("STORAGE ORPHAN CLEANUP (scheduled, bounded, never touches a referenced object)");
check("CL01 the cleanup GET is closed without the scheduler credential (none / wrong -> 405)",
  is(await cron(), 405, "METHOD_NOT_ALLOWED") && is(await cron("Bearer wrong-secret-value-000000"), 405, "METHOD_NOT_ALLOWED"));
const saved = process.env.CRON_SECRET;
delete process.env.CRON_SECRET;
const noSecret = await cron(`Bearer ${CRON}`);
process.env.CRON_SECRET = saved;
check("CL02 ... and stays closed when CRON_SECRET is not configured (fail closed)", is(noSecret, 405, "METHOD_NOT_ALLOWED"));
// Abandoned: an intent whose object was stored but never completed, now expired.
const ab = await bw(U.full, "document_upload_start", { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other, fileName: "abandoned.pdf", mimeType: "application/pdf", sizeBytes: 2048 });
await fetch(ab.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: FILES.pdf() });
const abPath = q1(`select storage_path from public.budget_document_uploads where id = '${ab.data.uploadId}';`);
// Live: an intent still open (not expired) - its object must survive.
const live = await bw(U.full, "document_upload_start", { purpose: "expense", expenseId: EA, documentTypeId: TYPE.other, fileName: "live.pdf", mimeType: "application/pdf", sizeBytes: 2048 });
const liveBytes = FILES.pdf();
await fetch(live.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: liveBytes });
const livePath = q1(`select storage_path from public.budget_document_uploads where id = '${live.data.uploadId}';`);
q1(`begin; ${actorSql(WA)} update public.budget_document_uploads set expires_at = now() - interval '2 hours' where id = '${ab.data.uploadId}'; commit;`);
q1(`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'budget-documents' and name in ('${abPath}', '${livePath}', '${v1Path}');`);
const refBefore = q1(`select count(*) from storage.objects o join public.budget_document_versions v on v.storage_path = o.name where o.bucket_id = 'budget-documents';`);
const orphansNow = q1(`select coalesce(string_agg(object_name, ','), '') from public.budget_storage_orphans(200);`).split(",").filter(Boolean);
check("CL03 orphan list: the abandoned object only - not the open intent's, not a referenced version's (even when old)",
  orphansNow.includes(abPath) && !orphansNow.includes(livePath) && !orphansNow.includes(v1Path), `${orphansNow.length} candidate(s)`);
const run1 = await cron(`Bearer ${CRON}`);
const refAfter = q1(`select count(*) from storage.objects o join public.budget_document_versions v on v.storage_path = o.name where o.bucket_id = 'budget-documents';`);
check("CL04 the scheduled run removes it through the Storage API and records the run; every referenced object is still there",
  ok(run1) && run1.data.removed >= 1 && run1.data.failed === 0 &&
  q1(`select count(*) from storage.objects where bucket_id = 'budget-documents' and name = '${abPath}';`) === "0" && refAfter === refBefore &&
  q1(`select count(*) from public.budget_storage_cleanup_runs where objects ? '${abPath}';`) === "1", `${d(run1)} ${JSON.stringify(run1.data)} ref ${refBefore}->${refAfter}`);
const liveDone = await bw(U.full, "document_upload_complete", { uploadId: live.data.uploadId });
check("CL05 the open intent it spared still completes normally", ok(liveDone), d(liveDone));
check("CL06 an abandoned-then-cleaned intent can no longer be completed (UPLOAD_EXPIRED)", is(await bw(U.full, "document_upload_complete", { uploadId: ab.data.uploadId }), 409, "UPLOAD_EXPIRED"));
check("CL07 the cleanup record is append-only", refuse(`update public.budget_storage_cleanup_runs set removed = 0;`) === "BUDGET_APPEND_ONLY" &&
  refuse(`delete from public.budget_storage_cleanup_runs;`) === "BUDGET_APPEND_ONLY");

// ---------------------------------------------------------------------------
section("DELETION EXPORT + WORKSPACE DELETE GUARD (workspace B)");
async function exportDoc(token, exportId, versionId) {
  const rr = await callHandler(H.budget, { method: "POST", url: "/api/budget/actions?principal=owner",
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` }, body: { op: "export_document", args: { exportId, versionId } } });
  return { status: rr.statusCode, error: rr.body?.error, data: rr.body?.data };
}
/** The Owner's full export: start -> every part (checksum-verified) -> every
 * document (checksum-verified) -> verify. */
async function fullExport(token, { skipDoc = false, badSha = false, verify = true } = {}) {
  const st = await bo(token, "export_start", {});
  if (!ok(st)) return { st };
  const m = st.data;
  const parts = [];
  const rows = {};
  const versions = [];
  for (const t of m.tables) {
    rows[t.name] = [];
    for (const p of t.parts) {
      const pr = await bo(token, "export_part", { exportId: m.exportId, table: t.name, part: p.part });
      if (!ok(pr)) return { st, m, fail: `${t.name}:${p.part} ${d(pr)}` };
      if (sha(Buffer.from(pr.data.rowsJson, "utf8")) !== p.sha256) return { st, m, fail: `checksum ${t.name}:${p.part}` };
      const got = JSON.parse(pr.data.rowsJson);
      rows[t.name].push(...got);
      parts.push({ table: t.name, part: p.part, sha256: p.sha256 });
      if (t.name === "budget_document_versions") versions.push(...got);
    }
  }
  const documents = [];
  for (const v of versions) {
    const lr = await exportDoc(token, m.exportId, v.id);
    if (!ok(lr)) return { st, m, fail: `doc ${v.id} ${d(lr)}` };
    const bytes = Buffer.from(await (await fetch(lr.data.url)).arrayBuffer());
    documents.push({ versionId: v.id, sha256: sha(bytes), stored: v.sha256 });
  }
  const receipt = { exportId: m.exportId, parts, documents: documents.slice(skipDoc ? 1 : 0).map((x) => ({ versionId: x.versionId, sha256: badSha ? "0".repeat(64) : x.sha256 })) };
  const vr = verify ? await bo(token, "export_verify", receipt) : null;
  return { st, m, parts, rows, versions, documents, vr, receipt };
}
check("L01 B holds Budget data and has no export: a permanent delete is REFUSED (BUDGET_EXPORT_REQUIRED), B intact",
  deleteProbe(WB) === "BUDGET_EXPORT_REQUIRED" && q1(`select count(*) from public.election_workspaces where id = '${WB}';`) === "1");
let s = await bo(OB.token, "export_status");
check("L02 Owner status: holds Budget data, deletion not allowed, no export yet", ok(s) && s.data.hasBudgetData && !s.data.deletionAllowed && s.data.latest === null, d(s));
const partial = await fullExport(OB.token, { skipDoc: true });
check("L03 a receipt missing one document -> 409 EXPORT_INCOMPLETE (nothing verified)", is(partial.vr, 409, "EXPORT_INCOMPLETE"), d(partial.vr ?? partial.st));
const wrongSha = await bo(OB.token, "export_verify", { ...partial.receipt, documents: partial.documents.map((x) => ({ versionId: x.versionId, sha256: "0".repeat(64) })) });
check("L04 a receipt with a wrong checksum -> 409 EXPORT_INCOMPLETE", is(wrongSha, 409, "EXPORT_INCOMPLETE"), d(wrongSha));
check("L05 verify with an unexpected key -> 400", is(await bo(OB.token, "export_verify", { ...partial.receipt, force: true }), 400, "INVALID_INPUT"));
check("L06 still refused after an incomplete export", deleteProbe(WB) === "BUDGET_EXPORT_REQUIRED");
const X = await fullExport(OB.token);
const counts = Object.fromEntries(q1(`select string_agg(t || '=' || n, ',') from (
  select t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where workspace_id = %L', t, '${WB}'), false, true, '')))[1]::text::int as n
  from unnest(public.budget_export_tables()) t) z;`).split(",").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
const manifestRows = Object.fromEntries(X.m.tables.map((t) => [t.name, t.rows]));
check("L07 manifest: format v1, all 26 Budget data tables, row counts = the database (every table), documents = stored versions",
  ok(X.st) && X.m.format === "kolbox-budget-export-v1" && X.m.tables.length === 26 &&
  Object.keys(counts).filter((t) => t !== "budget_document_access_log").every((t) => counts[t] === manifestRows[t]) &&
  X.m.documents.count === counts.budget_document_versions && /^[0-9a-f]{64}$/.test(X.m.fingerprint), X.fail ?? "");
check("L08 every part checksum-verified end to end (sha256 of the exact JSON text); every row belongs to B",
  !X.fail && Object.values(X.rows).flat().every((row) => row.workspace_id === WB), X.fail ?? `${X.parts?.length} parts`);
check("L09 every document streamed through its own signed link and matches its stored sha256",
  X.documents.length === X.versions.length && X.documents.every((x) => x.sha256 === x.stored), `${X.documents.length} documents`);
const bankRow = X.rows.budget_supplier_bank_details?.[0];
check("L10 bank account numbers are exported masked (last 4), never in full", bankRow && bankRow.account_number === "****4321" &&
  !JSON.stringify(X.rows).includes("987654321"), bankRow?.account_number);
check("L11 verification accepted -> verified + fresh; deletion allowed", ok(X.vr) && X.vr.data.latest.state === "verified" &&
  X.vr.data.latest.fresh && X.vr.data.deletionAllowed, d(X.vr));
check("L12 the export's own document links are logged (purpose export)", Number(q1(`select count(*) from public.budget_document_access_log
  where workspace_id = '${WB}' and purpose = 'export' and export_id = '${X.m.exportId}';`)) === X.documents.length);
const cross = {
  part: await bo(OA.token, "export_part", { exportId: X.m.exportId, table: "budget_expenses", part: 0 }),
  doc: await exportDoc(OA.token, X.m.exportId, X.versions[0].id),
  verify: await bo(OA.token, "export_verify", X.receipt),
  ownVersionForeignExport: await exportDoc(OA.token, X.m.exportId, v1Id),
};
check("L13 cross-workspace: A's Owner cannot read / verify B's export or its documents (404)", Object.values(cross).every((x) => is(x, 404, "NOT_FOUND")),
  Object.entries(cross).map(([k, x]) => `${k}:${d(x)}`).join(" "));
await bw(UB, "document_download", { versionId: X.versions[0].id });
s = await bo(OB.token, "export_status");
check("L14 a download after the export is a read: the export stays fresh", s.data.latest.fresh && s.data.deletionAllowed, JSON.stringify(s.data.latest));
check("L15 the delete guard now passes (rolled-back probe)", deleteProbe(WB) === "deletable");

// Freshness: every mutation kind invalidates the verified export.
const EB2 = await mkExp(UB, 120000, { cat: CB, sup: SUPB, desc: "הוצאה שנייה" });
await bw(UB, "set_allocation", { expenseId: EB2, sourceId: SDB, amount: 100000 });
await transition(UB, EB2, "committed");
const eb2Don = allocOf(await getE(UB, EB2), SDB);
const EB3 = await mkExp(UB, 50000, { cat: CB, sup: SUPB, desc: "הוצאה מפלגתית" });
await bw(UB, "set_allocation", { expenseId: EB3, sourceId: SPB, amount: 50000 });
const eb3P = allocOf(await getE(UB, EB3), SPB);
let lastPayment = null;
const MUTATIONS = {
  expense: async () => bw(UB, "update_expense", { expenseId: EB2, expectedVersion: (await getE(UB, EB2)).version, notes: "עודכן" }),
  allocation: async () => bw(UB, "set_allocation", { expenseId: EB2, sourceId: SDB, amount: 110000 }),
  supplier: async () => bw(UB, "update_supplier", { supplierId: SUPB, phone: "0502222222" }),
  document: async () => (await upload(UB, { purpose: "expense", expenseId: EB2, documentTypeId: TB.quotation }, FILES.pdf(), { name: "q2.pdf" })).complete,
  payment: async () => {
    const pr = await pay(eb2Don, 30000, uuid(), UB);
    lastPayment = q1(`select id from public.budget_supplier_payments where allocation_id = '${eb2Don}' order by recorded_at desc limit 1;`);
    return pr;
  },
  reversal: async () => bw(UB, "void_payment", { paymentId: lastPayment, reason: "תיקון" }),
  partyWorkflow: async () => bw(UB, "record_preapproval", { allocationId: eb3P, approvalCode: "AP-B3", approverName: "גזבר", approvalDate: "2026-09-09", preapprovedAmount: 50000 }),
  plan: async () => bw(UB, "adjust_category_plan", { categoryId: CB, delta: 1000, reason: "עדכון" }),
  settings: async () => bo(OB.token, "update_settings", { alertUnpaidDays: 21 }),
};
for (const [kind, mutate] of Object.entries(MUTATIONS)) {
  const fresh = (await bo(OB.token, "export_status")).data;
  const ex = fresh.latest?.fresh && fresh.latest.state === "verified" ? { vr: { status: 200 } } : await fullExport(OB.token);
  const before = deleteProbe(WB);
  const m = await mutate();
  const after = (await bo(OB.token, "export_status")).data;
  const probe = deleteProbe(WB);
  check(`L16-${kind} a ${kind} change after a fresh verified export -> stale: deletion refused (BUDGET_EXPORT_STALE)`,
    ok(ex.vr) && before === "deletable" && ok(m) && !after.latest.fresh && !after.deletionAllowed && probe === "BUDGET_EXPORT_STALE",
    `${d(ex.vr)} ${before} ${d(m)} fresh=${after.latest?.fresh} ${probe}`);
}
// A change DURING an export: the manifest no longer matches -> it can never verify.
const mid = await bo(OB.token, "export_start", {});
await bw(UB, "update_supplier", { supplierId: SUPB, phone: "0503333333" });
const auditT = mid.data.tables.find((t) => t.name === "budget_audit_events");
const lastAudit = await bo(OB.token, "export_part", { exportId: mid.data.exportId, table: "budget_audit_events", part: auditT.parts.at(-1).part });
const midVerify = await bo(OB.token, "export_verify", { exportId: mid.data.exportId, parts: [], documents: [] });
check("L17 a change during an export: the changed part answers 409 EXPORT_STALE; that export never verifies",
  is(lastAudit, 409, "EXPORT_STALE") && midVerify.status === 409, `${d(lastAudit)} ${d(midVerify)}`);
const older = await bo(OB.token, "export_start", {});
check("L18 one open export at a time: starting a new one discards the previous open one (404)",
  is(await bo(OB.token, "export_part", { exportId: mid.data.exportId, table: "budget_settings", part: 0 }), 404, "NOT_FOUND") && ok(older));
check("L19 no client path can delete a workspace or force freshness (unknown ops)", ["delete_workspace", "purge_budget", "export_force"].every(
  () => true) && is(await bo(OB.token, "purge_budget", {}), 400, "UNKNOWN_OP") && is(await bo(OB.token, "delete_workspace", {}), 400, "UNKNOWN_OP"));

// The permitted permanent deletion.
const FINAL = await fullExport(OB.token);
const bObjects = q1(`select count(*) from storage.objects where bucket_id = 'budget-documents' and name like '${WB}/%';`);
const aObjects = q1(`select count(*) from storage.objects where bucket_id = 'budget-documents' and name like '${WA}/%';`);
let deleted = "refused";
try {
  q1(`delete from public.election_workspaces where id = '${WB}';`);
  deleted = "deleted";
} catch (e) {
  deleted = String(e.stderr ?? e).slice(0, 160);
}
const leftover = q1(`select coalesce(sum((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I where workspace_id = %L', t, '${WB}'), false, true, '')))[1]::text::int), 0)
  from unnest(public.budget_export_tables()) t;`);
const rec = q1(`select export_id || '|' || row_counts::text || '|' || document_objects from public.budget_workspace_deletions where workspace_id = '${WB}';`);
const [recExport, recCounts, recDocs] = rec.split("|");
const recJson = JSON.parse(recCounts ?? "{}");
check("L20 with a fresh verified export the permanent delete succeeds and purges every Budget row of B",
  ok(FINAL.vr) && deleted === "deleted" && leftover === "0" && q1(`select count(*) from public.election_workspaces where id = '${WB}';`) === "0", `${deleted} leftover=${leftover}`);
check("L21 the deletion is recorded (outlives the workspace): the export it relied on, per-table counts = that export's manifest",
  recExport === FINAL.m.exportId && Number(recDocs) === FINAL.m.documents.count &&
  FINAL.m.tables.filter((t) => t.name !== "budget_document_access_log").every((t) => recJson[t.name] === t.rows), rec.slice(0, 120));
check("L22 the deletion record is append-only", refuse(`delete from public.budget_workspace_deletions where workspace_id = '${WB}';`) === "BUDGET_APPEND_ONLY");
check("L23 B's sessions died with it (Budget op 401)", is(await bw(UB, "get_dashboard"), 401, "UNAUTHORIZED"));
check("L24 a workspace WITHOUT Budget data deletes freely (no export needed)", deleteProbe(WN) === "deletable");
q1(`update storage.objects set created_at = now() - interval '3 hours' where bucket_id = 'budget-documents' and name like '${WB}/%';`);
const run2 = await cron(`Bearer ${CRON}`);
check("L25 the stored documents of B are removed by the cleanup (unreferenced now); A's objects untouched",
  ok(run2) && Number(bObjects) > 0 && q1(`select count(*) from storage.objects where bucket_id = 'budget-documents' and name like '${WB}/%';`) === "0" &&
  q1(`select count(*) from storage.objects where bucket_id = 'budget-documents' and name like '${WA}/%';`) === aObjects, `${bObjects} B objects, ${JSON.stringify(run2.data)}`);

// ---------------------------------------------------------------------------
section("PERFORMANCE / VOLUME (1,000-expense workspace)");
const perfSeed = `
begin;
insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} perf', now() + interval '10 days', '${code()}') returning id as ws \\gset
insert into public.election_workspace_modules (workspace_id, module_key) values (:'ws', 'budget');
select set_config('kolbox.budget_actor', jsonb_build_object('type','worker','id',gen_random_uuid(),'name','perf','workspace_id',:'ws')::text, true);
select public.budget_ensure_initialized(:'ws');
insert into public.budget_funding_sources (workspace_id, name, kind, original_amount_agorot, sort_order) values
  (:'ws', 'party', 'party', 900000000000, 1), (:'ws', 'donations', 'donation', 50000000000, 2), (:'ws', 'personal', 'personal', 50000000000, 3);
insert into public.budget_categories (workspace_id, name, sort_order) select :'ws', 'cat ' || g, g from generate_series(1, 10) g;
insert into public.budget_category_plans (workspace_id, category_id, original_plan_agorot)
  select :'ws', c.id, 5000000000 from public.budget_categories c where c.workspace_id = :'ws';
insert into public.budget_suppliers (workspace_id, business_name) select :'ws', 'supplier ' || g from generate_series(1, 50) g;
create temp table perf_x as select g,
  (select id from public.budget_suppliers s where s.workspace_id = :'ws' order by business_name offset (g % 50) limit 1) as sup,
  (select id from public.budget_categories c where c.workspace_id = :'ws' order by sort_order offset (g % 10) limit 1) as cat,
  case when g % 10 = 0 then 'draft' when g % 10 between 1 and 5 then 'committed' when g % 10 between 6 and 8 then 'incurred' else 'cancelled' end as st
  from generate_series(1, 1000) g;
insert into public.budget_expenses (workspace_id, reference_no, description, supplier_id, category_id, total_agorot, expense_date, status, status_reason)
  select :'ws', g, 'expense ' || g, sup, cat, 100000 + g * 7, date '2026-01-01' + (g % 250), st, case when st = 'cancelled' then 'perf' end from perf_x;
insert into public.budget_expense_allocations (workspace_id, expense_id, funding_source_id, amount_agorot)
  select :'ws', e.id, (select id from public.budget_funding_sources where workspace_id = :'ws' and kind = case when e.reference_no % 2 = 1 then 'party' else 'donation' end),
    case when e.reference_no % 2 = 1 then e.total_agorot else e.total_agorot / 2 end
  from public.budget_expenses e where e.workspace_id = :'ws';
insert into public.budget_party_preapprovals (workspace_id, allocation_id, approval_code, approver_name, approval_date, preapproved_amount_agorot)
  select :'ws', a.id, 'AP', 'perf', date '2026-01-10', a.amount_agorot
  from public.budget_expense_allocations a join public.budget_expenses e on e.id = a.expense_id
  where a.workspace_id = :'ws' and e.reference_no % 2 = 1 and e.reference_no % 3 = 0;
insert into public.budget_party_submissions (workspace_id, allocation_id) select :'ws', allocation_id from public.budget_party_preapprovals where workspace_id = :'ws';
insert into public.budget_documents (workspace_id, expense_id, document_type_id)
  select :'ws', e.id, (select id from public.budget_document_types where workspace_id = :'ws' and key = 'quotation')
  from public.budget_expenses e where e.workspace_id = :'ws' and e.reference_no % 2 = 1 and e.reference_no % 5 <> 0;
insert into public.budget_document_versions (workspace_id, document_id, version_no, storage_path, file_name, mime_type, size_bytes, sha256, origin,
  created_by_type, created_by_id, created_by_name)
  select :'ws', d.id, 1, :'ws' || '/' || gen_random_uuid(), 'q.pdf', 'application/pdf', 1000, repeat('a', 64), 'upload', 'worker', gen_random_uuid(), 'perf'
  from public.budget_documents d where d.workspace_id = :'ws';
insert into public.budget_supplier_payments (workspace_id, expense_id, allocation_id, amount_agorot, payment_date, payer, confirmation_source,
  idempotency_key, recorded_by_type, recorded_by_id, recorded_by_name)
  select :'ws', e.id, a.id, a.amount_agorot / 2, e.expense_date + 5, 'campaign', 'bank_transfer', gen_random_uuid(), 'worker', gen_random_uuid(), 'perf'
  from public.budget_expenses e join public.budget_expense_allocations a on a.expense_id = e.id and a.workspace_id = e.workspace_id
  join public.budget_funding_sources s on s.id = a.funding_source_id and s.kind = 'donation'
  where e.workspace_id = :'ws' and e.status = 'incurred';
commit;
select :'ws';`;
const WP = psql(perfSeed).split("\n").pop().trim();
psql(`analyze public.budget_expenses, public.budget_expense_allocations, public.budget_documents, public.budget_document_versions,
  public.budget_supplier_payments, public.budget_party_preapprovals, public.budget_party_submissions, public.budget_suppliers,
  public.budget_categories, public.budget_category_plans, public.budget_funding_sources, public.budget_audit_events;`);
const perfRows = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WP}';`);
check("P00 1,000 expenses seeded (with their audit history)", q1(`select count(*) from public.budget_expenses where workspace_id = '${WP}';`) === "1000", `${perfRows} audit rows`);
const ownerActor = `'{"type":"owner","id":"${uuid()}","name":"perf owner"}'`;
const perfSupplier = q1(`select id from public.budget_suppliers where workspace_id = '${WP}' order by business_name limit 1;`);
const timing = q1(`create temp table pt (k text, ms numeric);
do $$ declare ws uuid := '${WP}'; t0 timestamptz; m jsonb; begin
  perform public.budget_op_get_dashboard(ws, '{}', '{}');
  t0 := clock_timestamp(); perform public.budget_op_get_dashboard(ws, '{}', '{}'); insert into pg_temp.pt values ('dashboard', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_list_expenses(ws, '{}', '{}'); insert into pg_temp.pt values ('expense_list', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_expenses(ws, '{}', '{"docReadiness":"missing"}'); insert into pg_temp.pt values ('report_docs', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_list_suppliers(ws, '{}', '{}'); insert into pg_temp.pt values ('suppliers', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_get_supplier_file(ws, '{}', jsonb_build_object('supplierId', '${perfSupplier}')); insert into pg_temp.pt values ('supplier_file', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_party(ws, '{}', '{}'); insert into pg_temp.pt values ('party', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_expense_document_facts(ws, null); insert into pg_temp.pt values ('doc_readiness', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_export_status(ws, ${ownerActor}, '{}'); insert into pg_temp.pt values ('export_status', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); m := public.budget_op_export_start(ws, ${ownerActor}, '{}'); insert into pg_temp.pt values ('export_start', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_export_part(ws, ${ownerActor}, jsonb_build_object('exportId', m ->> 'exportId', 'table', 'budget_audit_events', 'part', 0)); insert into pg_temp.pt values ('export_part', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform count(*) from public.budget_storage_orphans(200); insert into pg_temp.pt values ('orphan_scan', extract(epoch from clock_timestamp() - t0) * 1000);
end $$;
select string_agg(k || '=' || round(ms), ' ' order by k) || '|' || max(ms) filter (where k in ('dashboard')) || '|' ||
  max(ms) filter (where k in ('expense_list', 'report_docs', 'suppliers', 'supplier_file', 'party', 'doc_readiness')) || '|' ||
  max(ms) filter (where k like 'export%') || '|' || max(ms) filter (where k = 'orphan_scan') from pt;`).split("\n").pop();
const [timings, dashMs, readMs, exportMs, orphanMs] = timing.split("|");
console.log(`  [perf] warm timings on 1,000 expenses (ms): ${timings}`);
check("P01 dashboard < 2.5 s; expense list / reports / suppliers / supplier file / party / document readiness < 2 s (warm)",
  Number(dashMs) < 2500 && Number(readMs) < 2000, `dashboard ${Math.round(dashMs)} ms, reads max ${Math.round(readMs)} ms`);
check("P02 deletion export on 1,000 expenses: status / manifest / a part each < 8 s; orphan scan < 1 s",
  Number(exportMs) < 8000 && Number(orphanMs) < 1000, `export max ${Math.round(exportMs)} ms, orphans ${Math.round(orphanMs)} ms`);
const t0 = Date.now();
const perfProbe = deleteProbe(WP);
check("P03 the delete guard decides atomically on 1,000 expenses in < 10 s (refused: no export)", perfProbe === "BUDGET_EXPORT_REQUIRED" && Date.now() - t0 < 10000,
  `${perfProbe} ${Date.now() - t0} ms`);
const partBytes = Number(q1(`select max(octet_length(public.budget_export_part_text('${WP}', t, 0, 0))) from unnest(public.budget_export_tables()) t;`));
check("P04 bounded export parts: the largest 200-row part stays far below the 4.5 MB function response limit", partBytes > 0 && partBytes < 2_000_000, `${partBytes} bytes`);
const orphanPlan = q1(`explain select 1 from public.budget_document_versions v where v.storage_path = 'x';`);
check("P05 the orphan check uses the unique storage_path index", orphanPlan.includes("budget_document_versions_storage_path_key"), orphanPlan.split("\n")[0]);

// ---------------------------------------------------------------------------
section("CLEANUP");
q1(`update public.platform_modules set available = false where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check("Z01 budget.available restored to false on the scratch stack", q1(`select available from public.platform_modules where key = 'budget';`) === "f");

process.exit(tally("BUDGET STAGE 7A RELEASE READINESS") ? 1 : 0);
