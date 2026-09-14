// Election Day hotfix - retained regression suite for the trusted voter
// import (POST /api/election-day/import-voters) and its sibling clear
// (POST /api/election-day/clear-voters), after migration 20260916010000
// restored the coordinator sync's ON CONFLICT target.
//
// Every request goes through vercel.json's OWN rewrite table to the REAL
// bundled handlers (same emulation as scripts/stage5/localServer.mjs), so the
// suite is branch-agnostic: it exercises clear-voters.ts directly where that
// file exists, or its server-side rewrite where it has been folded into
// import-voters.ts. Handlers are bundled here (not via buildHandlers.mjs) so
// this suite adds no shared-harness change.
//
// Real Postgres + the real session / reauth handlers on the isolated kolboxs5
// scratch stack only (loadStack() refuses anything else; installLocalnetGuard()
// blocks non-local hosts). Synthetic data only; no password, cookie or proof
// is ever printed.
//
// Run:  S5_PORT_OFFSET=1000 S5_STACK_DIR=<scratch stack dir> node scripts/voter-import/api-voter-import.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { callHandler, check, installLocalnetGuard, loadStack, psql, section, tally } from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- real handlers, bundled byte-for-byte -----------------------------------
const ENTRIES = {
  importVoters: "api/election-day/import-voters.ts",
  clearVoters: "api/election-day/clear-voters.ts", // absent once folded into import-voters.ts
  electionSession: "api/election-day/session.ts",
  reauth: "api/election-day/reauth.ts",
};
const H = {};
{
  const require = createRequire(import.meta.url);
  const outDir = path.join(os.tmpdir(), "kolbox-voter-import-handlers");
  for (const [key, entry] of Object.entries(ENTRIES)) {
    const src = path.join(repoRoot, entry);
    if (!fs.existsSync(src)) continue;
    const outfile = path.join(outDir, `${key}.cjs`);
    await build({ entryPoints: [src], outfile, bundle: true, platform: "node", format: "cjs", target: "node20", logLevel: "error" });
    delete require.cache[outfile];
    const mod = require(outfile);
    H[key] = mod.default ?? mod;
  }
}

const rewrites = JSON.parse(fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8")).rewrites;
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
  "/api/election-day/clear-voters": H.clearVoters,
  "/api/election-day/session": H.electionSession,
  "/api/election-day/reauth": H.reauth,
};
async function callPublic(publicUrl, { method = "POST", headers = {}, body, cookies } = {}) {
  const u = new URL(publicUrl, "http://x");
  const routed = applyRewrite(u.pathname, u.search);
  const handler = HANDLER_BY_PATH[routed.split("?")[0]];
  if (!handler) return { statusCode: 404, body: { error: "NOT_FOUND" } };
  return callHandler(handler, { method, url: routed, headers, body, cookies });
}
const is = (r, status, code) => r.statusCode === status && (code === undefined || r.body?.error === code);
const got = (r) => `${r.statusCode} ${r.body?.error ?? JSON.stringify(r.body ?? null)}`;

// ---- fixtures ---------------------------------------------------------------
const COOKIE = "__Host-kb_ed_session";
const PREFIX = "VIMP";
const PW = "Vimp-Reg-Pw-1!";
const IMP = "/api/election-day/import-voters";
const CLR = "/api/election-day/clear-voters";
const q = (s) => s.replace(/'/g, "''");
const resetRateLimits = () => psql("delete from public.election_day_login_attempts;");
const cookieFrom = (r) => {
  const sc = r.headers?.["set-cookie"];
  return typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
};
const voterCount = (ws) => Number(psql(`select count(*) from public.election_day_voters where workspace_id = '${ws}';`));
const voterPrint = (ws) =>
  psql(`select md5(coalesce(string_agg(first_name || '|' || last_name || '|' || coalesce(coordinator, '') || '|' || house_number, ',' order by first_name, last_name), '')) from public.election_day_voters where workspace_id = '${ws}';`);
const voterNames = (ws) =>
  psql(`select coalesce(string_agg(first_name, ',' order by first_name), '') from public.election_day_voters where workspace_id = '${ws}';`);
const activeCoords = (ws) =>
  psql(`select coalesce(string_agg(display_name, ',' order by display_name), '') from public.election_day_coordinators where workspace_id = '${ws}' and status = 'active';`);
const coordPrint = (ws) =>
  psql(`select md5(coalesce(string_agg(id::text || display_name || status || coalesce(linked_assignment_name, ''), ',' order by id), '')) from public.election_day_coordinators where workspace_id = '${ws}';`);

section("SETUP (scratch stack only)");
psql(`delete from public.election_workspaces where name like '${PREFIX} %';`);
const mkWorkspace = (label, code) =>
  psql(`
    insert into public.election_workspaces (name, election_end_at, login_code)
    values ('${PREFIX} ${label}', now() + interval '30 days', '${code}') returning id;
  `).split("\n")[0];
const WS_A = mkWorkspace("A", "VMPTAAAA");
const WS_B = mkWorkspace("B", "VMPTBBBB");
const WS_C = mkWorkspace("C", "VMPTCCCC");
for (const ws of [WS_A, WS_B, WS_C]) {
  psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${ws}', 'election_day');`);
}
function mkUser(ws, name, permissions) {
  psql(`
    with r as (
      insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
      values ('${PREFIX} ${name}', '', array[${permissions.map((p) => `'${p}'`).join(",")}]::text[], 'all', '${ws}', false)
      returning id
    )
    insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
    select '${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), r.id, '${ws}' from r;
  `);
}
mkUser(WS_A, "a-full", ["electionDay.import", "electionDay.clearData"]);
mkUser(WS_A, "a-none", ["voter.viewName"]);
mkUser(WS_B, "b-full", ["electionDay.import", "electionDay.clearData"]);
mkUser(WS_C, "c-full", ["electionDay.import", "electionDay.clearData"]);
check("S0 three fixture workspaces created", [WS_A, WS_B, WS_C].every((w) => /^[0-9a-f-]{36}$/.test(w)));

async function login(code, name) {
  resetRateLimits();
  const r = await callPublic("/api/election-day/session", {
    headers: { origin: ORIGIN },
    body: { workspaceCode: code, name, password: PW },
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
async function importAs(cookie, voters) {
  const reauthProof = await proof(cookie, "import_voters");
  const r = await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof, voters }, cookies: { [COOKIE]: cookie } });
  return { r, reauthProof };
}
const A_FULL = await login("VMPTAAAA", "a-full");
const A_NONE = await login("VMPTAAAA", "a-none");
const B_FULL = await login("VMPTBBBB", "b-full");
const C_FULL = await login("VMPTCCCC", "c-full");
check("S1 all fixture users logged in (valid session)", Boolean(A_FULL && A_NONE && B_FULL && C_FULL));

const row = (first, coordinator, house = 1) => ({
  masad: "1", first_name: first, last_name: "בדיקה", street: "הרצל", house_number: house, city: "עיר", phone: null, coordinator,
});
// F1: a duplicated coordinator, one padded with spaces, one blank, one null.
const F1 = [row("אבי", "רכז א"), row("בני", "רכז א"), row("גדי", "  רכז ב  "), row("דני", ""), row("הדס", null)];
const F2 = [row("ורד", "רכז ג"), row("זיו", "רכז א"), row("חן", null)];

// ---------------------------------------------------------------------------
section("IMPORT - public contract (unchanged)");
{
  const x = { headers: { origin: ORIGIN } };
  const cases = [
    ["V01 GET -> 405", await callPublic(IMP, { method: "GET" }), 405, "METHOD_NOT_ALLOWED"],
    ["V02 PUT -> 405", await callPublic(IMP, { method: "PUT", ...x }), 405, "METHOD_NOT_ALLOWED"],
    ["V03 no origin -> 403", await callPublic(IMP, { body: {} }), 403, "FORBIDDEN_ORIGIN"],
    ["V04 bad origin -> 403", await callPublic(IMP, { headers: { origin: "https://evil.example" }, body: {} }), 403, "FORBIDDEN_ORIGIN"],
    ["V05 unknown body key -> 400", await callPublic(IMP, { ...x, body: { reauthProof: "x", voters: [], extra: 1 } }), 400, "INVALID_REQUEST"],
    ["V06 missing proof -> 400", await callPublic(IMP, { ...x, body: { voters: [] } }), 400, "INVALID_REQUEST"],
    ["V07 missing voters -> 400", await callPublic(IMP, { ...x, body: { reauthProof: "x" } }), 400, "INVALID_REQUEST"],
    ["V08 voters not an array -> 400", await callPublic(IMP, { ...x, body: { reauthProof: "x", voters: "no" } }), 400, "INVALID_REQUEST"],
    ["V09 no cookie -> 401", await callPublic(IMP, { ...x, body: { reauthProof: "x", voters: [] } }), 401, "UNAUTHORIZED"],
    ["V10 forged cookie -> 401", await callPublic(IMP, { ...x, body: { reauthProof: "x", voters: [] }, cookies: { [COOKIE]: "f".repeat(64) } }), 401, "UNAUTHORIZED"],
  ];
  for (const [id, r, s, c] of cases) check(id, is(r, s, c), got(r));
  const clearBound = await proof(A_FULL, "clear_voters");
  const r11 = await callPublic(IMP, { ...x, body: { reauthProof: clearBound, voters: F1 }, cookies: { [COOKIE]: A_FULL } });
  check("V11 clear-bound proof on import -> 401", is(r11, 401, "UNAUTHORIZED"), got(r11));
  const { r: r12 } = await importAs(A_NONE, F1);
  check("V12 role without electionDay.import -> 403", is(r12, 403, "FORBIDDEN"), got(r12));
  check("V12b nothing imported by the refused calls", voterCount(WS_A) === 0);
}

// ---------------------------------------------------------------------------
section("IMPORT - behaviour restored by 20260916010000");
{
  const { r, reauthProof } = await importAs(A_FULL, F1);
  check("T01 first import into an empty workspace -> 200 {count:5}", r.statusCode === 200 && r.body?.count === 5, got(r));
  check("T01b five voters stored", voterCount(WS_A) === 5, String(voterCount(WS_A)));
  check("T01c coordinators synced: duplicates collapsed, padding trimmed, blank/null skipped",
    activeCoords(WS_A) === "רכז א,רכז ב", activeCoords(WS_A));
  const replay = await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof, voters: F1 }, cookies: { [COOKIE]: A_FULL } });
  check("T02 replaying a consumed import proof -> 401", is(replay, 401, "UNAUTHORIZED"), got(replay));

  const coordsBefore = coordPrint(WS_A);
  const { r: r3 } = await importAs(A_FULL, F1);
  check("T03 repeated import of the same file -> 200 {count:5}", r3.statusCode === 200 && r3.body?.count === 5, got(r3));
  check("T03b voters replaced, not appended (still 5)", voterCount(WS_A) === 5, String(voterCount(WS_A)));
  check("T03c no duplicate coordinators (rows byte-identical)", coordPrint(WS_A) === coordsBefore);

  const { r: r4 } = await importAs(A_FULL, F2);
  check("T04 replacement import -> 200 {count:3}", r4.statusCode === 200 && r4.body?.count === 3, got(r4));
  const sameSet = (csv, names) => JSON.stringify(csv.split(",").sort()) === JSON.stringify([...names].sort());
  check("T04b only the new file's voters remain", sameSet(voterNames(WS_A), F2.map((v) => v.first_name)), voterNames(WS_A));
  check("T04c new coordinator added, existing kept, none duplicated", activeCoords(WS_A) === "רכז א,רכז ב,רכז ג", activeCoords(WS_A));

  // Same-workspace de-duplication also honours linked_assignment_name and
  // non-active rows (unchanged semantics).
  psql(`
    insert into public.election_day_coordinators (display_name, linked_assignment_name, workspace_id)
      values ('מקושר', 'שם מהקובץ', '${WS_A}');
    insert into public.election_day_coordinators (display_name, status, ended_at, workspace_id)
      values ('רכז שהסתיים', 'ended', now(), '${WS_A}');
  `);
  const { r: r5 } = await importAs(A_FULL, [row("טל", "שם מהקובץ"), row("יעל", "רכז שהסתיים")]);
  check("T05 import naming a linked / an ended coordinator -> 200", r5.statusCode === 200 && r5.body?.count === 2, got(r5));
  check("T05b no coordinator created for a linked_assignment_name match",
    psql(`select count(*) from public.election_day_coordinators where workspace_id = '${WS_A}' and display_name = 'שם מהקובץ';`) === "0");
  check("T05c no coordinator created for an ended same-name coordinator",
    psql(`select count(*) from public.election_day_coordinators where workspace_id = '${WS_A}' and display_name = 'רכז שהסתיים';`) === "1");
}

// ---------------------------------------------------------------------------
section("CROSS-WORKSPACE + ISOLATION");
{
  const aVoters = voterPrint(WS_A);
  const aCoords = coordPrint(WS_A);
  const { r } = await importAs(B_FULL, F1);
  check("T06 same coordinator names imported into workspace B -> 200 {count:5}", r.statusCode === 200 && r.body?.count === 5, got(r));
  check("T06b B has its own active coordinators", activeCoords(WS_B) === "רכז א,רכז ב", activeCoords(WS_B));
  check("T06c one active 'רכז א' per workspace (2 in total)",
    psql(`select count(*) || '/' || count(distinct workspace_id) from public.election_day_coordinators where display_name = 'רכז א' and status = 'active' and workspace_id in ('${WS_A}', '${WS_B}');`) === "2/2");
  check("T07 workspace A voters untouched by B's import", voterPrint(WS_A) === aVoters);
  check("T07b workspace A coordinators untouched by B's import", coordPrint(WS_A) === aCoords);

  // A proof minted by B's user is bound to B's actor/workspace.
  const bProof = await proof(B_FULL, "import_voters");
  const cross = await callPublic(IMP, { headers: { origin: ORIGIN }, body: { reauthProof: bProof, voters: F2 }, cookies: { [COOKIE]: A_FULL } });
  check("T08 another workspace's proof on A's session -> 401", is(cross, 401, "UNAUTHORIZED"), got(cross));
  check("T08b workspace A unchanged", voterPrint(WS_A) === aVoters && coordPrint(WS_A) === aCoords);

  const bCoords = coordPrint(WS_B);
  const { r: e } = await importAs(B_FULL, []);
  check("T09 empty file -> 200 {count:0}", e.statusCode === 200 && e.body?.count === 0, got(e));
  check("T09b empty import replaces B's voters with none", voterCount(WS_B) === 0);
  check("T09c empty import leaves coordinators unchanged", coordPrint(WS_B) === bCoords);
  check("T09d workspace A unchanged by B's empty import", voterPrint(WS_A) === aVoters && coordPrint(WS_A) === aCoords);
}

// ---------------------------------------------------------------------------
section("ATOMICITY / DATA INTEGRITY");
{
  const aVoters = voterPrint(WS_A);
  const aCoords = coordPrint(WS_A);
  const bad = [row("כרמל", "רכז אטומי"), { ...row("לאה", null), house_number: "abc" }];
  const { r } = await importAs(A_FULL, bad);
  check("T10 a file with an invalid row -> 500 SERVER_ERROR", is(r, 500, "SERVER_ERROR"), got(r));
  check("T10b failed import is atomic: A's voters unchanged (clear rolled back)", voterPrint(WS_A) === aVoters);
  check("T10c failed import is atomic: no coordinator from the bad file", coordPrint(WS_A) === aCoords);

  psql(`
    insert into public.election_day_voters (masad, first_name, last_name, street, house_number, city, phone, coordinator, workspace_id)
      values ('1', 'קיים', 'בדיקה', 'הרצל', 1, 'עיר', null, null, '${WS_C}');
    insert into public.election_day_coordinator_operations (operation_type, executed_by_name_snapshot, workspace_id)
      values ('rebalance', '${PREFIX} op', '${WS_C}');
  `);
  const { r: locked } = await importAs(C_FULL, F1);
  check("T11 allocation activity started -> 409 ALLOCATION_ACTIVITY_STARTED", is(locked, 409, "ALLOCATION_ACTIVITY_STARTED"), got(locked));
  check("T11b voters kept when the import is refused", voterNames(WS_C) === "קיים", voterNames(WS_C));

  // Self-contained: seed one active coordinator, then try a second active
  // row with the same name in the same workspace.
  const dup = psql(`
    create function pg_temp.try_dup() returns text language plpgsql as $f$
    begin
      insert into public.election_day_coordinators (display_name, workspace_id) values ('רכז כפול', '${WS_A}');
      begin
        insert into public.election_day_coordinators (display_name, workspace_id) values ('רכז כפול', '${WS_A}');
        return 'inserted';
      exception when unique_violation then
        return 'unique_violation';
      end;
    end $f$;
    select pg_temp.try_dup();
  `);
  check("T12 a second ACTIVE coordinator with the same name in one workspace is still refused", dup === "unique_violation", dup);
}

// ---------------------------------------------------------------------------
section("CLEAR - public contract (unchanged)");
{
  const x = { headers: { origin: ORIGIN } };
  const cases = [
    ["C01 GET -> 405", await callPublic(CLR, { method: "GET" }), 405, "METHOD_NOT_ALLOWED"],
    ["C02 PUT -> 405", await callPublic(CLR, { method: "PUT", ...x }), 405, "METHOD_NOT_ALLOWED"],
    ["C03 DELETE -> 405", await callPublic(CLR, { method: "DELETE", ...x }), 405, "METHOD_NOT_ALLOWED"],
    ["C04 no origin -> 403", await callPublic(CLR, { body: {} }), 403, "FORBIDDEN_ORIGIN"],
    ["C05 bad origin -> 403", await callPublic(CLR, { headers: { origin: "https://evil.example" }, body: {} }), 403, "FORBIDDEN_ORIGIN"],
    ["C06 extra body key -> 400", await callPublic(CLR, { ...x, body: { reauthProof: "x", voters: [] } }), 400, "INVALID_REQUEST"],
    ["C07 missing proof -> 400", await callPublic(CLR, { ...x, body: {} }), 400, "INVALID_REQUEST"],
    ["C08 empty proof -> 400", await callPublic(CLR, { ...x, body: { reauthProof: "" } }), 400, "INVALID_REQUEST"],
    ["C09 non-string proof -> 400", await callPublic(CLR, { ...x, body: { reauthProof: 5 } }), 400, "INVALID_REQUEST"],
    ["C10 no cookie -> 401", await callPublic(CLR, { ...x, body: { reauthProof: "x" } }), 401, "UNAUTHORIZED"],
    ["C11 forged cookie -> 401", await callPublic(CLR, { ...x, body: { reauthProof: "x" }, cookies: { [COOKIE]: "f".repeat(64) } }), 401, "UNAUTHORIZED"],
  ];
  for (const [id, r, s, c] of cases) check(id, is(r, s, c), got(r));

  const aVoters = voterPrint(WS_A);
  const importBound = await proof(A_FULL, "import_voters");
  const c12 = await callPublic(CLR, { ...x, body: { reauthProof: importBound }, cookies: { [COOKIE]: A_FULL } });
  check("C12 import-bound proof on clear -> 401, voters untouched", is(c12, 401, "UNAUTHORIZED") && voterPrint(WS_A) === aVoters, got(c12));
  const noneProof = await proof(A_NONE, "clear_voters");
  const c13 = await callPublic(CLR, { ...x, body: { reauthProof: noneProof }, cookies: { [COOKIE]: A_NONE } });
  check("C13 role without electionDay.clearData -> 403, voters untouched", is(c13, 403, "FORBIDDEN") && voterPrint(WS_A) === aVoters, got(c13));

  const cVoters = voterPrint(WS_C);
  const aCoords = coordPrint(WS_A);
  const clrProof = await proof(A_FULL, "clear_voters");
  const c14 = await callPublic(CLR, { ...x, body: { reauthProof: clrProof }, cookies: { [COOKIE]: A_FULL } });
  check("C14 valid clear -> 200 exactly {ok:true}",
    c14.statusCode === 200 && c14.body?.ok === true && Object.keys(c14.body ?? {}).length === 1, got(c14));
  check("C14b workspace A voters cleared", voterCount(WS_A) === 0);
  check("C14c clear never touches coordinators", coordPrint(WS_A) === aCoords);
  check("C14d another workspace's voters untouched by A's clear", voterPrint(WS_C) === cVoters);
  const c15 = await callPublic(CLR, { ...x, body: { reauthProof: clrProof }, cookies: { [COOKIE]: A_FULL } });
  check("C15 replayed clear proof -> 401", is(c15, 401, "UNAUTHORIZED"), got(c15));

  const { r: again } = await importAs(A_FULL, F2);
  check("T13 import after a clear -> 200 {count:3}", again.statusCode === 200 && again.body?.count === 3, got(again));

  psql(`delete from public.election_workspace_modules where workspace_id = '${WS_A}' and module_key = 'election_day';`);
  const c16 = await callPublic(CLR, { ...x, body: { reauthProof: "x" }, cookies: { [COOKIE]: A_FULL } });
  check("C16 clear after the entitlement is revoked -> 401", is(c16, 401, "UNAUTHORIZED"), got(c16));
  const i16 = await callPublic(IMP, { ...x, body: { reauthProof: "x", voters: F1 }, cookies: { [COOKIE]: A_FULL } });
  check("T14 import after the entitlement is revoked -> 401", is(i16, 401, "UNAUTHORIZED"), got(i16));
  psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WS_A}', 'election_day');`);
}

// ---------------------------------------------------------------------------
section("CATALOG - function, permissions, indexes");
{
  const fn = "public.election_day_sync_coordinators_from_voters_for_workspace(uuid)";
  const def = psql(`select pg_get_functiondef('${fn}'::regprocedure);`);
  check("D01 sync uses the per-workspace conflict target", /on conflict \(workspace_id, display_name\) where status = 'active' do nothing/i.test(def));
  check("D01b the former global target is gone", !/on conflict \(display_name\)/i.test(def));
  check("D01c still SECURITY DEFINER with an empty search_path",
    psql(`select prosecdef::text || ' ' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = '${fn}'::regprocedure;`) === 'true search_path=""');
  check("D02 sync executable by no client role (anon/authenticated/service_role)",
    psql(`select has_function_privilege('anon', '${fn}', 'execute')::text || has_function_privilege('authenticated', '${fn}', 'execute')::text || has_function_privilege('service_role', '${fn}', 'execute')::text;`) === "falsefalsefalse");
  const v3 = "public.election_day_import_voters_v3(bytea,bytea,jsonb)";
  check("D03 import_voters_v3 still service_role-only",
    psql(`select has_function_privilege('anon', '${v3}', 'execute')::text || has_function_privilege('authenticated', '${v3}', 'execute')::text || has_function_privilege('service_role', '${v3}', 'execute')::text;`) === "falsefalsetrue");
  check("D04 coordinator indexes unchanged (Phase 4A per-workspace set)",
    psql(`select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'election_day_coordinators';`) ===
      "election_day_coordinators_pkey,election_day_coordinators_workspace_active_display_name_key,election_day_coordinators_workspace_id_id_key,election_day_coordinators_workspace_id_idx,election_day_coordinators_workspace_linked_assignment_name_key");
}

// ---------------------------------------------------------------------------
try {
  psql(`delete from public.election_workspaces where name like '${PREFIX} %';`);
  check("Z01 fixtures removed", psql(`select count(*) from public.election_workspaces where name like '${PREFIX} %';`) === "0");
} catch (err) {
  check("Z01 fixtures removed", false, String(err?.message ?? err).split("\n")[0]);
}
process.exit(tally("VOTER IMPORT HOTFIX") ? 1 : 0);
