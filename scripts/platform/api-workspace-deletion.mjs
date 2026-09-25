// PERMANENT WORKSPACE DELETION - API suite.
//
// Drives the REAL bundled handlers (api/platform/session.ts and
// api/election-day/owner-actions.ts) against the isolated kolboxs5 scratch
// stack. The database contract itself is proven by
// scripts/platform/db-workspace-deletion.sql; this suite proves the parts only
// the HTTP boundary can prove:
//
//   * who may call it at all (no token, a wrong principal, a foreign Origin)
//   * that the typed confirmation is enforced by the SERVER, not the browser
//   * that the Budget guard reaches the caller as a refusal, with the
//     workspace still there afterwards
//   * that the Owner's Auth ACCOUNT is actually purged - a GoTrue fact the
//     database cannot assert - and that a SHARED account is not
//   * that an Owner who had real, working access to their workspace has none
//     afterwards, and that another Owner's access is untouched
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/platform/api-workspace-deletion.mjs
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import {
  admin,
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

const PLATFORM_ORIGIN = "https://platform.test";
const ELECTION_ORIGIN = "https://election.test";
process.env.PLATFORM_ALLOWED_ORIGIN = PLATFORM_ORIGIN;
process.env.OWNER_ALLOWED_ORIGIN = ELECTION_ORIGIN;
process.env.SESSION_ALLOWED_ORIGIN = ELECTION_ORIGIN;
process.env.KOLBOX_ELECTION_APP_BASE_URL = "http://127.0.0.1:5187";

const H = await buildHandlers();
const PS = H.platformSession;
const A = admin();
const DOMAIN = "wsdel-api.invalid";
// Usernames are unique GLOBALLY across the worker / election-owner /
// multi-entity realms, and this suite deliberately leaves one
// Budget-holding workspace behind - which keeps its worker username. So the
// fixture names carry this run's stamp rather than colliding with the
// suite's own previous run.
const stamp = Date.now();
const email = (l) => `${l}@${DOMAIN}`;

const auth = (t) => ({ authorization: `Bearer ${t}` });
const pPost = (body, token, origin = PLATFORM_ORIGIN) =>
  callHandler(PS, {
    method: "POST",
    url: "/api/platform/session",
    headers: {
      ...(token ? auth(token) : {}),
      origin,
      "content-type": "application/json",
    },
    body,
  });
const del = (workspaceId, confirmName, token, origin) =>
  pPost({ op: "delete_workspace", workspaceId, confirmName }, token, origin);
const ownerGet = (token, op) =>
  callHandler(H.ownerActions, {
    method: "GET",
    url: `/api/election-day/owner-actions?op=${encodeURIComponent(op)}`,
    headers: { origin: ELECTION_ORIGIN, authorization: `Bearer ${token}` },
  });

const code = () => psql("select public.election_day_generate_workspace_login_code();").trim();
const one = (sql) => psql(sql).trim();
/** Every row anywhere that still names this workspace. Same catalog sweep the
 * DB suite uses, written out here rather than asking the function under test. */
const owned = (ws) =>
  Number(
    one(`select coalesce(sum(n), 0) from (
      select (xpath('/row/c/text()',
        query_to_xml(format('select count(*) as c from %s where workspace_id = %L', c.oid::regclass, '${ws}'),
          false, true, '')))[1]::text::bigint as n
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'workspace_id'
                         and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and c.relname <> 'budget_workspace_deletions'
    ) s;`),
  );

// ------------------------------------------------------------- fixtures ----
section("FIXTURES");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  -- Deliberately NOT forced: a leftover WSDEL workspace that still holds Budget
  -- data is protected by the very guard this suite exists to prove, and a test
  -- fixture is the last place that should learn to get around it. Such a
  -- workspace is left where it is (its Owner and username go with the Auth
  -- account deleted below, so it is inert), and a stack reset clears it.
  delete from public.election_workspaces w
   where w.name like 'WSDEL %' and not public.budget_workspace_has_data(w.id);
`);
async function listUsers() {
  const out = [];
  for (let p = 1; p < 20; p++) {
    const { data, error } = await A.auth.admin.listUsers({ page: p, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
for (const u of await listUsers()) {
  if (u.email?.endsWith(`@${DOMAIN}`)) await A.auth.admin.deleteUser(u.id);
}

const PW = randomPassword();
const { data: poUser } = await A.auth.admin.createUser({
  email: email("po"),
  password: PW,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'WSDEL PO', '${email("po")}');`,
);
const PO = (await enrollTotp((await signIn(email("po"), PW)).client, "wsdel-po")).token;

/** A real Election Owner with a real workspace, a real username at the shared
 * login, a consumed approval, some data, and a real signed-in session. */
async function makeOwner(label, { withBudget = false } = {}) {
  const mail = email(`owner-${label}`);
  const { data, error } = await A.auth.admin.createUser({
    email: mail,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const authUserId = data.user.id;
  const lc = code();
  const ws = one(`insert into public.election_workspaces (name, login_code, election_end_at)
    values ('WSDEL ${label}', '${lc}', now() + interval '20 days') returning id;`);
  psql(`
    insert into public.election_owners (workspace_id, auth_user_id, name, email)
      values ('${ws}', '${authUserId}', 'WSDEL Owner ${label}', '${mail}');
    insert into public.election_workspace_modules (workspace_id, module_key)
      values ('${ws}', 'election_day')${withBudget ? `, ('${ws}', 'budget')` : ""};
    insert into public.election_workspace_pending_owner_access
      (auth_user_id, name, email, status, expires_at, consumed_at, created_at, requested_modules,
       approved_by_platform_owner_auth_user_id)
      values ('${authUserId}', 'WSDEL Owner ${label}', '${mail}', 'consumed',
              now() + interval '7 days', now(), now(), array['election_day'], '${poUser.user.id}');
    select public.auth_identity_assign('election_owner', 'wsdel-${label}-${stamp}', '${authUserId}', null, null);
    insert into public.election_day_voters (workspace_id, masad, first_name, last_name, city, street, house_number)
      values ('${ws}', 'WSDEL', '${label}', 'Voter', 'City', 'Street', 1);
  `);
  // A worker with a username and a live session, so "the workspace's rows" are
  // real access and not just list data.
  const role = one(`insert into public.election_day_roles (workspace_id, name, description, permissions, scope_type, is_manager)
    values ('${ws}', 'WSDEL Role ${label}', '', array['voter.viewName'], 'all', false) returning id;`);
  const worker = one(`insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
    values ('${ws}', 'WSDEL Worker ${label}', extensions.crypt('x', extensions.gen_salt('bf')), '${role}') returning id;`);
  psql(`
    select public.auth_identity_assign('worker', 'wsdel-worker-${label}-${stamp}', null, '${worker}', '${ws}');
    insert into public.election_day_sessions (permission_user_id, workspace_id, token_hash, expires_at)
      values ('${worker}', '${ws}', extensions.digest('wsdel-${label}-${stamp}', 'sha256'), now() + interval '1 day');
  `);
  const { token } = await signIn(mail, PW);
  return {
    label,
    mail,
    authUserId,
    workspaceId: ws,
    name: `WSDEL ${label}`,
    token,
    ownedAtStart: owned(ws),
  };
}

const A_WS = await makeOwner("Alpha");
const B_WS = await makeOwner("Beta");
const C_WS = await makeOwner("Gamma", { withBudget: true });

// Workspace Gamma holds real Budget data and has no export at all.
psql(`
  select set_config('kolbox.budget_actor',
    format('{"type":"owner","id":"%s","name":"Owner Gamma","workspace_id":"%s"}', '${C_WS.authUserId}', '${C_WS.workspaceId}'), false);
  insert into public.budget_settings (workspace_id) values ('${C_WS.workspaceId}');
  insert into public.budget_categories (workspace_id, name) values ('${C_WS.workspaceId}', 'WSDEL Category');
`);

check(
  "F1 three real Owners, three real workspaces, each holding rows across several tables",
  A_WS.ownedAtStart >= 6 && B_WS.ownedAtStart >= 6 && owned(C_WS.workspaceId) > C_WS.ownedAtStart,
  `alpha=${A_WS.ownedAtStart} beta=${B_WS.ownedAtStart} gamma=${owned(C_WS.workspaceId)}`,
);
const alphaAccessBefore = await ownerGet(A_WS.token, "workspace_modules");
const betaAccessBefore = await ownerGet(B_WS.token, "workspace_modules");
check(
  "F2 both Owners have REAL working access to their own workspace before anything is deleted",
  alphaAccessBefore.statusCode === 200 && betaAccessBefore.statusCode === 200,
  `alpha=${alphaAccessBefore.statusCode} beta=${betaAccessBefore.statusCode}`,
);
check(
  "F3 Gamma really holds Budget data",
  one(`select public.budget_workspace_has_data('${C_WS.workspaceId}');`) === "t",
  "has data",
);

// =========================================================================
section("A. WHO MAY CALL IT AT ALL");
// =========================================================================
const noToken = await del(A_WS.workspaceId, A_WS.name, null);
check("A1 no bearer token -> 401", noToken.statusCode === 401, JSON.stringify(noToken.body));
const ownerToken = await del(A_WS.workspaceId, A_WS.name, A_WS.token);
check(
  "A2 an ELECTION OWNER's own token -> 401 (this endpoint is the Platform Owner's alone)",
  ownerToken.statusCode === 401,
  JSON.stringify(ownerToken.body),
);
const foreign = await del(A_WS.workspaceId, A_WS.name, PO, "https://evil.invalid");
check(
  "A3 a foreign Origin -> 403, refused before the op is even looked at",
  foreign.statusCode === 403,
  JSON.stringify(foreign.body),
);
const extraKey = await pPost(
  { op: "delete_workspace", workspaceId: A_WS.workspaceId, confirmName: A_WS.name, force: true },
  PO,
);
check(
  "A4 an extra body key -> 400 (no 'force' or any other escape hatch exists)",
  extraKey.statusCode === 400,
  JSON.stringify(extraKey.body),
);
const badId = await del("not-a-uuid", A_WS.name, PO);
check("A5 a malformed workspace id -> 400", badId.statusCode === 400, JSON.stringify(badId.body));
const noName = await del(A_WS.workspaceId, "   ", PO);
check(
  "A6 a blank confirmation -> 400, refused before the database is touched",
  noName.statusCode === 400,
  JSON.stringify(noName.body),
);
check(
  "A7 every refusal so far left workspace Alpha exactly as it was - row for row",
  one(`select count(*) from public.election_workspaces where id = '${A_WS.workspaceId}';`) === "1" &&
    owned(A_WS.workspaceId) === A_WS.ownedAtStart,
  `owned=${owned(A_WS.workspaceId)} (was ${A_WS.ownedAtStart})`,
);

// =========================================================================
section("B. THE CONFIRMATION IS ENFORCED BY THE SERVER");
// =========================================================================
const wrongName = await del(A_WS.workspaceId, B_WS.name, PO);
check(
  "B1 another workspace's name -> 409 WORKSPACE_NAME_MISMATCH",
  wrongName.statusCode === 409 && wrongName.body?.error === "WORKSPACE_NAME_MISMATCH",
  `${wrongName.statusCode} ${JSON.stringify(wrongName.body)}`,
);
check(
  "B2 and NEITHER workspace was deleted",
  one(`select count(*) from public.election_workspaces where id in ('${A_WS.workspaceId}', '${B_WS.workspaceId}');`) === "2",
  "both there",
);
const caseName = await del(A_WS.workspaceId, A_WS.name.toLowerCase(), PO);
check(
  "B3 the name is matched exactly, not case-folded -> 409",
  caseName.statusCode === 409 && caseName.body?.error === "WORKSPACE_NAME_MISMATCH",
  JSON.stringify(caseName.body),
);
const spacedName = await del(A_WS.workspaceId, `  ${A_WS.name.replace(" ", "   ")}  `, PO);
check(
  "B4 typing whitespace differently is accepted - that is typing, not a different name",
  spacedName.statusCode === 200,
  `${spacedName.statusCode} ${JSON.stringify(spacedName.body)}`,
);

// =========================================================================
section("C. THE DELETION, AND WHAT IT DID");
// =========================================================================
check(
  "C1 the server reports the deletion and that the Owner's Auth account was purged",
  spacedName.body?.name === A_WS.name && spacedName.body?.authUserPurged === true,
  JSON.stringify(spacedName.body),
);
check(
  "C2 the workspace row is gone and NOTHING anywhere still names it",
  one(`select count(*) from public.election_workspaces where id = '${A_WS.workspaceId}';`) === "0" &&
    owned(A_WS.workspaceId) === 0,
  `owned=${owned(A_WS.workspaceId)}`,
);
check(
  "C3 the approval it was provisioned from is gone, and so is the Owner's username",
  one(`select count(*) from public.election_workspace_pending_owner_access where auth_user_id = '${A_WS.authUserId}';`) === "0" &&
    one(`select count(*) from public.auth_identities where auth_user_id = '${A_WS.authUserId}';`) === "0",
  "released",
);
const { data: goneUser, error: goneErr } = await A.auth.admin.getUserById(A_WS.authUserId);
check(
  "C4 the Auth ACCOUNT itself is really gone from the auth provider, not just from our tables",
  goneErr?.status === 404 || goneErr?.code === "user_not_found" || !goneUser?.user?.id,
  `err=${goneErr?.status ?? "none"} user=${goneUser?.user?.id ?? "none"}`,
);
check(
  "C5 exactly one immutable audit row, naming the workspace, its Owner and the acting Platform Owner",
  one(`select count(*) from public.platform_deletion_audit where workspace_id_snapshot = '${A_WS.workspaceId}';`) === "1" &&
    one(`select workspace_name_snapshot from public.platform_deletion_audit where workspace_id_snapshot = '${A_WS.workspaceId}';`) === A_WS.name &&
    one(`select acting_auth_user_id from public.platform_deletion_audit where workspace_id_snapshot = '${A_WS.workspaceId}';`) === poUser.user.id &&
    one(`select auth_user_orphaned from public.platform_deletion_audit where workspace_id_snapshot = '${A_WS.workspaceId}';`) === "t",
  "audit row",
);
const repeat = await del(A_WS.workspaceId, A_WS.name, PO);
check(
  "C6 deleting it again -> 404 WORKSPACE_NOT_FOUND, and no second audit row",
  repeat.statusCode === 404 &&
    one(`select count(*) from public.platform_deletion_audit where workspace_id_snapshot = '${A_WS.workspaceId}';`) === "1",
  `${repeat.statusCode} ${JSON.stringify(repeat.body)}`,
);

// =========================================================================
section("D. THE DELETED OWNER HAS NO ACCESS - AND ONLY THEY LOST IT");
// =========================================================================
const alphaAfter = await ownerGet(A_WS.token, "workspace_modules");
check(
  "D1 the deleted Owner's own session - which worked minutes ago - is now refused",
  alphaAfter.statusCode === 401 || alphaAfter.statusCode === 403,
  `${alphaAccessBefore.statusCode} -> ${alphaAfter.statusCode}`,
);
const alphaSignIn = await A.auth
  .signInWithPassword?.({ email: A_WS.mail, password: PW })
  .catch(() => null);
check(
  "D2 and they cannot sign in again - the account behind that session no longer exists",
  !alphaSignIn || !!alphaSignIn.error || !alphaSignIn.data?.session,
  alphaSignIn?.error?.message ? "refused" : "no session",
);
const betaAfter = await ownerGet(B_WS.token, "workspace_modules");
check(
  "D3 the OTHER Owner's session still works, on the same code path",
  betaAfter.statusCode === 200,
  String(betaAfter.statusCode),
);
check(
  "D4 workspace Beta is untouched - its row, its Owner, its approval, its username and every one of its rows",
  one(`select count(*) from public.election_workspaces where id = '${B_WS.workspaceId}';`) === "1" &&
    one(`select count(*) from public.election_owners where workspace_id = '${B_WS.workspaceId}';`) === "1" &&
    one(`select count(*) from public.election_workspace_pending_owner_access where auth_user_id = '${B_WS.authUserId}';`) === "1" &&
    one(`select count(*) from public.auth_identities where auth_user_id = '${B_WS.authUserId}';`) === "1" &&
    owned(B_WS.workspaceId) === B_WS.ownedAtStart,
  `owned=${owned(B_WS.workspaceId)} (was ${B_WS.ownedAtStart})`,
);

// =========================================================================
section("E. THE BUDGET GUARD REACHES THE CALLER AS A REFUSAL");
// =========================================================================
const gammaOwned = owned(C_WS.workspaceId);
const budgetRefused = await del(C_WS.workspaceId, C_WS.name, PO);
check(
  "E1 Budget data with no verified export -> 409 BUDGET_EXPORT_REQUIRED",
  budgetRefused.statusCode === 409 && budgetRefused.body?.error === "BUDGET_EXPORT_REQUIRED",
  `${budgetRefused.statusCode} ${JSON.stringify(budgetRefused.body)}`,
);
check(
  "E2 the refused deletion left workspace Gamma completely intact - row for row",
  one(`select count(*) from public.election_workspaces where id = '${C_WS.workspaceId}';`) === "1" &&
    owned(C_WS.workspaceId) === gammaOwned &&
    one(`select count(*) from public.budget_categories where workspace_id = '${C_WS.workspaceId}';`) === "1",
  `owned=${owned(C_WS.workspaceId)} (was ${gammaOwned})`,
);
check(
  "E3 including the approval and the username the deletion would have released",
  one(`select count(*) from public.election_workspace_pending_owner_access where auth_user_id = '${C_WS.authUserId}';`) === "1" &&
    one(`select count(*) from public.auth_identities where auth_user_id = '${C_WS.authUserId}';`) === "1",
  "rolled back",
);
check(
  "E4 and nothing was audited for a deletion that did not happen",
  one(`select count(*) from public.platform_deletion_audit where workspace_id_snapshot = '${C_WS.workspaceId}';`) === "0",
  "no audit",
);
const gammaAccess = await ownerGet(C_WS.token, "workspace_modules");
check(
  "E5 the Gamma Owner still has their access, because nothing was deleted",
  gammaAccess.statusCode === 200,
  String(gammaAccess.statusCode),
);

// =========================================================================
section("F. A SHARED AUTH ACCOUNT IS NEVER PURGED");
// =========================================================================
// Beta's account is ALSO made a Multi-Entity seat holder - the one state in
// which purging the account, or releasing its username, would be wrong.
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  insert into public.multi_entity_owner (auth_user_id, name, email)
    values ('${B_WS.authUserId}', 'WSDEL Shared', '${B_WS.mail}');
`);
const shared = await del(B_WS.workspaceId, B_WS.name, PO);
check(
  "F1 the workspace is still deleted, and completely",
  shared.statusCode === 200 &&
    one(`select count(*) from public.election_workspaces where id = '${B_WS.workspaceId}';`) === "0" &&
    owned(B_WS.workspaceId) === 0,
  `${shared.statusCode} owned=${owned(B_WS.workspaceId)}`,
);
check(
  "F2 but the server reports NO purge, and does not claim one",
  shared.body?.authUserPurged === false && !shared.body?.error,
  JSON.stringify(shared.body),
);
const { data: keptUser } = await A.auth.admin.getUserById(B_WS.authUserId);
check(
  "F3 the shared account still exists and keeps its username",
  keptUser?.user?.id === B_WS.authUserId &&
    one(`select count(*) from public.auth_identities where auth_user_id = '${B_WS.authUserId}';`) === "1",
  `user=${keptUser?.user?.id ? "present" : "gone"}`,
);
check(
  "F4 and the audit says so, rather than recording a purge that did not happen",
  one(`select auth_user_orphaned from public.platform_deletion_audit where workspace_id_snapshot = '${B_WS.workspaceId}';`) === "f",
  "not orphaned",
);

// =========================================================================
section("G. THE AUDIT IS OUT OF EVERY CALLER'S REACH");
// =========================================================================
const anonRead = await fetch(
  `${process.env.VITE_SUPABASE_URL}/rest/v1/platform_deletion_audit?select=id&limit=1`,
  {
    headers: {
      apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${process.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
  },
);
const svcRead = await fetch(
  `${process.env.VITE_SUPABASE_URL}/rest/v1/platform_deletion_audit?select=id&limit=1`,
  {
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    },
  },
);
check(
  "G1 the deletion record is not readable over the API by the browser key OR the server key",
  anonRead.status !== 200 && svcRead.status !== 200,
  `anon=${anonRead.status} service=${svcRead.status}`,
);
const svcRpc = await fetch(
  `${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/platform_workspace_row_counts`,
  {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SECRET_KEY,
      authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_workspace_id: C_WS.workspaceId }),
  },
);
check(
  "G2 the row-count helper is not callable over the API at all - it is internal to the deletion",
  svcRpc.status !== 200,
  String(svcRpc.status),
);

process.exitCode = tally("WORKSPACE DELETION API") === 0 ? 0 : 1;
