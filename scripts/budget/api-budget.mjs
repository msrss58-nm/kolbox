// Budget Stage 3 - REAL-LOCAL security + integrity suite for the Budget core.
//
// Real Postgres + real GoTrue (the isolated kolboxs5 scratch stack), the REAL
// bundled handlers (api/budget/actions.ts, api/election-day/session.ts,
// api/election-day/actions.ts, api/election-day/reauth.ts), real
// PermissionUser sessions and real Election Owners. Synthetic data only; no
// password, cookie, proof or token is ever printed.
//
// Run:  S5_STACK_DIR=<scratch>/s9stack [S5_PORT_OFFSET=1000] node scripts/budget/api-budget.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import {
  SCRATCH_DB_CONTAINER,
  admin,
  callHandler,
  check,
  installLocalnetGuard,
  loadStack,
  psql,
  section,
  signIn,
  sleep,
  tally,
} from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const H = await buildHandlers();
const a = admin();

const COOKIE = "__Host-kb_ed_session";
const RUN = crypto.randomBytes(3).toString('hex');
const PFX = `S3B-${RUN}`;
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const code = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const DOMAIN = `budget-s3-${RUN}.invalid`;
const CODES = { A: code(), B: code(), C: code(), N: code() };
const PW = "S3-Budget-Pw-9!";
const uuid = () => crypto.randomUUID();
const resetRateLimits = () => psql("delete from public.election_day_login_attempts;");
const q1 = (sql) => psql(sql);

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
async function bw(cookie, op, args, extra = {}) {
  const r = await callHandler(H.budget, {
    method: extra.method ?? "POST",
    url: "/api/budget/actions",
    headers: { origin: extra.origin ?? ORIGIN },
    body: extra.body ?? { op, ...(args === undefined ? {} : { args }) },
    cookies: cookie ? { [COOKIE]: cookie } : {},
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function bo(token, op, args) {
  const r = await callHandler(H.budget, {
    method: "POST",
    url: "/api/budget/actions?principal=owner",
    headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: { op, ...(args === undefined ? {} : { args }) },
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function login(code, name) {
  resetRateLimits();
  const r = await callHandler(H.electionSession, {
    method: "POST",
    url: "/api/election-day/session",
    headers: { origin: ORIGIN },
    body: { workspaceCode: code, name, password: PW },
  });
  const sc = r.headers?.["set-cookie"];
  const cookie = typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
  return { status: r.statusCode, error: r.body?.error, modules: r.body?.modules, cookie };
}
const ok = (r) => r.status === 200;
const is = (r, status, code) => r.status === status && r.error === code;
const d = (r) => `${r.status} ${r.error ?? ""}`;

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
q1(`update public.platform_modules set available = true where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

const ALL_BUDGET = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
function mkWorkspace(label, code, modules, ended) {
  return q1(`
    with w as (insert into public.election_workspaces (name, election_end_at, login_code)
      values ('${PFX} ${label}', now() ${ended ? "-" : "+"} interval '10 days', '${code}') returning id)
    select id from w;`);
}
function grant(ws, modules) {
  for (const m of modules) q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${ws}', '${m}');`);
}
function mkRole(ws, name, perms, isManager = false) {
  return q1(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
    values ('${name}', '', ${arr(perms)}, 'all', '${ws}', ${isManager}) returning id;`);
}
function mkUser(ws, name, roleId) {
  return q1(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
    values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${roleId}', '${ws}') returning id;`);
}
async function mkOwner(ws, label) {
  const email = `${label}@${DOMAIN}`;
  const { data, error } = await a.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw error;
  q1(`insert into public.election_owners (workspace_id, auth_user_id, name, email)
      values ('${ws}', '${data.user.id}', 'Owner ${label}', '${email}');`);
  return (await signIn(email, PW)).token;
}

const WA = mkWorkspace("A (election day + budget)", CODES.A);
grant(WA, ["election_day", "budget"]);
const WB = mkWorkspace("B (budget only, election ended)", CODES.B, [], true);
grant(WB, ["budget"]);
const WC = mkWorkspace("C (election day only)", CODES.C);
grant(WC, ["election_day"]);
const WN = mkWorkspace("N (no module)", CODES.N);

const R = {
  full: mkRole(WA, "full", [...ALL_BUDGET, "electionDay.import"]),
  view: mkRole(WA, "view", ["budget.view"]),
  edmgr: mkRole(WA, "ed manager", ["electionDay.import", "electionDay.clearData", "electionDay.manageSettings",
    "electionDay.manageRideCoordinators", "electionDay.export"], true),
  plan: mkRole(WA, "plan", ["budget.view", "budget.managePlan"]),
  set: mkRole(WA, "set", ["budget.view", "budget.manageSettings"]),
  exp: mkRole(WA, "exp", ["budget.view", "budget.manageExpenses"]),
  sub: mkRole(WA, "sub", ["budget.view", "budget.manageFunderSubmissions"]),
  sup: mkRole(WA, "sup", ["budget.view", "budget.manageSuppliers"]),
  bfull: mkRole(WB, "b full", ALL_BUDGET),
  cfull: mkRole(WC, "c full", [...ALL_BUDGET, "electionDay.import"]),
  nfull: mkRole(WN, "n full", ALL_BUDGET),
};
for (const [k, role] of Object.entries(R)) {
  const ws = k.startsWith("b") && k !== "bfull" ? WA : k === "bfull" ? WB : k === "cfull" ? WC : k === "nfull" ? WN : WA;
  mkUser(ws, `u-${k}`, role);
}
const OWNER_A = await mkOwner(WA, "owner-a");
const OWNER_C = await mkOwner(WC, "owner-c");
check("S0 fixtures created", Boolean(WA && WB && WC && WN && OWNER_A && OWNER_C));

// ---------------------------------------------------------------------------
section("AUTH / SESSION / ENTITLEMENT");
const LA = await login(CODES.A, "u-full");
check("A01 ED+Budget workspace login -> modules [election_day, budget]", ok(LA) &&
  JSON.stringify(LA.modules) === JSON.stringify(["election_day", "budget"]), JSON.stringify(LA.modules));
const LB = await login(CODES.B, "u-bfull");
check("A02 Budget-only workspace (election ended) login -> modules [budget]", ok(LB) &&
  JSON.stringify(LB.modules) === JSON.stringify(["budget"]), `${LB.status} ${JSON.stringify(LB.modules)}`);
const edGet = await callHandler(H.electionSession, { method: "GET", url: "/api/election-day/session", cookies: { [COOKIE]: LB.cookie } });
check("A03 Budget-only session does NOT resolve in Election Day (GET session 401)", edGet.statusCode === 401);
const edVoters = await callHandler(H.actions, { method: "GET", url: "/api/election-day/actions?op=list_voters", cookies: { [COOKIE]: LB.cookie } });
check("A04 Budget-only session cannot read Election Day voters (401)", edVoters.statusCode === 401);
const sB = await bw(LB.cookie, "session");
check("A05 Budget works after election_end_at (session op 200)", ok(sB) && sB.data?.modules?.[0] === "budget", d(sB));
const LN = await login(CODES.N, "u-nfull");
check("A06 workspace with neither module -> 403 MODULE_NOT_ENABLED at login", is(LN, 403, "MODULE_NOT_ENABLED"), d(LN));
const LC = await login(CODES.C, "u-cfull");
check("A07 Election-Day-only workspace login unchanged -> modules [election_day]", ok(LC) &&
  JSON.stringify(LC.modules) === JSON.stringify(["election_day"]), JSON.stringify(LC.modules));
check("A08 Budget op in a workspace without Budget -> 403 MODULE_NOT_ENABLED", is(await bw(LC.cookie, "session"), 403, "MODULE_NOT_ENABLED"));
const probeC = await bw(LC.cookie, "probe");
check("A08b navigation probe in a workspace without Budget -> 200 unavailable (no error response)",
  ok(probeC) && probeC.data?.unavailable === "MODULE_NOT_ENABLED" && !probeC.data?.session);
const probeA = await bw(LA.cookie, "probe");
check("A08c navigation probe with Budget -> 200 with the session", ok(probeA) && probeA.data?.session?.modules?.includes("budget"));
check("A09 no cookie -> 401", is(await bw("", "session"), 401, "UNAUTHORIZED"));
check("A10 forged cookie -> 401", is(await bw("f".repeat(64), "session"), 401, "UNAUTHORIZED"));
check("A11 GET -> 405", is(await bw(LA.cookie, "session", undefined, { method: "GET" }), 405, "METHOD_NOT_ALLOWED"));
check("A12 bad origin -> 403", is(await bw(LA.cookie, "session", undefined, { origin: "https://evil.example" }), 403, "FORBIDDEN_ORIGIN"));
check("A13 unknown body key -> 400", is(await bw(LA.cookie, null, null, { body: { op: "session", workspaceId: WB } }), 400, "INVALID_REQUEST"));
check("A14 unknown op -> 400 UNKNOWN_OP", is(await bw(LA.cookie, "drop_everything", {}), 400, "UNKNOWN_OP"));
check("A15 args as array -> 400", is(await bw(LA.cookie, null, null, { body: { op: "session", args: [] } }), 400, "INVALID_REQUEST"));
check("A16 client-sent proofHash -> 400", is(await bw(LA.cookie, "get_settings", { proofHash: "0".repeat(64) }), 400, "INVALID_REQUEST"));

// Kill switch: available=false blocks everything Budget, incl. Budget-only login.
q1(`update public.platform_modules set available = false where key = 'budget';`);
check("A17 kill switch (available=false) -> 403 MODULE_NOT_ENABLED", is(await bw(LA.cookie, "session"), 403, "MODULE_NOT_ENABLED"));
check("A18 kill switch -> Budget-only login refused", is(await login(CODES.B, "u-bfull"), 403, "MODULE_NOT_ENABLED"));
const LA2 = await login(CODES.A, "u-full");
check("A19 kill switch -> ED+Budget login still works, modules [election_day]", ok(LA2) &&
  JSON.stringify(LA2.modules) === JSON.stringify(["election_day"]), JSON.stringify(LA2.modules));
q1(`update public.platform_modules set available = true where key = 'budget';`);

// ---------------------------------------------------------------------------
section("PERMISSIONS");
const U = {};
for (const k of ["full", "view", "edmgr", "plan", "set", "exp", "sub", "sup"]) U[k] = (await login(CODES.A, `u-${k}`)).cookie;
check("P01 Election Day Manager (is_manager, ED perms) gets NO Budget access", is(await bw(U.edmgr, "session"), 403, "FORBIDDEN"));
const probeM = await bw(U.edmgr, "probe");
check("P01b probe for a role without budget.view -> 200 forbidden", ok(probeM) && probeM.data?.unavailable === "FORBIDDEN");
check("P02 budget.view can read", ok(await bw(U.view, "list_expenses", {})));
check("P03 budget.view cannot create a category", is(await bw(U.view, "create_category", { name: "x" }), 403, "FORBIDDEN"));
check("P04 budget.view cannot create an expense", is(await bw(U.view, "create_expense", { description: "x" }), 403, "FORBIDDEN"));
check("P05 managePlan cannot create a category", is(await bw(U.plan, "create_category", { name: "x" }), 403, "FORBIDDEN"));
check("P06 manageSettings can create a category", ok(await bw(U.set, "create_category", { name: `${PFX} perm cat` })));
check("P06b manageSettings alone cannot give a source an amount (plan authority)",
  is(await bw(U.set, "create_source", { name: `${PFX} settings src`, kind: "donation", originalAmount: 100 }), 403, "FORBIDDEN"));
const setSrc = await bw(U.set, "create_source", { name: `${PFX} settings src0`, kind: "donation" });
check("P06c manageSettings may create a source without an amount", ok(setSrc));
check("P06d manageSettings cannot set a source's amount later",
  is(await bw(U.set, "update_source", { sourceId: setSrc.data?.id, originalAmount: 100 }), 403, "FORBIDDEN"));
check("P06e client cannot call the internal step-up ops",
  is(await bw(U.full, "record_stepup_failure", { kind: "reveal", supplierId: uuid(), reason: "rate_limited" }), 400, "INVALID_REQUEST"));
check("P07 manageExpenses cannot record a prior approval", is(await bw(U.exp, "record_preapproval", { allocationId: uuid() }), 403, "FORBIDDEN"));
check("P08 manageFunderSubmissions cannot create an expense", is(await bw(U.sub, "create_expense", { description: "x" }), 403, "FORBIDDEN"));
check("P09 manageSuppliers can create a supplier", ok(await bw(U.sup, "create_supplier", { businessName: `${PFX} perm sup` })));
check("P10 manageSuppliers cannot create an expense", is(await bw(U.sup, "create_expense", { description: "x" }), 403, "FORBIDDEN"));
const vri = (perms) => {
  try {
    q1(`select public.election_day_validate_role_input('r', ${arr(perms)}, 'all');`);
    return "ok";
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
};
check("P11 role DB validation: manage without view -> BUDGET_VIEW_REQUIRED", vri(["budget.manageExpenses"]).includes("BUDGET_VIEW_REQUIRED"));
check("P12 role DB validation: manage + view accepted", vri(["budget.view", "budget.manageExpenses"]) === "ok");
check("P13 role DB validation: unknown budget.* string -> INVALID_PERMISSION", vri(["budget.view", "budget.godMode"]).includes("INVALID_PERMISSION"));
check("P14 existing ED permission strings still valid", vri(["electionDay.import", "voter.markVoted"]) === "ok");
// Stale role: permission removed mid-session takes effect on the next call.
q1(`update public.election_day_roles set permissions = array['budget.view'] where id = '${R.set}';`);
check("P15 permission revoked mid-session -> next write 403", is(await bw(U.set, "create_category", { name: "y" }), 403, "FORBIDDEN"));
q1(`update public.election_day_roles set permissions = array['voter.viewName'] where id = '${R.set}';`);
check("P16 budget.view revoked mid-session -> read 403", is(await bw(U.set, "list_expenses", {}), 403, "FORBIDDEN"));
q1(`update public.election_day_roles set permissions = array['budget.view','budget.manageSettings'] where id = '${R.set}';`);
check("P17 Owner holds intrinsic Budget authority", ok(await bo(OWNER_A, "create_category", { name: `${PFX} owner cat` })));
check("P18 Owner of a workspace without Budget -> 403 MODULE_NOT_ENABLED", is(await bo(OWNER_C, "session"), 403, "MODULE_NOT_ENABLED"));
check("P19 Owner path without a JWT -> 401", is(await bo("", "session"), 401, "UNAUTHORIZED"));
check("P20 Owner path with a forged JWT -> 401", is(await bo("eyJhbGciOiJIUzI1NiJ9.e30.x", "session"), 401, "UNAUTHORIZED"));

// ---------------------------------------------------------------------------
section("SETTINGS (one store, Owner + delegated)");
const st = await bw(U.full, "get_settings");
const rule = (s, key, cond) => s.data.documentRules.find((r) => r.documentTypeKey === key && r.condition === cond);
check("G01 seeded invoice rule: party, total > 1,500 ILS (150000 agorot)", rule(st, "invoice", "amount_gt")?.threshold === 150000 &&
  rule(st, "invoice", "amount_gt")?.fundingKind === "party");
check("G02 seeded supplier-signature rule: order_form_signed > 1,500 ILS", rule(st, "order_form_signed", "amount_gt")?.threshold === 150000);
check("G03 seeded always-required: order form, quotation, bank confirmation",
  ["order_form", "quotation", "bank_confirmation"].every((k) => rule(st, k, "always")));
check("G04 photo is conditional (category + manual), never 'always'", rule(st, "photo", "category") && rule(st, "photo", "manual") && !rule(st, "photo", "always"));
const inv = rule(st, "invoice", "amount_gt");
check("G05 delegated manageSettings edits the invoice threshold", ok(await bw(U.set, "update_document_rule", { ruleId: inv.id, threshold: 200000 })));
const stOwner = await bo(OWNER_A, "get_settings");
check("G06 Owner sees the delegated change (one canonical store)", rule(stOwner, "invoice", "amount_gt")?.threshold === 200000);
check("G07 Owner edits the budget period", ok(await bo(OWNER_A, "update_settings", { periodStart: "2026-01-01", periodEnd: "2027-12-31" })));
check("G08 worker sees the Owner's period", (await bw(U.view, "get_settings")).data.periodEnd === "2027-12-31");
check("G09 threshold on an 'always' rule -> INVALID_INPUT",
  is(await bw(U.set, "update_document_rule", { ruleId: rule(st, "order_form", "always").id, threshold: 1 }), 400, "INVALID_INPUT"));
check("G10 restore threshold 1,500", ok(await bo(OWNER_A, "update_document_rule", { ruleId: inv.id, threshold: 150000 })));
check("G11 inverted budget period rejected", is(await bo(OWNER_A, "update_settings", { periodStart: "2027-01-01", periodEnd: "2026-01-01" }), 400, "INVALID_INPUT"));

// ---------------------------------------------------------------------------
section("FUNDING SOURCES");
const src = async (name, kind, amount) => (await bw(U.full, "create_source", { name: `${PFX} ${name}`, kind, originalAmount: amount })).data?.id;
const SP1 = await src("party 1", "party", 5000000);
const SP2 = await src("party 2", "party", 1000000);
const SD = await src("donations", "donation", 2000000);
const SPE = await src("personal", "personal", 1000000);
check("F01 party / donation / personal + two party sources", Boolean(SP1 && SP2 && SD && SPE));
check("F02 duplicate source name -> 409", is(await bw(U.full, "create_source", { name: `${PFX} party 1`, kind: "party" }), 409, "DUPLICATE_NAME"));
check("F03 invalid kind -> 400", is(await bw(U.full, "create_source", { name: `${PFX} x`, kind: "crypto" }), 400, "INVALID_INPUT"));
check("F04 fractional agorot rejected", is(await bw(U.full, "create_source", { name: `${PFX} f`, kind: "party", originalAmount: 10.5 }), 400, "INVALID_INPUT"));
check("F05 string amount rejected", is(await bw(U.full, "create_source", { name: `${PFX} g`, kind: "party", originalAmount: "100" }), 400, "INVALID_INPUT"));
check("F06 over-cap amount rejected", is(await bw(U.full, "create_source", { name: `${PFX} h`, kind: "party", originalAmount: 1e13 }), 400, "INVALID_INPUT"));
check("F07 adjust +100000 with reason", ok(await bw(U.plan, "adjust_source", { sourceId: SD, delta: 100000, reason: "תרומה נוספת" })));
check("F08 adjust without reason -> 400", is(await bw(U.plan, "adjust_source", { sourceId: SD, delta: 100 }), 400, "INVALID_INPUT"));
check("F09 adjust below zero -> 409", is(await bw(U.plan, "adjust_source", { sourceId: SPE, delta: -2000000, reason: "x" }), 409, "AMOUNT_BELOW_ZERO"));
check("F10 original locked after an adjustment", is(await bw(U.full, "update_source", { sourceId: SD, originalAmount: 1 }), 409, "ORIGINAL_LOCKED"));
const srcs = (await bw(U.view, "list_sources")).data;
check("F11 current = original + adjustments", srcs.find((s) => s.id === SD).currentAmount === 2100000);
let appendErr = "";
try { q1(`update public.budget_funding_source_adjustments set delta_agorot = 1 where workspace_id = '${WA}';`); } catch (e) { appendErr = String(e.stderr); }
check("F12 source adjustments are append-only in the DB", appendErr.includes("BUDGET_APPEND_ONLY"), appendErr.split(String.fromCharCode(10))[0]);

// ---------------------------------------------------------------------------
section("CATEGORIES / PLANNING");
const cat = async (name) => (await bw(U.set, "create_category", { name: `${PFX} ${name}` })).data?.id;
const CS = await cat("שילוט");
const CM = await cat("מדיה");
const CU = await cat("unused");
check("C01 categories created", Boolean(CS && CM && CU));
check("C02 rename", ok(await bw(U.set, "update_category", { categoryId: CU, name: `${PFX} unused2` })));
const cats = (await bw(U.view, "list_categories")).data.map((c) => c.id);
check("C03 reorder with the exact id set", ok(await bw(U.set, "reorder_categories", { categoryIds: [...cats].reverse() })));
check("C04 reorder with a foreign id -> 409", is(await bw(U.set, "reorder_categories", { categoryIds: [uuid()] }), 409, "REORDER_ID_MISMATCH"));
check("C05 delete unused category", ok(await bw(U.set, "delete_category", { categoryId: CU })));
check("C06 set original plans", ok(await bw(U.plan, "set_category_plan", { categoryId: CS, originalPlan: 3000000 })) &&
  ok(await bw(U.plan, "set_category_plan", { categoryId: CM, originalPlan: 1000000 })));
check("C07 plan increase with reason", ok(await bw(U.plan, "adjust_category_plan", { categoryId: CM, delta: 500000, reason: "תוספת" })));
check("C08 original plan locked after adjustment", is(await bw(U.plan, "set_category_plan", { categoryId: CM, originalPlan: 1 }), 409, "ORIGINAL_LOCKED"));
check("C09 transfer above unused plan -> 409", is(await bw(U.plan, "transfer_plan", { fromCategoryId: CM, toCategoryId: CS, amount: 1500001, reason: "x" }), 409, "INSUFFICIENT_PLAN"));
// Concurrency: two simultaneous transfers of 1,000,000 from a category with
// 1,500,000 unused - exactly one may succeed.
const [t1, t2] = await Promise.all([
  bw(U.plan, "transfer_plan", { fromCategoryId: CM, toCategoryId: CS, amount: 1000000, reason: "race 1" }),
  bw(U.plan, "transfer_plan", { fromCategoryId: CM, toCategoryId: CS, amount: 1000000, reason: "race 2" }),
]);
check("C10 concurrent transfers cannot double-spend the unused plan", [t1, t2].filter(ok).length === 1 &&
  [t1, t2].some((r) => is(r, 409, "INSUFFICIENT_PLAN")), `${d(t1)} | ${d(t2)}`);
const catRows = (await bw(U.view, "list_categories")).data;
const cm = catRows.find((c) => c.id === CM);
check("C11 transfer rows net to zero (CM 1,500,000 -> 500,000)", cm.currentPlan === 500000);

// ---------------------------------------------------------------------------
section("SUPPLIERS");
const sup1 = await bw(U.sup, "create_supplier", { businessName: `${PFX} דפוס`, taxId: "51-234 5678", phone: "050-1234567" });
const SUP1 = sup1.data?.id;
check("S01 supplier created with a normalized tax id", ok(sup1) && sup1.data.taxId === "512345678");
const dup = await bw(U.sup, "create_supplier", { businessName: `${PFX} dup`, taxId: "512345678" });
check("S02 duplicate tax id -> 409 with the existing supplier id", is(dup, 409, "DUPLICATE_TAX_ID") && dup.body.existingSupplierId === SUP1);
const SUP2 = (await bw(U.sup, "create_supplier", { businessName: `${PFX} מדיה בע"מ` })).data?.id;
const SUPX = (await bw(U.sup, "create_supplier", { businessName: `${PFX} inactive` })).data?.id;
check("S03 deactivate supplier", ok(await bw(U.sup, "update_supplier", { supplierId: SUPX, isActive: false })));

// ---------------------------------------------------------------------------
section("EXPENSES / ALLOCATIONS");
const newExp = async (desc, total, extra = {}) =>
  (await bw(U.exp, "create_expense", { description: `${PFX} ${desc}`, supplierId: SUP1, categoryId: CS, total, expenseDate: "2026-09-01", ...extra })).data;
check("E01 inactive supplier cannot be used on a new expense", is(await bw(U.exp, "create_expense", { description: "x", supplierId: SUPX }), 409, "SUPPLIER_INACTIVE"));
const draft = (await bw(U.exp, "create_expense", { description: `${PFX} draft only` })).data;
check("E02 draft with only a description", draft?.status === "draft" && draft.referenceNo >= 1);
check("E03 leaving draft incomplete -> 409", is(await bw(U.exp, "transition_expense", { expenseId: draft.id, expectedVersion: draft.version, toStatus: "committed" }), 409, "EXPENSE_INCOMPLETE"));
const E1 = await newExp("שלטים", 1000000);
check("E04 leaving draft without any allocation -> 409", is(await bw(U.exp, "transition_expense", { expenseId: E1.id, expectedVersion: E1.version, toStatus: "committed" }), 409, "ALLOCATION_REQUIRED"));
let e1 = (await bw(U.exp, "set_allocation", { expenseId: E1.id, sourceId: SP1, amount: 1000000 })).data;
check("E05 one-source allocation (party 10,000)", e1?.facts.allocated === 1000000 && e1.facts.unfunded === 0);
check("E06 allocations exceeding the total -> 409", is(await bw(U.exp, "set_allocation", { expenseId: E1.id, sourceId: SPE, amount: 1 }), 409, "ALLOCATIONS_EXCEED_TOTAL"));
e1 = (await bw(U.exp, "transition_expense", { expenseId: E1.id, expectedVersion: e1.version, toStatus: "committed" })).data;
check("E07 draft -> committed (same record, same id)", e1?.status === "committed" && e1.id === E1.id);
check("E08 invalid transition committed -> closed -> 409", is(await bw(U.exp, "transition_expense", { expenseId: E1.id, expectedVersion: e1.version, toStatus: "closed" }), 409, "INVALID_TRANSITION"));
check("E09 stale version -> 409", is(await bw(U.exp, "update_expense", { expenseId: E1.id, expectedVersion: e1.version - 1, notes: "x" }), 409, "STALE_VERSION"));
const [u1, u2] = await Promise.all([
  bw(U.exp, "update_expense", { expenseId: E1.id, expectedVersion: e1.version, notes: "writer 1" }),
  bw(U.exp, "update_expense", { expenseId: E1.id, expectedVersion: e1.version, notes: "writer 2" }),
]);
check("E10 two concurrent edits of one version: exactly one wins", [u1, u2].filter(ok).length === 1 &&
  [u1, u2].some((r) => is(r, 409, "STALE_VERSION")), `${d(u1)} | ${d(u2)}`);
check("E11 expense total cannot drop below its allocations", is(await bw(U.exp, "update_expense", {
  expenseId: E1.id, expectedVersion: (await bw(U.view, "get_expense", { expenseId: E1.id })).data.version, total: 999999 }), 409, "ALLOCATIONS_EXCEED_TOTAL"));

// Multi-source: 10,000 = party 8,000 + personal 2,000.
const E2 = await newExp("multi source", 1000000);
await bw(U.exp, "set_allocation", { expenseId: E2.id, sourceId: SP1, amount: 800000 });
const e2 = (await bw(U.exp, "set_allocation", { expenseId: E2.id, sourceId: SPE, amount: 200000 })).data;
check("L01 party 8,000 + personal 2,000 reconcile to 10,000", e2.allocations.length === 2 && e2.facts.allocated === 1000000 && e2.facts.unfunded === 0);
check("L02 payer derived from kind (party / campaign)", e2.allocations.find((x) => x.sourceId === SP1).payer === "party" &&
  e2.allocations.find((x) => x.sourceId === SPE).payer === "campaign");
// Uncovered gap stays explicit; nothing is auto-assigned.
const E3 = await newExp("gap", 1000000);
const e3 = (await bw(U.exp, "set_allocation", { expenseId: E3.id, sourceId: SP2, amount: 600000 })).data;
check("L03 uncovered gap remains explicit (unfunded 4,000), no other allocation created", e3.facts.unfunded === 400000 && e3.allocations.length === 1);
// Concurrent allocations that would jointly exceed the total: one must fail.
const E4 = await newExp("alloc race", 1000000);
const [al1, al2] = await Promise.all([
  bw(U.exp, "set_allocation", { expenseId: E4.id, sourceId: SD, amount: 600000 }),
  bw(U.exp, "set_allocation", { expenseId: E4.id, sourceId: SPE, amount: 600000 }),
]);
check("L04 concurrent allocations never exceed the total", [al1, al2].filter(ok).length === 1, `${d(al1)} | ${d(al2)}`);
check("L05 inactive source cannot get a new allocation", ok(await bw(U.full, "update_source", { sourceId: SP2, isActive: false })) &&
  is(await bw(U.exp, "set_allocation", { expenseId: E4.id, sourceId: SP2, amount: 1 }), 409, "SOURCE_INACTIVE"));
check("L06 source kind locked once used", is(await bw(U.full, "update_source", { sourceId: SP1, kind: "donation" }), 409, "SOURCE_KIND_LOCKED"));
await bw(U.full, "update_source", { sourceId: SP2, isActive: true });

// ---------------------------------------------------------------------------
section("PARTY: PRIOR APPROVAL / SUBMISSION / PAYMENT REFERENCE");
const pAlloc = (e) => e.allocations.find((x) => x.kind === "party").id;
const nonParty = e2.allocations.find((x) => x.kind === "personal").id;
check("Q01 prior approval on a non-party allocation -> 409", is(await bw(U.sub, "record_preapproval", {
  allocationId: nonParty, approvalCode: "A", approverName: "B", approvalDate: "2026-09-01" }), 409, "NOT_A_PARTY_ALLOCATION"));
check("Q02 'sent' before prior approval -> 409", is(await bw(U.sub, "mark_submission_sent", { allocationId: pAlloc(e2) }), 409, "PREAPPROVAL_REQUIRED"));
let e2b = (await bw(U.sub, "record_preapproval", { allocationId: pAlloc(e2), orderNumber: "77", approvalCode: "AP-1",
  approverName: "מינהל הכספים", approvalDate: "2026-08-20", preapprovedAmount: 700000 })).data;
const pa2 = e2b.allocations.find((x) => x.kind === "party");
check("Q03 prior approval recorded, distinct from the payment reference", pa2.preapproval?.approvalCode === "AP-1" && pa2.reference === null &&
  pa2.submission.displayState === "preapproved");
check("Q04 pre-approved below the order -> warning flag only (not a blocker)", e2b.facts.preapprovalExceeded === 1);
check("Q05 reference before 'sent' -> 409", is(await bw(U.sub, "record_payment_reference", { allocationId: pa2.id,
  referenceNumber: "R", authorizedAmount: 800000, receivedDate: "2026-09-02" }), 409, "SUBMISSION_NOT_SENT"));
const E5 = await newExp("draft submit", 100000);
const e5 = (await bw(U.exp, "set_allocation", { expenseId: E5.id, sourceId: SP1, amount: 100000 })).data;
await bw(U.sub, "record_preapproval", { allocationId: pAlloc(e5), approvalCode: "AP-5", approverName: "x", approvalDate: "2026-09-01" });
check("Q06 'sent' while the expense is still a draft -> 409", is(await bw(U.sub, "mark_submission_sent", { allocationId: pAlloc(e5) }), 409, "EXPENSE_NOT_SUBMITTABLE"));
// E2 is still draft: commit it first.
e2b = (await bw(U.exp, "transition_expense", { expenseId: E2.id, expectedVersion: e2b.version, toStatus: "committed" })).data;
e2b = (await bw(U.sub, "mark_submission_sent", { allocationId: pa2.id, recipientPhone: "0501111111" })).data;
check("Q07 marked sent (user-confirmed), display state 'sent'", e2b.allocations.find((x) => x.kind === "party").submission.displayState === "sent");
check("Q08 party allocation frozen while sent", is(await bw(U.exp, "set_allocation", { expenseId: E2.id, sourceId: SP1, amount: 700000 }), 409, "ALLOCATION_FROZEN"));
check("Q09 'returned' requires a note", is(await bw(U.sub, "mark_submission_returned", { allocationId: pa2.id }), 400, "INVALID_INPUT"));
check("Q10 returned for correction", ok(await bw(U.sub, "mark_submission_returned", { allocationId: pa2.id, note: "חסר צילום" })));
check("Q11 re-sent after correction", ok(await bw(U.sub, "mark_submission_sent", { allocationId: pa2.id })));
check("Q12 authorized above the request -> 409", is(await bw(U.sub, "record_payment_reference", { allocationId: pa2.id,
  referenceNumber: "R-1", authorizedAmount: 800001, receivedDate: "2026-09-03" }), 409, "AUTHORIZED_EXCEEDS_REQUEST"));
// Partial authorization: 8,000 requested, 6,000 authorized -> explicit gap 2,000.
e2b = (await bw(U.sub, "record_payment_reference", { allocationId: pa2.id, referenceNumber: "R-1",
  authorizedAmount: 600000, receivedDate: "2026-09-03" })).data;
const pa2b = e2b.allocations.find((x) => x.kind === "party");
check("Q13 partial authorization: party allocation = authorized 6,000, gap 2,000, same expense", pa2b.amount === 600000 &&
  pa2b.reference.authorizedAmount === 600000 && e2b.facts.unfunded === 200000 && e2b.id === E2.id && e2b.allocations.length === 2);
check("Q14 gap is never auto-assigned (personal unchanged at 2,000)", e2b.allocations.find((x) => x.kind === "personal").amount === 200000);
e2b = (await bw(U.exp, "set_allocation", { expenseId: E2.id, sourceId: SD, amount: 200000 })).data;
check("Q15 user funds the gap from a source they choose (donation 2,000)", e2b.facts.unfunded === 0 && e2b.allocations.length === 3);

// ---------------------------------------------------------------------------
section("PAYMENT LEDGER");
const pay = (allocationId, amount, key = uuid(), who = U.exp) =>
  bw(who, "record_payment", { allocationId, amount, paymentDate: "2026-09-05", confirmationSource: "funder_notice", idempotencyKey: key });
check("M01 party payment before a payment reference -> 409", is(await pay(e1.allocations[0].id, 100), 409, "PARTY_REFERENCE_REQUIRED"));
check("M01b payment on a draft expense -> 409", is(await pay(pAlloc(e3), 100), 409, "EXPENSE_NOT_PAYABLE"));
const k1 = uuid();
let m = (await pay(pa2b.id, 300000, k1)).data;
check("M02 first party payment (3,000) -> partial", m.allocations.find((x) => x.id === pa2b.id).paymentStatus === "partial" &&
  m.payments.at(-1).payer === "party");
check("M03 idempotent replay: same key, same payment -> no duplicate", (await pay(pa2b.id, 300000, k1)).data.payments.length === 1);
check("M04 same key, different amount -> 409", is(await pay(pa2b.id, 1, k1), 409, "IDEMPOTENCY_CONFLICT"));
m = (await pay(pa2b.id, 200000)).data;
check("M05 second party payment (2,000)", m.payments.filter((p) => !p.voidedAt).length === 2);
check("M06 overpayment beyond the authorized allocation -> 409", is(await pay(pa2b.id, 100001), 409, "PAYMENT_EXCEEDS_ALLOCATION"));
// Concurrency: remaining 1,000; two simultaneous 700s -> exactly one.
// Remaining on the party allocation is 1,000 (6,000 authorized - 5,000 paid).
const [c1, c2] = await Promise.all([pay(pa2b.id, 70000), pay(pa2b.id, 70000)]);
check("M07 two simultaneous 700 payments against 1,000 remaining: exactly one succeeds", [c1, c2].filter(ok).length === 1 &&
  [c1, c2].some((r) => is(r, 409, "PAYMENT_EXCEEDS_ALLOCATION")), `${d(c1)} | ${d(c2)}`);
let cur = (await bw(U.view, "get_expense", { expenseId: E2.id })).data;
const partyPaid = cur.allocations.find((x) => x.id === pa2b.id).paid;
check("M08 party paid never exceeds authorized", partyPaid <= 600000, String(partyPaid));
// Void one payment: excluded from every sum; never deleted.
const toVoid = cur.payments.find((p) => !p.voidedAt && p.amount === 200000);
cur = (await bw(U.exp, "void_payment", { paymentId: toVoid.id, reason: "נרשם בטעות" })).data;
check("M09 voided payment kept, excluded from paid", cur.payments.find((p) => p.id === toVoid.id).voidedAt && cur.allocations.find((x) => x.id === pa2b.id).paid === partyPaid - 200000);
check("M10 void twice -> 409", is(await bw(U.exp, "void_payment", { paymentId: toVoid.id, reason: "x" }), 409, "PAYMENT_ALREADY_VOIDED"));
let delErr = "";
try { q1(`delete from public.budget_supplier_payments where workspace_id = '${WA}';`); } catch (e) { delErr = String(e.stderr); }
check("M11 payments cannot be deleted in the DB", delErr.includes("BUDGET_APPEND_ONLY"));
let updErr = "";
try { q1(`update public.budget_supplier_payments set amount_agorot = 1 where workspace_id = '${WA}';`); } catch (e) { updErr = String(e.stderr); }
check("M12 payment amounts cannot be edited in the DB", updErr.includes("BUDGET_APPEND_ONLY") || updErr.includes("PAYMENT_ALREADY_VOIDED"));
check("Q16 returned-for-correction refused once a payment reference exists", is(await bw(U.sub, "mark_submission_returned", { allocationId: pa2b.id, note: "x" }), 409, "INVALID_TRANSITION"));
check("M13 cancelling an expense with valid payments -> 409", is(await bw(U.exp, "transition_expense", {
  expenseId: E2.id, expectedVersion: cur.version, toStatus: "cancelled", reason: "x" }), 409, "PAYMENTS_EXIST"));

// Pay everything so E2 can close: party remainder, personal, donation.
cur = (await bw(U.view, "get_expense", { expenseId: E2.id })).data;
const remParty = 600000 - cur.allocations.find((x) => x.id === pa2b.id).paid;
if (remParty > 0) await pay(pa2b.id, remParty);
const persId = cur.allocations.find((x) => x.kind === "personal").id;
const donId = cur.allocations.find((x) => x.kind === "donation").id;
await pay(persId, 200000);
cur = (await pay(donId, 200000)).data;
check("M14 multi-payment party allocation fully paid; campaign payers for personal/donation",
  cur.allocations.every((x) => x.paymentStatus === "paid") && cur.payments.filter((p) => p.allocationId === persId).every((p) => p.payer === "campaign"));

// ---------------------------------------------------------------------------
section("CLOSE GUARD");
const e3now = (await bw(U.view, "get_expense", { expenseId: E3.id })).data;
await bw(U.exp, "transition_expense", { expenseId: E3.id, expectedVersion: e3now.version, toStatus: "committed" });
const e3c = (await bw(U.view, "get_expense", { expenseId: E3.id })).data;
await bw(U.exp, "transition_expense", { expenseId: E3.id, expectedVersion: e3c.version, toStatus: "incurred" });
const e3i = (await bw(U.view, "get_expense", { expenseId: E3.id })).data;
const blocked = await bw(U.exp, "transition_expense", { expenseId: E3.id, expectedVersion: e3i.version, toStatus: "closed" });
check("K01 close blocked, blockers listed", is(blocked, 409, "CLOSE_BLOCKED") &&
  ["FUNDING_NOT_RECONCILED", "SUPPLIER_NOT_FULLY_PAID", "PARTY_PREAPPROVAL_MISSING", "PARTY_REFERENCE_MISSING"].every((b) => blocked.body.blockers.includes(b)),
  `${d(blocked)} statusBefore=${e3i?.status} body=${JSON.stringify(blocked.body)}`);
// Stage 4 added the required documents + order form to the close guard (the
// Stage 1 definition). This section proves the FINANCIAL close guard, so the
// party document rules are switched off for K02-K04 and restored right after;
// the document part of the close guard is proven in api-budget-docs.mjs.
const partyDocRules = (await bo(OWNER_A, "get_settings")).data.documentRules.filter((r) => r.isActive && r.fundingKind === "party");
for (const r of partyDocRules) await bo(OWNER_A, "update_document_rule", { ruleId: r.id, isActive: false });
cur = (await bw(U.view, "get_expense", { expenseId: E2.id })).data;
cur = (await bw(U.exp, "transition_expense", { expenseId: E2.id, expectedVersion: cur.version, toStatus: "incurred" })).data;
cur = (await bw(U.exp, "transition_expense", { expenseId: E2.id, expectedVersion: cur.version, toStatus: "closed" })).data;
check("K02 party expense closes: reconciled, prior approval + reference, party payments cover authorized, all paid", cur?.status === "closed", cur?.status);
check("K03 closed expense is locked", is(await bw(U.exp, "update_expense", { expenseId: E2.id, expectedVersion: cur.version, notes: "x" }), 409, "EXPENSE_LOCKED"));
check("K04 reopen requires a reason", is(await bw(U.exp, "transition_expense", { expenseId: E2.id, expectedVersion: cur.version, toStatus: "incurred" }), 409, "REASON_REQUIRED"));
for (const r of partyDocRules) await bo(OWNER_A, "update_document_rule", { ruleId: r.id, isActive: true });

// ---------------------------------------------------------------------------
section("CALCULATION LAYER (one definition, lists reconcile)");
const ov = (await bw(U.view, "get_overview")).data;
const allSrc = (await bw(U.view, "list_sources")).data.filter((s) => s.isActive);
check("X01 totalBudget = sum of active sources' current amounts", ov.totalBudget === allSrc.reduce((s, x) => s + x.currentAmount, 0));
check("X02 party/donation/personal budgets add up", ov.partyBudget + ov.donationBudget + ov.personalBudget === ov.totalBudget);
check("X03 available = total - committed - actual", ov.available === ov.totalBudget - ov.committed - ov.actual);
const listAuth = (await bw(U.view, "list_expenses", { queue: "authorized_not_fully_paid" })).data;
check("X04 authorized-not-fully-paid count == its drill-down list", listAuth.total === ov.authorizedNotFullyPaid.count, `${listAuth.total} vs ${ov.authorizedNotFullyPaid.count}`);
const listUnfunded = (await bw(U.view, "list_expenses", { queue: "unfunded" })).data;
check("X05 unfunded expenses count reconciles with its list", listUnfunded.total === ov.unfundedExpenses);
const listAwait = (await bw(U.view, "list_expenses", { queue: "awaiting_preapproval" })).data;
check("X06 awaiting-prior-approval count == its drill-down list", listAwait.total === ov.awaitingPreapproval && listAwait.total > 0, `${listAwait.total} vs ${ov.awaitingPreapproval}`);
check("X07 outstanding = party outstanding + campaign liability + unfunded (party never counted as campaign liability)",
  ov.outstanding === ov.partyOutstanding + ov.campaignLiability + ov.unfundedTotal,
  `${ov.outstanding} = ${ov.partyOutstanding} + ${ov.campaignLiability} + ${ov.unfundedTotal}`);
const s1 = (await bw(U.view, "get_supplier", { supplierId: SUP1 })).data;
check("X08 supplier outstanding = party + campaign + unfunded", s1.outstanding === s1.partyOutstanding + s1.campaignOutstanding + s1.unfundedOutstanding,
  `${s1.outstanding} = ${s1.partyOutstanding} + ${s1.campaignOutstanding} + ${s1.unfundedOutstanding}`);
const listSent = (await bw(U.view, "list_expenses", { queue: "sent_waiting_reference" })).data;
check("X09 sent-waiting-reference count == its drill-down list", listSent.total === ov.sentWaitingReference);

// ---------------------------------------------------------------------------
section("WORKSPACE ISOLATION");
const WBc = LB.cookie;
check("I01 other workspace's expense -> 404", is(await bw(WBc, "get_expense", { expenseId: E1.id }), 404, "NOT_FOUND"));
check("I02 other workspace's supplier update -> 404", is(await bw(WBc, "update_supplier", { supplierId: SUP1, notes: "x" }), 404, "NOT_FOUND"));
check("I03 other workspace's allocation payment -> 404", is(await pay(pa2b.id, 1, uuid(), WBc), 404, "NOT_FOUND"));
const eB = (await bw(WBc, "create_expense", { description: "B exp", total: 1000, supplierId: null })).data;
check("I04 allocating another workspace's source -> 404", is(await bw(WBc, "set_allocation", { expenseId: eB.id, sourceId: SP1, amount: 1 }), 404, "NOT_FOUND"));
const listB = (await bw(WBc, "list_expenses", { workspaceId: WA })).data;
check("I05 a client-supplied workspaceId is ignored (B sees only its own)", listB.rows.every((r) => r.id === eB.id) && listB.total === 1);
let fkErr = "";
try {
  q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"t","workspace_id":"${WB}"}', false);
      insert into public.budget_expense_allocations (workspace_id, expense_id, funding_source_id, amount_agorot)
      values ('${WB}', '${eB.id}', '${SP1}', 1);`);
} catch (e) { fkErr = String(e.stderr); }
check("I06 DB refuses a cross-workspace reference (composite FK)", fkErr.includes("violates foreign key"), fkErr.split("\n")[0]);
let ctxErr = "";
try { q1(`insert into public.budget_categories (workspace_id, name) values ('${WA}', 'no actor');`); } catch (e) { ctxErr = String(e.stderr); }
check("I07 write without actor context refused", ctxErr.includes("BUDGET_ACTOR_CONTEXT_REQUIRED"));
let wsErr = "";
try {
  q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"t","workspace_id":"${WB}"}', false);
      insert into public.budget_categories (workspace_id, name) values ('${WA}', 'wrong ws');`);
} catch (e) { wsErr = String(e.stderr); }
check("I08 write for another workspace than the actor's refused", wsErr.includes("BUDGET_WORKSPACE_MISMATCH"));
const priv = q1(`select
  bool_or(has_table_privilege(r, 'public.' || t, 'select') or has_table_privilege(r, 'public.' || t, 'insert')
          or has_table_privilege(r, 'public.' || t, 'update') or has_table_privilege(r, 'public.' || t, 'delete'))
  from unnest(array['anon','authenticated','service_role']) r,
       (select tablename t from pg_tables where schemaname = 'public' and tablename like 'budget\\_%') x;`);
check("I09 no table privilege on any budget_* table for anon/authenticated/service_role", priv === "f", priv);
const fnGrants = q1(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'budget\\_%' or p.proname in ('workspace_resolve_session','workspace_session_modules',
    'election_day_verify_permission_user_password','election_day_workspace_worker_modules'))
    and has_function_privilege('service_role', p.oid, 'execute');`);
check("I10 service_role executes ONLY the dispatchers, the worker step-up mint and workspace_session_modules",
  fnGrants === "budget_dispatch_owner,budget_dispatch_worker,budget_stepup_mint_worker,workspace_session_modules", fnGrants);
const anonFn = q1(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'budget\\_%' or p.proname like 'workspace\\_%')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
check("I11 anon/authenticated execute no Budget/workspace function", anonFn === "0", anonFn);

// ---------------------------------------------------------------------------
section("BANK DETAILS + STEP-UP");
const listS = (await bw(U.view, "list_suppliers")).data;
check("B01 lists never carry bank data", !JSON.stringify(listS).includes("accountNumber"));
check("B02 reveal without a proof -> 403 STEPUP_REQUIRED", is(await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP1 }), 403, "STEPUP_REQUIRED"));
check("B03 change without a proof -> 403 STEPUP_REQUIRED", is(await bw(U.sup, "set_supplier_bank", { supplierId: SUP1, accountNumber: "123456" }), 403, "STEPUP_REQUIRED"));
const stepup = async (cookie, kind, supplierId, password = PW) => {
  resetRateLimits();
  return bw(cookie, "stepup", { kind, supplierId, password });
};
check("B04 budget.view (no manageSuppliers) cannot step up", is(await stepup(U.view, "change", SUP1), 403, "FORBIDDEN"));
const badPw = await stepup(U.sup, "change", SUP1, "wrong-password");
check("B05 wrong password -> 401", is(badPw, 401, "UNAUTHORIZED"));
const failAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_id = '${SUP1}'
  and after_data ->> 'event' = 'stepup_failed' and after_data ->> 'reason' = 'invalid_password';`);
check("B06 failed step-up audited", Number(failAudit) >= 1, failAudit);
const chg = (await stepup(U.sup, "change", SUP1)).body?.proof;
check("B07 correct password -> one proof", typeof chg === "string" && chg.length === 64);
const stored = q1(`select count(*) from public.election_day_reauth_proofs where proof_hash = decode('${crypto.createHash("sha256").update(chg).digest("hex")}', 'hex');`);
const rawStored = q1(`select count(*) from public.election_day_reauth_proofs where encode(proof_hash, 'hex') = '${Buffer.from(chg).toString("hex")}';`);
check("B08 only the proof's sha256 is persisted", stored === "1" && rawStored === "0");
check("B09 change proof cannot reveal", is(await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP1, proof: chg }), 403, "STEPUP_REQUIRED"));
check("B10 proof for supplier 1 cannot change supplier 2", is(await bw(U.sup, "set_supplier_bank", { supplierId: SUP2, accountNumber: "1234", proof: chg }), 403, "STEPUP_REQUIRED"));
check("B11 another user cannot use the proof", is(await bw(U.full, "set_supplier_bank", { supplierId: SUP1, accountNumber: "1234", proof: chg }), 403, "STEPUP_REQUIRED"));
check("B12 change with the proof", ok(await bw(U.sup, "set_supplier_bank", { supplierId: SUP1, bankCode: "12", branchCode: "600",
  accountNumber: "5551234", accountHolder: "דפוס בע\"מ", proof: chg })));
check("B13 proof is single-use", is(await bw(U.sup, "set_supplier_bank", { supplierId: SUP1, accountNumber: "1111", proof: chg }), 403, "STEPUP_REQUIRED"));
const masked = (await bw(U.view, "get_supplier", { supplierId: SUP1 })).data;
check("B14 masked by default (last 4 only)", masked.bank?.accountLast4 === "1234" && !JSON.stringify(masked).includes("5551234"));
const auditBank = q1(`select string_agg(coalesce(after_data::text,''), ' ') from public.budget_audit_events
  where workspace_id = '${WA}' and entity_type = 'budget_supplier_bank_details';`);
check("B15 audit holds last 4 only, never the account number", !auditBank.includes("5551234") && auditBank.includes("1234"));
const rev = (await stepup(U.sup, "reveal", SUP1)).body?.proof;
// Expired proof.
const expired = (await stepup(U.sup, "reveal", SUP1)).body?.proof;
q1(`update public.election_day_reauth_proofs set expires_at = now() - interval '1 second'
    where proof_hash = decode('${crypto.createHash("sha256").update(expired).digest("hex")}', 'hex');`);
check("B16 expired proof refused", is(await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP1, proof: expired }), 403, "STEPUP_REQUIRED"));
const revealed = await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP1, proof: rev });
check("B17 reveal with a fresh proof returns full details", ok(revealed) && revealed.data.bank.accountNumber === "5551234");
const revAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_id = '${SUP1}' and after_data ->> 'event' = 'bank_revealed';`);
check("B18 reveal audited", Number(revAudit) >= 1);
// Rate limit: 11 failed attempts in the window.
resetRateLimits();
let last;
for (let i = 0; i < 11; i++) last = await bw(U.sup, "stepup", { kind: "reveal", supplierId: SUP1, password: "nope" });
check("B19 step-up rate limited", is(last, 429, "RATE_LIMITED"), d(last));
const rlAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and after_data ->> 'reason' = 'rate_limited';`);
check("B20 rate-limited step-up audited", Number(rlAudit) >= 1);
// Budget-only worker can step up (module-neutral resolution).
const supB = (await bw(WBc, "create_supplier", { businessName: "B supplier" })).data.id;
const bProof = (await stepup(WBc, "change", supB)).body?.proof;
check("B21 Budget-only worker can step up", typeof bProof === "string" && ok(await bw(WBc, "set_supplier_bank", { supplierId: supB, accountNumber: "9999", proof: bProof })));
// Owner step-up: Supabase Auth password re-check + the existing owner proof store.
resetRateLimits();
check("B22 Owner wrong password -> 401", is(await bo(OWNER_A, "stepup", { kind: "reveal", supplierId: SUP1, password: "nope" }), 401, "UNAUTHORIZED"));
resetRateLimits();
const ownerProof = (await bo(OWNER_A, "stepup", { kind: "reveal", supplierId: SUP1, password: PW })).body?.proof;
const ownerRev = await bo(OWNER_A, "reveal_supplier_bank", { supplierId: SUP1, proof: ownerProof });
check("B23 Owner reveal with an Owner proof", ok(ownerRev) && ownerRev.data.bank.accountNumber === "5551234");
check("B24 worker cannot use an Owner proof", is(await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP1, proof: ownerProof }), 403, "STEPUP_REQUIRED"));
// Election Day reauth unaffected: Budget actions are not in its allowlist.
resetRateLimits();
const edReauth = await callHandler(H.reauth, { method: "POST", url: "/api/election-day/reauth", headers: { origin: ORIGIN },
  body: { password: PW, action: `budget_bank_reveal:${SUP1}` }, cookies: { [COOKIE]: U.full } });
check("B25 Election Day reauth refuses Budget actions (INVALID_ACTION)", edReauth.statusCode === 400 && edReauth.body?.error === "INVALID_ACTION");

// ---------------------------------------------------------------------------
section("AUDIT");
const hist = (await bw(U.view, "list_history", { entityType: "expense", entityId: E2.id })).data;
const types = new Set(hist.map((h) => h.entityType));
check("U01 expense history covers expense, allocations, prior approval, submission, reference, payments",
  ["budget_expenses", "budget_expense_allocations", "budget_party_preapprovals", "budget_party_submissions",
   "budget_party_submission_events", "budget_party_payment_references", "budget_supplier_payments"].every((t) => types.has(t)), [...types].join(","));
check("U02 history names the actors", hist.every((h) => h.actorName));
let auErr = "";
try { q1(`update public.budget_audit_events set actor_name = 'x' where workspace_id = '${WA}';`); } catch (e) { auErr = String(e.stderr); }
check("U03 audit rows cannot be updated", auErr.includes("BUDGET_APPEND_ONLY"));
let adErr = "";
try { q1(`delete from public.budget_audit_events where workspace_id = '${WA}';`); } catch (e) { adErr = String(e.stderr); }
check("U04 audit rows cannot be deleted", adErr.includes("BUDGET_APPEND_ONLY"));
let atErr = "";
try { q1(`truncate public.budget_audit_events;`); } catch (e) { atErr = String(e.stderr); }
check("U05 audit table cannot be truncated", atErr.includes("BUDGET_APPEND_ONLY"));
const settingsAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_type in ('budget_settings','budget_document_rules');`);
check("U06 settings/rule changes audited", Number(settingsAudit) >= 3);

// ---------------------------------------------------------------------------
section("ENTITLEMENT DISABLE / RE-ENABLE (data kept)");
const before = q1(`select count(*) from public.budget_expenses where workspace_id = '${WA}';`);
q1(`delete from public.election_workspace_modules where workspace_id = '${WA}' and module_key = 'budget';`);
check("N01 Budget disabled -> 403 MODULE_NOT_ENABLED", is(await bw(U.full, "list_expenses", {}), 403, "MODULE_NOT_ENABLED"));
// A fresh Owner token: a long run can outlive the setup JWT (~1 h).
const OWNER_A_FRESH = (await signIn(`owner-a@${DOMAIN}`, PW)).token;
const n02 = await bo(OWNER_A_FRESH, "get_settings");
check("N02 Owner path also blocked", is(n02, 403, "MODULE_NOT_ENABLED"), d(n02));
check("N03 data kept while disabled", q1(`select count(*) from public.budget_expenses where workspace_id = '${WA}';`) === before);
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}', 'budget');`);
check("N04 re-enabled -> access and data restored", (await bw(U.full, "list_expenses", {})).data?.total === Number(before));
// Entitlement removed WHILE an operation waits on the workspace lock.
const locker = spawn("docker", ["exec", "-i", SCRATCH_DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"]);
locker.stdin.end(`begin;
  select 1 from public.election_workspaces where id = '${WA}' for update;
  delete from public.election_workspace_modules where workspace_id = '${WA}' and module_key = 'budget';
  select pg_sleep(6) /* s3-entitlement-race */;
  commit;`);
// Fire only once the locker really holds the workspace row (docker exec can
// take seconds to start on a loaded machine).
for (let i = 0; i < 60; i++) {
  if (q1(`select count(*) from pg_stat_activity where state = 'active' and query like '%s3-entitlement-race%' and pid <> pg_backend_pid();`) === "1") break;
  await sleep(250);
}
const during = await bw(U.full, "create_category", { name: `${PFX} during revoke` });
await new Promise((r) => locker.on("close", r));
check("N05 operation racing an entitlement removal is refused after the lock", is(during, 403, "MODULE_NOT_ENABLED"), d(during));
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}', 'budget') on conflict do nothing;`);

// ---------------------------------------------------------------------------
section("CLEANUP");
q1(`update public.platform_modules set available = false where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check("Z01 budget.available restored to false on the scratch stack", q1(`select available from public.platform_modules where key = 'budget';`) === "f");

process.exit(tally("BUDGET STAGE 3") ? 1 : 0);
