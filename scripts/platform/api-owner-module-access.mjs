// ELECTION OWNER MODULE ACCESS - the approved product model.
//
// An Election Owner sees and drives every module their workspace is entitled
// to, through the SAME server surface the module already has, and nothing it
// is not entitled to. Owner administration stays available either way.
//
// Drives the REAL bundled handlers against the isolated kolboxs5 scratch
// stack. Four Owners, one per entitlement combination, plus cross-workspace
// isolation and an untouched worker path.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/platform/api-owner-module-access.mjs
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import {
  admin,
  callHandler,
  check,
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

const ELECTION_ORIGIN = "https://election.test";
process.env.SESSION_ALLOWED_ORIGIN = ELECTION_ORIGIN;
process.env.OWNER_ALLOWED_ORIGIN = ELECTION_ORIGIN;
process.env.BUDGET_ALLOWED_ORIGIN = ELECTION_ORIGIN;

const H = await buildHandlers();
const A = admin();
const PW = randomPassword();
const stamp = Date.now();

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const mkCode = (seed) =>
  Array.from({ length: 8 }, (_, i) => CODE_ALPHABET[(seed * 7 + i * 13) % CODE_ALPHABET.length]).join("");

/** One Election Owner + workspace + the exact module rows requested. */
async function makeOwner(label, modules, seed) {
  const email = `owner-${label}-${stamp}@kolbox.test`;
  const { data, error } = await A.auth.admin.createUser({
    email,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const code = mkCode(seed);
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at) values ('WS ${label}','${code}', now()+interval '30 days');`,
  );
  const workspaceId = psql(
    `select id from public.election_workspaces where login_code='${code}';`,
  ).trim();
  psql(
    `insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${workspaceId}','${data.user.id}','Owner ${label}','${email}');`,
  );
  for (const key of modules) {
    psql(
      `insert into public.election_workspace_modules (workspace_id, module_key) values ('${workspaceId}','${key}') on conflict do nothing;`,
    );
  }
  const { token } = await signIn(email, PW);
  return { label, email, authUserId: data.user.id, workspaceId, code, token, modules };
}

const ownerGet = (owner, op) =>
  callHandler(H.ownerActions, {
    method: "GET",
    url: `/api/election-day/owner-actions?op=${encodeURIComponent(op)}`,
    headers: { origin: ELECTION_ORIGIN, authorization: `Bearer ${owner.token}` },
  });

const ownerPost = (owner, body) =>
  callHandler(H.ownerActions, {
    method: "POST",
    url: "/api/election-day/owner-actions",
    headers: {
      origin: ELECTION_ORIGIN,
      authorization: `Bearer ${owner.token}`,
      "content-type": "application/json",
    },
    body,
  });

const budgetOwner = (owner, op, args = {}) =>
  callHandler(H.budget, {
    method: "POST",
    url: "/api/budget/actions?principal=owner",
    headers: {
      origin: ELECTION_ORIGIN,
      authorization: `Bearer ${owner.token}`,
      "content-type": "application/json",
    },
    body: { op, args },
  });

// ---------------------------------------------------------------- fixtures --
section("FIXTURES: one Owner per entitlement combination");
// Effective module access = the workspace entitlement AND the module's GLOBAL
// availability. `budget` ships globally unavailable, so switch it on here -
// otherwise every Budget expectation below wouldtest  the availability switch
// rather than the Owner bridge. (Scratch stack only; Production availability
// is changed exclusively through the audited Platform console control.)
psql(`update public.platform_modules set available = true where key = 'budget';`);
const both = await makeOwner("both", ["election_day", "budget"], 1);
const edOnly = await makeOwner("ed", ["election_day"], 2);
const budgetOnly = await makeOwner("budget", ["budget"], 3);
const neither = await makeOwner("none", [], 4);
check(
  "F1 four Owners, four workspaces, four entitlement sets",
  new Set([both.workspaceId, edOnly.workspaceId, budgetOnly.workspaceId, neither.workspaceId]).size === 4,
);

// ---------------------------------------------------- per-module visibility --
section("A. ELECTION DAY IS REACHABLE EXACTLY WHEN ENTITLED");
for (const [id, owner, expected] of [
  ["A1", edOnly, true],
  ["A2", both, true],
  ["A3", budgetOnly, false],
  ["A4", neither, false],
]) {
  const r = await ownerGet(owner, "list_voters");
  const ok = expected ? r.statusCode === 200 : r.statusCode === 403;
  check(
    `${id} Owner[${owner.label}] Election Day -> ${expected ? "200" : "403 MODULE_NOT_ENABLED"}`,
    ok,
    `status=${r.statusCode} ${JSON.stringify(r.body).slice(0, 90)}`,
  );
}

section("B. BUDGET IS REACHABLE EXACTLY WHEN ENTITLED");
for (const [id, owner, expected] of [
  ["B1", budgetOnly, true],
  ["B2", both, true],
  ["B3", edOnly, false],
  ["B4", neither, false],
]) {
  const r = await budgetOwner(owner, "session");
  const ok = expected ? r.statusCode === 200 : r.statusCode !== 200;
  check(
    `${id} Owner[${owner.label}] Budget -> ${expected ? "200" : "refused"}`,
    ok,
    `status=${r.statusCode} ${JSON.stringify(r.body).slice(0, 90)}`,
  );
}

section("C. OWNER ADMINISTRATION STAYS AVAILABLE REGARDLESS OF MODULES");
for (const [id, owner] of [
  ["C1", both],
  ["C2", edOnly],
  ["C3", budgetOnly],
  ["C4", neither],
]) {
  const users = await ownerGet(owner, "list_permission_users");
  const modules = await ownerGet(owner, "workspace_modules");
  check(
    `${id} Owner[${owner.label}] users + modules admin -> 200/200`,
    users.statusCode === 200 && modules.statusCode === 200,
    `users=${users.statusCode} modules=${modules.statusCode}`,
  );
}
const modulesOfNeither = await ownerGet(neither, "workspace_modules");
check(
  "C5 an unentitled workspace reports NO enabled module (nothing to show)",
  Array.isArray(modulesOfNeither.body) &&
    modulesOfNeither.body.filter((m) => m.enabled).length === 0,
  JSON.stringify(modulesOfNeither.body),
);

// ------------------------------------------------------ tenant isolation ----
section("D. NO CROSS-WORKSPACE ACCESS");
psql(
  `insert into public.election_day_voters (workspace_id, masad, first_name, last_name, street, house_number, city, coordinator)
   values ('${both.workspaceId}','M-BOTH','Voter','Both','St',1,'City','');`,
);
const edVoters = await ownerGet(edOnly, "list_voters");
check(
  "D1 an Owner's voter list contains only their OWN workspace's voters",
  edVoters.statusCode === 200 &&
    Array.isArray(edVoters.body) &&
    !JSON.stringify(edVoters.body).includes("M-BOTH"),
  `status=${edVoters.statusCode} rows=${Array.isArray(edVoters.body) ? edVoters.body.length : "?"}`,
);
const bothVoters = await ownerGet(both, "list_voters");
check(
  "D2 ... and the owning Owner DOES see it (the row really exists)",
  bothVoters.statusCode === 200 && JSON.stringify(bothVoters.body).includes("M-BOTH"),
  `status=${bothVoters.statusCode}`,
);
// The workspace is never taken from the request - it is re-resolved from the
// Owner's own JWT - so there is no parameter to point at another tenant.
const forged = await ownerPost(edOnly, {
  op: "list_voters",
  workspaceId: both.workspaceId,
});
check(
  "D3 naming another workspace in the body is refused outright",
  forged.statusCode === 400,
  `status=${forged.statusCode} ${JSON.stringify(forged.body).slice(0, 80)}`,
);

// ------------------------------------------------------- worker unchanged ---
section("E. EXISTING MANAGER / USER BEHAVIOUR IS UNCHANGED");
// The fixtures above insert workspaces directly, so they carry no seeded
// roles (that happens inside election_day_provision_workspace) - create the
// Manager role this worker needs.
psql(
  `insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
   values ('${both.workspaceId}','mgr', array['electionDay.manageRoles'], 'all', true);`,
);
const roleId = psql(
  `select id from public.election_day_roles where workspace_id='${both.workspaceId}' and is_manager limit 1;`,
).trim();
check("E0 the workspace has a Manager role", roleId.length > 0, roleId);
psql(
  `insert into public.election_day_permission_users (workspace_id, name, role_id, password_hash)
   values ('${both.workspaceId}','מנהל בדיקה','${roleId}', extensions.crypt('WorkerPw-9!', extensions.gen_salt('bf')));`,
);
const workerLogin = await callHandler(H.electionSession, {
  method: "POST",
  url: "/api/election-day/session",
  headers: { origin: ELECTION_ORIGIN, "content-type": "application/json" },
  body: { workspaceCode: both.code, name: "מנהל בדיקה", password: "WorkerPw-9!" },
});
check(
  "E1 a Manager still signs in on the worker endpoint",
  workerLogin.statusCode === 200,
  `status=${workerLogin.statusCode} ${JSON.stringify(workerLogin.body).slice(0, 100)}`,
);
const cookie = /__Host-kb_ed_session=([^;]+)/.exec(
  String(workerLogin.headers?.["set-cookie"] ?? ""),
)?.[1];
const workerVoters = await callHandler(H.actions, {
  method: "GET",
  url: "/api/election-day/actions?op=list_voters",
  headers: { origin: ELECTION_ORIGIN },
  cookies: { "__Host-kb_ed_session": cookie ?? "" },
});
check(
  "E2 the Manager still reads their workspace through the WORKER endpoint",
  workerVoters.statusCode === 200,
  `status=${workerVoters.statusCode}`,
);
const workerAsOwner = await callHandler(H.ownerActions, {
  method: "GET",
  url: "/api/election-day/owner-actions?op=list_voters",
  headers: { origin: ELECTION_ORIGIN },
  cookies: { "__Host-kb_ed_session": cookie ?? "" },
});
check(
  "E3 a worker cookie cannot drive the OWNER endpoint",
  workerAsOwner.statusCode === 401,
  `status=${workerAsOwner.statusCode}`,
);

tally("OWNER MODULE ACCESS");
