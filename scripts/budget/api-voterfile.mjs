// Budget Stage 3 - Phase 3A gate: the voter-file HTTP contract regression
// suite. It pins the public contract of BOTH
//   POST /api/election-day/import-voters
//   POST /api/election-day/clear-voters
// and must produce identical results before and after clear-voters.ts is
// folded into import-voters.ts.
//
// Every request goes through vercel.json's OWN rewrite table (the same
// emulation scripts/stage5/localServer.mjs uses) to the REAL bundled handlers,
// so after the consolidation the public clear-voters URL is exercised through
// its server-side rewrite exactly as the browser would reach it.
//
// Real Postgres + the real session / reauth handlers on the isolated kolboxs5
// scratch stack (loadStack() refuses anything else). Synthetic data only; no
// password, cookie or proof is ever printed.
//
// Run:  S5_STACK_DIR=<scratch>/s9stack node scripts/budget/api-voterfile.mjs [--record <file>] [--compare <file>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { callHandler, check, installLocalnetGuard, loadStack, psql, section, tally } from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const H = await buildHandlers();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rewrites = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8")).rewrites;
// Same rule as localServer.mjs: exact-source match, destination path +
// destination query, the caller's own query appended.
function applyRewrite(pathname, search) {
  for (const r of rewrites) {
    if (r.source === "/(.*)") continue;
    if (r.source === pathname) {
      const dest = new URL(r.destination, "http://x");
      for (const [k, v] of new URLSearchParams(search)) dest.searchParams.append(k, v);
      return `${dest.pathname}${dest.search}`;
    }
  }
  return `${pathname}${search}`;
}
const HANDLER_BY_PATH = {
  "/api/election-day/import-voters": H.importVoters,
  "/api/election-day/clear-voters": H.clearVoters, // undefined once folded in
  "/api/election-day/session": H.electionSession,
  "/api/election-day/reauth": H.reauth,
};
/** Calls a PUBLIC path the way a deployment would route it. */
async function callPublic(publicUrl, { method = "POST", headers = {}, body, cookies } = {}) {
  const u = new URL(publicUrl, "http://x");
  const routed = applyRewrite(u.pathname, u.search);
  const handler = HANDLER_BY_PATH[routed.split("?")[0]];
  if (!handler) return { statusCode: 404, body: { error: "NOT_FOUND" }, routed };
  const r = await callHandler(handler, { method, url: routed, headers, body, cookies });
  return { ...r, routed };
}

const argv = process.argv.slice(2);
const recordPath = argv.includes("--record") ? argv[argv.indexOf("--record") + 1] : null;
const comparePath = argv.includes("--compare") ? argv[argv.indexOf("--compare") + 1] : null;
const observed = {};
/** Records one normalized observation (status + body) under a stable id. */
function observe(id, r) {
  observed[id] = { status: r.statusCode, body: r.body ?? null };
}

const COOKIE = "__Host-kb_ed_session";
const PREFIX = "VFREG";
const resetRateLimits = () => psql("delete from public.election_day_login_attempts;");
const cookieFrom = (r) => {
  const sc = r.headers?.["set-cookie"];
  return typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
};
const voterCount = (ws) =>
  Number(psql(`select count(*) from public.election_day_voters where workspace_id = '${ws}';`));

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
const PW = "Vf-Reg-Pw-1!";
psql(`
  delete from public.election_workspaces where name like '${PREFIX} %';
  do $$
  declare
    v_ws uuid;
    v_full uuid;
    v_none uuid;
  begin
    insert into public.election_workspaces (name, election_end_at, login_code)
    values ('${PREFIX} ws', now() + interval '30 days', 'VFRGQQQQ') returning id into v_ws;
    insert into public.election_workspace_modules (workspace_id, module_key) values (v_ws, 'election_day');
    insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
      values ('${PREFIX} full', '', array['electionDay.import','electionDay.clearData'], 'all', v_ws, false)
      returning id into v_full;
    insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
      values ('${PREFIX} none', '', array['voter.viewName'], 'all', v_ws, false)
      returning id into v_none;
    insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
      values ('vf-full', extensions.crypt('${PW}', extensions.gen_salt('bf')), v_full, v_ws),
             ('vf-none', extensions.crypt('${PW}', extensions.gen_salt('bf')), v_none, v_ws);
  end $$;
`);
const WS = psql(`select id from public.election_workspaces where name = '${PREFIX} ws';`);
check("S0 fixture workspace created", /^[0-9a-f-]{36}$/.test(WS));

async function login(name) {
  resetRateLimits();
  const r = await callPublic("/api/election-day/session", {
    headers: { origin: ORIGIN },
    body: { workspaceCode: "VFRGQQQQ", name, password: PW },
  });
  return cookieFrom(r);
}
async function proof(cookie, action) {
  resetRateLimits();
  const r = await callPublic("/api/election-day/reauth", {
    headers: { origin: ORIGIN },
    body: { password: PW, action },
    cookies: { [COOKIE]: cookie },
  });
  return r.body?.reauthProof ?? "";
}
const FULL = await login("vf-full");
const NONE = await login("vf-none");
check("S1 both fixture users logged in", Boolean(FULL && NONE));

// Coordinator-less rows for the basic path; I16 below names a coordinator to
// exercise the coordinator sync (fixed by hotfix migration 20260916010000).
const VOTERS = [
  { masad: "1", first_name: "א", last_name: "ב", street: "ר", house_number: 1, city: "ע", phone: null, coordinator: null },
  { masad: "2", first_name: "ג", last_name: "ד", street: "ר", house_number: 2, city: "ע", phone: null, coordinator: null },
];

// ---------------------------------------------------------------------------
section("IMPORT - public contract");
const IMP = "/api/election-day/import-voters";
observe("I01 GET", await callPublic(IMP, { method: "GET" }));
observe("I02 PUT", await callPublic(IMP, { method: "PUT", headers: { origin: ORIGIN } }));
observe("I03 no origin", await callPublic(IMP, { body: {} }));
observe("I04 bad origin", await callPublic(IMP, { headers: { origin: "https://evil.example" }, body: {} }));
observe("I05 unknown body key", await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: [], extra: 1 } }));
observe("I06 missing proof", await callPublic(IMP, { headers: { origin: ORIGIN }, body: { voters: [] } }));
observe("I07 missing voters", await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof: "x" } }));
observe("I08 voters not array", await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: "no" } }));
observe("I09 no cookie", await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: [] } }));
observe("I10 forged cookie", await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: [] }, cookies: { [COOKIE]: "f".repeat(64) },
}));
const clearProofOnImport = await proof(FULL, "clear_voters");
observe("I11 clear-bound proof on import", await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: clearProofOnImport, voters: VOTERS }, cookies: { [COOKIE]: FULL },
}));
const impProof = await proof(FULL, "import_voters");
const impOk = await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: impProof, voters: VOTERS }, cookies: { [COOKIE]: FULL },
});
observe("I12 valid import", impOk);
observe("I12b voters after import", { statusCode: "DB", body: { count: voterCount(WS) } });
observe("I13 replayed import proof", await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: impProof, voters: VOTERS }, cookies: { [COOKIE]: FULL },
}));
const impProofNone = await proof(NONE, "import_voters");
observe("I14 no electionDay.import", await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: impProofNone, voters: VOTERS }, cookies: { [COOKIE]: NONE },
}));
// An import naming a not-yet-registered coordinator runs the coordinator sync
// (its ON CONFLICT target now matches the per-workspace index - hotfix
// migration 20260916010000). It replaces the 2 rows above with 2 rows, which
// the clear checks below rely on.
const impProofCoord = await proof(FULL, "import_voters");
observe("I16 import naming a new coordinator", await callPublic(IMP, {
  headers: { origin: ORIGIN },
  body: { reauthProof: impProofCoord, voters: VOTERS.map((v) => ({ ...v, coordinator: "רכז חדש" })) },
  cookies: { [COOKIE]: FULL },
}));
observe("I16b voters after the coordinator import", { statusCode: "DB", body: { count: voterCount(WS) } });
const newCoordinatorRows = psql(
  `select count(*) from public.election_day_coordinators where workspace_id = '${WS}' and display_name = 'רכז חדש' and status = 'active';`,
);

// ---------------------------------------------------------------------------
section("CLEAR - public contract");
const CLR = "/api/election-day/clear-voters";
observe("C01 GET", await callPublic(CLR, { method: "GET" }));
observe("C02 PUT", await callPublic(CLR, { method: "PUT", headers: { origin: ORIGIN } }));
observe("C03 DELETE", await callPublic(CLR, { method: "DELETE", headers: { origin: ORIGIN } }));
observe("C04 no origin", await callPublic(CLR, { body: {} }));
observe("C05 bad origin", await callPublic(CLR, { headers: { origin: "https://evil.example" }, body: {} }));
observe("C06 extra body key (voters)", await callPublic(CLR, { headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: [] } }));
observe("C07 missing proof", await callPublic(CLR, { headers: { origin: ORIGIN }, body: {} }));
observe("C08 empty proof", await callPublic(CLR, { headers: { origin: ORIGIN }, body: { reauthProof: "" } }));
observe("C09 non-string proof", await callPublic(CLR, { headers: { origin: ORIGIN }, body: { reauthProof: 5 } }));
observe("C10 no cookie", await callPublic(CLR, { headers: { origin: ORIGIN }, body: { reauthProof: "x" } }));
observe("C11 forged cookie", await callPublic(CLR, {
  headers: { origin: ORIGIN }, body: { reauthProof: "x" }, cookies: { [COOKIE]: "f".repeat(64) },
}));
const importProofOnClear = await proof(FULL, "import_voters");
observe("C12 import-bound proof on clear", await callPublic(CLR, {
  headers: { origin: ORIGIN }, body: { reauthProof: importProofOnClear }, cookies: { [COOKIE]: FULL },
}));
observe("C12b voters untouched", { statusCode: "DB", body: { count: voterCount(WS) } });
const clrProofNone = await proof(NONE, "clear_voters");
observe("C13 no electionDay.clearData", await callPublic(CLR, {
  headers: { origin: ORIGIN }, body: { reauthProof: clrProofNone }, cookies: { [COOKIE]: NONE },
}));
observe("C13b voters untouched", { statusCode: "DB", body: { count: voterCount(WS) } });
// A caller-supplied query parameter on the PUBLIC clear URL never changes
// what the request does.
const clrProof = await proof(FULL, "clear_voters");
const clrOk = await callPublic(`${CLR}?__vf_op=import&op=x`, {
  headers: { origin: ORIGIN }, body: { reauthProof: clrProof }, cookies: { [COOKIE]: FULL },
});
observe("C14 valid clear (with a hostile query string)", clrOk);
observe("C14b voters after clear", { statusCode: "DB", body: { count: voterCount(WS) } });
observe("C15 replayed clear proof", await callPublic(CLR, {
  headers: { origin: ORIGIN }, body: { reauthProof: clrProof }, cookies: { [COOKIE]: FULL },
}));
// Entitlement revoked after login: the session no longer resolves.
psql(`delete from public.election_workspace_modules where workspace_id = '${WS}' and module_key = 'election_day';`);
observe("C16 clear after entitlement revoked", await callPublic(CLR, {
  headers: { origin: ORIGIN }, body: { reauthProof: "x" }, cookies: { [COOKIE]: FULL },
}));
observe("I15 import after entitlement revoked", await callPublic(IMP, {
  headers: { origin: ORIGIN }, body: { reauthProof: "x", voters: VOTERS }, cookies: { [COOKIE]: FULL },
}));
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WS}', 'election_day');`);

// ---------------------------------------------------------------------------
section("EXPECTED CONTRACT (absolute, independent of the golden file)");
const exp = {
  "I01 GET": [405, "METHOD_NOT_ALLOWED"], "I02 PUT": [405, "METHOD_NOT_ALLOWED"],
  "I03 no origin": [403, "FORBIDDEN_ORIGIN"], "I04 bad origin": [403, "FORBIDDEN_ORIGIN"],
  "I05 unknown body key": [400, "INVALID_REQUEST"], "I06 missing proof": [400, "INVALID_REQUEST"],
  "I07 missing voters": [400, "INVALID_REQUEST"], "I08 voters not array": [400, "INVALID_REQUEST"],
  "I09 no cookie": [401, "UNAUTHORIZED"], "I10 forged cookie": [401, "UNAUTHORIZED"],
  "I11 clear-bound proof on import": [401, "UNAUTHORIZED"], "I13 replayed import proof": [401, "UNAUTHORIZED"],
  "I14 no electionDay.import": [403, "FORBIDDEN"], "I15 import after entitlement revoked": [401, "UNAUTHORIZED"],
  "C01 GET": [405, "METHOD_NOT_ALLOWED"], "C02 PUT": [405, "METHOD_NOT_ALLOWED"], "C03 DELETE": [405, "METHOD_NOT_ALLOWED"],
  "C04 no origin": [403, "FORBIDDEN_ORIGIN"], "C05 bad origin": [403, "FORBIDDEN_ORIGIN"],
  "C06 extra body key (voters)": [400, "INVALID_REQUEST"], "C07 missing proof": [400, "INVALID_REQUEST"],
  "C08 empty proof": [400, "INVALID_REQUEST"], "C09 non-string proof": [400, "INVALID_REQUEST"],
  "C10 no cookie": [401, "UNAUTHORIZED"], "C11 forged cookie": [401, "UNAUTHORIZED"],
  "C12 import-bound proof on clear": [401, "UNAUTHORIZED"], "C13 no electionDay.clearData": [403, "FORBIDDEN"],
  "C15 replayed clear proof": [401, "UNAUTHORIZED"], "C16 clear after entitlement revoked": [401, "UNAUTHORIZED"],
};
for (const [id, [status, code]] of Object.entries(exp)) {
  const o = observed[id];
  check(id, o && o.status === status && o.body?.error === code, `${o?.status} ${o?.body?.error ?? ""}`);
}
// Trusted import works (hotfix 20260916010000): an authorized import stores
// its rows and consumes its proof (I13 above: a replay is 401).
check("I12 authorized import -> 200 {count:2}",
  observed["I12 valid import"].status === 200 && observed["I12 valid import"].body?.count === 2,
  JSON.stringify(observed["I12 valid import"]));
check("I12b two voters stored", observed["I12b voters after import"].body.count === 2);
check("I16 import naming a new coordinator -> 200 {count:2}",
  observed["I16 import naming a new coordinator"].status === 200 &&
    observed["I16 import naming a new coordinator"].body?.count === 2,
  JSON.stringify(observed["I16 import naming a new coordinator"]));
check("I16b voters replaced, not appended (still 2)", observed["I16b voters after the coordinator import"].body.count === 2);
check("I16c new coordinator synced exactly once", newCoordinatorRows === "1", newCoordinatorRows);
check("C12b wrong-action proof left voters untouched", observed["C12b voters untouched"].body.count === 2);
check("C13b forbidden clear left voters untouched", observed["C13b voters untouched"].body.count === 2);
check("C14 valid clear -> 200 {ok:true}", observed["C14 valid clear (with a hostile query string)"].status === 200 &&
  observed["C14 valid clear (with a hostile query string)"].body?.ok === true &&
  Object.keys(observed["C14 valid clear (with a hostile query string)"].body).length === 1);
check("C14b voters cleared", observed["C14b voters after clear"].body.count === 0);

// ---------------------------------------------------------------------------
if (recordPath) {
  fs.writeFileSync(recordPath, JSON.stringify(observed, null, 2));
  console.log(`\nrecorded ${Object.keys(observed).length} observations`);
}
if (comparePath) {
  section("BEFORE / AFTER COMPARISON (golden file)");
  const golden = JSON.parse(fs.readFileSync(comparePath, "utf8"));
  const ids = new Set([...Object.keys(golden), ...Object.keys(observed)]);
  for (const id of ids) {
    check(`same as before: ${id}`, JSON.stringify(golden[id]) === JSON.stringify(observed[id]),
      JSON.stringify(golden[id]) === JSON.stringify(observed[id]) ? "" : `before ${JSON.stringify(golden[id])} after ${JSON.stringify(observed[id])}`);
  }
}

psql(`delete from public.election_workspaces where name like '${PREFIX} %';`);
process.exit(tally("VOTER-FILE CONTRACT") ? 1 : 0);
