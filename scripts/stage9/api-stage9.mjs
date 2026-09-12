// Platform Stage 9 - REAL-LOCAL API suite: Election Owner administration +
// workspace module entitlements (migration 20260916000000 + the handler
// changes in api/platform/session.ts, api/election-day/owner-actions.ts,
// owner-reauth.ts, owner-roles.ts, session.ts, reauth.ts, permission-users.ts).
//
// Real GoTrue + real Postgres (the isolated kolboxs5 scratch stack), the REAL
// bundled handlers, a real password + TOTP/aal2 Platform Owner, real Election
// Owners onboarded through the real approval -> one-time link -> set password
// -> provision flow, and real PermissionUser (worker) sessions. Synthetic
// *@stage9-api.invalid identities only. No secret, token, proof, password or
// link is ever printed.
//
// Run:  S5_STACK_DIR=<scratch>/s9stack [S5_PORT_OFFSET=1000] node scripts/stage9/api-stage9.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
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
process.env.KOLBOX_ELECTION_APP_BASE_URL = ORIGIN;
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const H = await buildHandlers();
const a = admin();

const DOMAIN = "stage9-api.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const COOKIE = "__Host-kb_ed_session";

const auth = (t) => (t ? { authorization: `Bearer ${t}` } : {});
const pPost = (body, token) =>
  callHandler(H.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: { ...auth(token), origin: ORIGIN },
    body,
  });
const pGet = (url, token) =>
  callHandler(H.platformSession, { method: "GET", url, headers: auth(token) });
const oGet = (op, token, cookies) =>
  callHandler(H.ownerActions, {
    method: "GET",
    url: `/api/election-day/owner-actions?op=${op}`,
    headers: auth(token),
    cookies,
  });
const oPost = (body, token) =>
  callHandler(H.ownerActions, {
    method: "POST",
    url: "/api/election-day/owner-actions",
    headers: { ...auth(token), origin: ORIGIN },
    body,
  });
const resetRateLimits = () =>
  psql("delete from public.election_day_login_attempts;");

/** Mints a one-time Owner proof. The proof is returned to the caller's own
 * flow only and never printed. */
async function proof(token, password, action) {
  resetRateLimits(); // the suite makes far more step-ups than one window allows
  const r = await callHandler(H.ownerReauth, {
    method: "POST",
    url: "/api/election-day/owner-reauth",
    headers: { ...auth(token), origin: ORIGIN },
    body: { password, action },
  });
  return { status: r.statusCode, error: r.body?.error, value: r.body?.reauthProof ?? "" };
}
const ownerRoles = async (token) =>
  (await callHandler(H.ownerRoles, {
    method: "GET",
    url: "/api/election-day/owner-roles",
    headers: auth(token),
  })).body ?? [];
async function puLogin(code, name, password) {
  resetRateLimits();
  const r = await callHandler(H.electionSession, {
    method: "POST",
    url: "/api/election-day/session",
    headers: { origin: ORIGIN },
    body: { workspaceCode: code, name, password },
  });
  const sc = r.headers?.["set-cookie"];
  const raw = typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
  return { status: r.statusCode, error: r.body?.error, cookie: raw };
}
const puSessionStatus = async (cookie) =>
  (await callHandler(H.electionSession, {
    method: "GET",
    url: "/api/election-day/session",
    cookies: { [COOKIE]: cookie },
  })).statusCode;
const puListVoters = async (cookie) =>
  (await callHandler(H.actions, {
    method: "GET",
    url: "/api/election-day/actions?op=list_voters",
    cookies: { [COOKIE]: cookie },
  })).statusCode;
const th = (link) => {
  try {
    return new URL(link).searchParams.get("token_hash");
  } catch {
    return null;
  }
};

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
const usersWith = async (e) =>
  (await listUsers()).filter((u) => (u.email ?? "").toLowerCase() === e.toLowerCase());

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S9API %');
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S9API %';
`);
for (const u of await listUsers())
  if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);

const poPw = randomPassword();
const { data: po } = await a.auth.admin.createUser({
  email: email("po"),
  password: poPw,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${po.user.id}', 'S9 PO', '${email("po")}');`,
);
const PO = (await enrollTotp((await signIn(email("po"), poPw)).client, "s9-po")).token;
const PO_AAL1 = (await signIn(email("po"), poPw)).token;
check("SETUP Platform Owner aal2 ready", !!PO && !!PO_AAL1);

/** Real onboarding: approval (with modules) -> one-time link -> set password
 * -> sign in -> provision. Returns the Owner's credentials and workspace. */
async function onboardOwner(label, modules) {
  const addr = email(label);
  const appr = await pPost(
    { op: "create_owner_access", name: `S9 ${label}`, email: addr, modules },
    PO,
  );
  const c = anon();
  await c.auth.verifyOtp({ token_hash: th(appr.body?.activationLink), type: "recovery" });
  const pw = randomPassword();
  await c.auth.updateUser({ password: pw });
  await c.auth.signOut();
  const token = (await signIn(addr, pw)).token;
  const prov = await oPost(
    { op: "provision_workspace", workspaceName: `S9API ${label}`, electionEndAt: "2026-12-31T20:00:00Z" },
    token,
  );
  const wsId = prov.body?.workspace_id ?? null;
  const code = prov.body?.login_code ?? null;
  return { addr, pw, token, wsId, code, approval: appr, prov };
}
const modulesOf = (wsId) =>
  psql(`select coalesce(string_agg(module_key, ',' order by module_key), '') from public.election_workspace_modules where workspace_id = '${wsId}';`);

// ---------------------------------------------------------------------------
section("A. APPROVAL WITH EXPLICIT MODULES");
{
  const r1 = await pPost({ op: "create_owner_access", name: "no modules", email: email("nomod") }, PO);
  check("A1 approval WITHOUT modules -> 400 INVALID_MODULES", r1.statusCode === 400 && r1.body?.error === "INVALID_MODULES", `${r1.statusCode}`);
  const r2 = await pPost({ op: "create_owner_access", name: "empty", email: email("emptymod"), modules: [] }, PO);
  check("A2 approval with an EMPTY module list -> 400 INVALID_MODULES", r2.statusCode === 400 && r2.body?.error === "INVALID_MODULES");
  const r3 = await pPost({ op: "create_owner_access", name: "bad", email: email("badmod"), modules: ["not_a_module"] }, PO);
  check("A3 approval with an UNKNOWN module -> 400 INVALID_MODULES", r3.statusCode === 400 && r3.body?.error === "INVALID_MODULES");
  check("A4 none of the refused approvals created an Auth user or an approval row",
    (await usersWith(email("nomod"))).length === 0 &&
      (await usersWith(email("emptymod"))).length === 0 &&
      (await usersWith(email("badmod"))).length === 0 &&
      psql(`select count(*) from public.election_workspace_pending_owner_access where email in ('${email("nomod")}','${email("emptymod")}','${email("badmod")}')`) === "0");
  const r4 = await pPost({ op: "create_owner_access", name: "junk", email: email("junk"), modules: ["Bad Key!"] }, PO);
  check("A5 a syntactically invalid key is refused before any DB work (400)", r4.statusCode === 400);
  const r5 = await pPost({ op: "create_owner_access", name: "aal1", email: email("aal1"), modules: ["election_day"] }, PO_AAL1);
  check("A6 aal1 Platform Owner cannot approve (401)", r5.statusCode === 401);
}

// ---------------------------------------------------------------------------
section("B. ONBOARDING + ZERO-USER WORKSPACE RECOVERY");
const A = await onboardOwner("owner-a", ["election_day"]);
const B = await onboardOwner("owner-b", ["election_day", "budget"]);
const D = await onboardOwner("owner-d", ["budget"]);
check("B1 three Owners onboarded and provisioned (200, workspace + code)",
  [A, B, D].every((o) => o.prov.statusCode === 200 && o.wsId && o.code), [A, B, D].map((o) => o.prov.statusCode).join(","));
check("B2 each workspace received exactly the Platform Owner's module choice",
  modulesOf(A.wsId) === "election_day" && modulesOf(B.wsId) === "budget,election_day" && modulesOf(D.wsId) === "budget",
  `${modulesOf(A.wsId)} | ${modulesOf(B.wsId)} | ${modulesOf(D.wsId)}`);
check("B3 provisioning created ZERO PermissionUsers (no bootstrap user)",
  psql(`select count(*) from public.election_day_permission_users where workspace_id in ('${A.wsId}','${B.wsId}','${D.wsId}')`) === "0");
{
  // Sign out, sign back in: the Owner is a real Owner with an empty roster.
  const fresh = (await signIn(A.addr, A.pw)).token;
  const sess = await oGet("session", fresh);
  const st = await oGet("provisioning_state", fresh);
  const users = await oGet("list_permission_users", fresh);
  check("B4 after sign-out/sign-in the Owner resolves as a provisioned Owner (session 200)", sess.statusCode === 200 && sess.body?.workspaceId === A.wsId);
  check("B5 provisioning_state = provisioned with no users (a valid, recoverable state)",
    st.statusCode === 200 && st.body?.state === "provisioned" && st.body?.hasPermissionUsers === false && st.body?.loginCode === A.code);
  check("B6 Owner administration reads the empty roster (200, [])", users.statusCode === 200 && Array.isArray(users.body) && users.body.length === 0);
  const retry = await oPost({ op: "provision_workspace", workspaceName: "S9API again", electionEndAt: "2026-12-31T20:00:00Z" }, fresh);
  check("B7 a repeated provisioning call is idempotent (already_provisioned, same workspace)",
    retry.statusCode === 200 && retry.body?.already_provisioned === true && retry.body?.workspace_id === A.wsId);
}

// ---------------------------------------------------------------------------
section("C. OWNER USER MANAGEMENT");
const rolesA = await ownerRoles(A.token);
const mgrRoleA = rolesA.find((r) => r.name === "מנהל");
const opsRoleA = rolesA.find((r) => r.name === "טלפן/ית");
check("C0 Owner role read includes is_manager (מנהל=true, טלפן/ית=false)", mgrRoleA?.is_manager === true && opsRoleA?.is_manager === false);
const managerPw = randomPassword();
const ordinaryPw = randomPassword();
{
  const p = await proof(A.token, A.pw, "create_permission_user");
  check("C1 Owner step-up for create_permission_user -> 200", p.status === 200 && !!p.value);
  const r = await oPost({ op: "create_permission_user", reauthProof: p.value, name: "s9-manager", password: managerPw, roleId: mgrRoleA.id }, A.token);
  check("C2 Owner creates the FIRST Manager", r.statusCode === 200, `${r.statusCode} ${r.body?.error ?? ""}`);
  const again = await oPost({ op: "create_permission_user", reauthProof: p.value, name: "s9-other", password: managerPw, roleId: opsRoleA.id }, A.token);
  check("C3 the same proof cannot be used twice (401)", again.statusCode === 401);
  const p2 = await proof(A.token, A.pw, "create_permission_user");
  const r2 = await oPost({ op: "create_permission_user", reauthProof: p2.value, name: "s9-ordinary", password: ordinaryPw, roleId: opsRoleA.id }, A.token);
  check("C4 Owner creates an ordinary user", r2.statusCode === 200);
  const p3 = await proof(A.token, A.pw, "create_permission_user");
  const dup = await oPost({ op: "create_permission_user", reauthProof: p3.value, name: "s9-manager", password: "x", roleId: opsRoleA.id }, A.token);
  check("C5 a duplicate name -> 409 DUPLICATE_NAME", dup.statusCode === 409 && dup.body?.error === "DUPLICATE_NAME", `${dup.statusCode} ${dup.body?.error}`);
  const wrong = await proof(A.token, A.pw, "create_role");
  const r3 = await oPost({ op: "create_permission_user", reauthProof: wrong.value, name: "s9-x", password: "x", roleId: opsRoleA.id }, A.token);
  check("C6 a proof minted for another action is refused (401)", r3.statusCode === 401);
  const bad = await proof(A.token, "definitely-wrong-password", "create_permission_user");
  check("C7 a wrong Owner password mints no proof (401)", bad.status === 401 && !bad.value);
  const list = await oGet("list_permission_users", A.token);
  check("C8 the roster now lists exactly the two users", list.statusCode === 200 && list.body?.length === 2);
}
const usersA = (await oGet("list_permission_users", A.token)).body ?? [];
const managerA = usersA.find((u) => u.name === "s9-manager");
const ordinaryA = usersA.find((u) => u.name === "s9-ordinary");
{
  const p = await proof(A.token, A.pw, "reset_permission_user_password");
  const rm = await oPost({ op: "reset_permission_user_password", reauthProof: p.value, targetUserId: managerA.id, newPassword: "irrelevant-1" }, A.token);
  check("C9 Owner cannot reset a Manager-role user (409 CANNOT_RESET_MANAGER)", rm.statusCode === 409 && rm.body?.error === "CANNOT_RESET_MANAGER");
  const login0 = await puLogin(A.code, "s9-ordinary", ordinaryPw);
  const p2 = await proof(A.token, A.pw, "reset_permission_user_password");
  const newPw = randomPassword();
  const ro = await oPost({ op: "reset_permission_user_password", reauthProof: p2.value, targetUserId: ordinaryA.id, newPassword: newPw }, A.token);
  check("C10 Owner resets an ordinary user's password (200)", ro.statusCode === 200);
  check("C11 the reset revoked the user's live session (401) ...", login0.status === 200 && (await puSessionStatus(login0.cookie)) === 401);
  check("C12 ... the old password is dead and the new one works",
    (await puLogin(A.code, "s9-ordinary", ordinaryPw)).status === 401 &&
      (await puLogin(A.code, "s9-ordinary", newPw)).status === 200);
}

// ---------------------------------------------------------------------------
section("D. SAME-WORKSPACE ENFORCEMENT (Owner B vs workspace A)");
{
  const pd = await proof(B.token, B.pw, "delete_permission_user");
  const del = await oPost({ op: "delete_permission_user", reauthProof: pd.value, targetUserId: ordinaryA.id }, B.token);
  check("D1 Owner B cannot delete a user of workspace A (404 USER_NOT_FOUND)", del.statusCode === 404 && del.body?.error === "USER_NOT_FOUND");
  const pr = await proof(B.token, B.pw, "reset_permission_user_password");
  const rst = await oPost({ op: "reset_permission_user_password", reauthProof: pr.value, targetUserId: ordinaryA.id, newPassword: "hijack-1" }, B.token);
  check("D2 Owner B cannot reset a user of workspace A (404 USER_NOT_FOUND)", rst.statusCode === 404);
  const pc = await proof(B.token, B.pw, "create_permission_user");
  const cr = await oPost({ op: "create_permission_user", reauthProof: pc.value, name: "s9-intruder", password: "x", roleId: mgrRoleA.id }, B.token);
  check("D3 Owner B cannot create a user with a role of workspace A (404 ROLE_NOT_FOUND)", cr.statusCode === 404 && cr.body?.error === "ROLE_NOT_FOUND");
  const lb = await oGet("list_permission_users", B.token);
  check("D4 Owner B's roster shows none of workspace A's users", lb.statusCode === 200 && lb.body?.length === 0);
  const extra = await oPost({ op: "create_permission_user", reauthProof: pc.value, name: "s9-y", password: "x", roleId: mgrRoleA.id, workspaceId: A.wsId }, B.token);
  check("D5 a client-supplied workspaceId is rejected outright (400)", extra.statusCode === 400);
}

// ---------------------------------------------------------------------------
section("E. MANAGER / WORKER RESTRICTIONS (no Owner authority)");
const mgrLogin = await puLogin(A.code, "s9-manager", managerPw);
check("E0 the Manager signs in to Election Day normally", mgrLogin.status === 200 && !!mgrLogin.cookie);
{
  const ck = { [COOKIE]: mgrLogin.cookie };
  const g = await callHandler(H.permissionUsers, { method: "GET", url: "/api/election-day/permission-users", cookies: ck });
  const c = await callHandler(H.permissionUsers, { method: "POST", url: "/api/election-day/permission-users", headers: { origin: ORIGIN }, cookies: ck, body: { name: "x", password: "x", roleId: opsRoleA.id, reauthProof: "x" } });
  const d = await callHandler(H.permissionUsers, { method: "POST", url: "/api/election-day/permission-users?__pu_action=delete", headers: { origin: ORIGIN }, cookies: ck, body: { targetUserId: ordinaryA.id, reauthProof: "x" } });
  const r = await callHandler(H.permissionUsers, { method: "POST", url: "/api/election-day/permission-users?__pu_action=reset-password", headers: { origin: ORIGIN }, cookies: ck, body: { targetUserId: ordinaryA.id, newPassword: "x", reauthProof: "x" } });
  check("E1 worker roster/create/delete/reset endpoint -> 403 USER_MANAGEMENT_OWNER_ONLY for a Manager session",
    [g, c, d, r].every((x) => x.statusCode === 403 && x.body?.error === "USER_MANAGEMENT_OWNER_ONLY"), [g, c, d, r].map((x) => x.statusCode).join(","));
  const re = await callHandler(H.reauth, { method: "POST", url: "/api/election-day/reauth", headers: { origin: ORIGIN }, cookies: ck, body: { password: managerPw, action: "create_permission_user" } });
  check("E2 a Manager cannot even mint a user-management proof (400 INVALID_ACTION)", re.statusCode === 400 && re.body?.error === "INVALID_ACTION");
  const oa = await oGet("list_permission_users", null, ck);
  const oc = await oPost({ op: "create_permission_user", reauthProof: "x", name: "x", password: "x", roleId: opsRoleA.id }, mgrLogin.cookie);
  check("E3 a Manager session cannot reach the Owner user API (401, with or without its token as a bearer)", oa.statusCode === 401 && oc.statusCode === 401);
  const rolesGet = await callHandler(H.ownerRoles, { method: "GET", url: "/api/election-day/owner-roles", headers: auth(mgrLogin.cookie) });
  check("E4 a Manager session cannot reach Owner role management (401)", rolesGet.statusCode === 401);
  const opr = await callHandler(H.ownerReauth, { method: "POST", url: "/api/election-day/owner-reauth", headers: { ...auth(mgrLogin.cookie), origin: ORIGIN }, body: { password: managerPw, action: "create_permission_user" } });
  check("E5 a Manager cannot mint an OWNER proof (401)", opr.statusCode === 401);
}
{
  const svc = await a.rpc("election_day_create_permission_user_v3", { p_session_hash: "\\x00", p_reauth_proof_hash: "\\x00", p_name: "x", p_password: "x", p_role_id: opsRoleA.id });
  const svcDel = await a.rpc("election_day_delete_permission_user_v3", { p_session_hash: "\\x00", p_reauth_proof_hash: "\\x00", p_target_user_id: ordinaryA.id });
  const boot = await a.rpc("election_day_bootstrap_first_permission_user", { p_auth_user_id: po.user.id, p_reauth_proof_hash: "\\x00", p_name: "x", p_password: "x", p_role_id: opsRoleA.id });
  check("E6 even the service role can no longer run the worker create/delete or the bootstrap RPC (42501)",
    [svc, svcDel, boot].every((x) => x.error && x.error.code === "42501"), [svc, svcDel, boot].map((x) => x.error?.code).join(","));
  const an = await anon().rpc("election_day_create_permission_user_owner_v3", { p_auth_user_id: A.wsId, p_reauth_proof_hash: "\\x00", p_name: "x", p_password: "x", p_role_id: opsRoleA.id });
  check("E7 the anon key cannot call the Owner create RPC", !!an.error);
}

// ---------------------------------------------------------------------------
section("F. MODULE ENTITLEMENT ENFORCEMENT");
{
  const pd = await proof(D.token, D.pw, "create_permission_user");
  const rolesD = await ownerRoles(D.token);
  const cr = await oPost({ op: "create_permission_user", reauthProof: pd.value, name: "s9-d-user", password: ordinaryPw, roleId: rolesD.find((r) => r.name === "טלפן/ית").id }, D.token);
  check("F1 Budget-only workspace: Owner administration still works (create user 200)", cr.statusCode === 200);
  const lv = await oGet("list_voters", D.token);
  const lc = await oGet("list_coordinators", D.token);
  check("F2 Budget-only workspace: Owner Election Day data ops -> 403 MODULE_NOT_ENABLED",
    lv.statusCode === 403 && lv.body?.error === "MODULE_NOT_ENABLED" && lc.statusCode === 403, `${lv.statusCode},${lc.statusCode}`);
  const wm = await oGet("workspace_modules", D.token);
  check("F3 Owner module read shows budget on, election_day off",
    wm.statusCode === 200 && wm.body?.find((m) => m.module_key === "budget")?.enabled === true && wm.body?.find((m) => m.module_key === "election_day")?.enabled === false);
  const lg = await puLogin(D.code, "s9-d-user", ordinaryPw);
  check("F4 a worker with VALID credentials in a Budget-only workspace -> 403 MODULE_NOT_ENABLED, no cookie", lg.status === 403 && lg.error === "MODULE_NOT_ENABLED" && !lg.cookie);
  const lgBad = await puLogin(D.code, "s9-d-user", "wrong-password");
  check("F5 a WRONG password there is still the generic 401 (no entitlement oracle)", lgBad.status === 401);
  check("F6 Election-Day + Budget workspace (B): Owner Election Day data ops allowed (200)", (await oGet("list_voters", B.token)).statusCode === 200);
}
{
  // A: Election Day only -> works; Platform Owner removes it -> immediate lockout; restores -> works.
  const live = await puLogin(A.code, "s9-manager", managerPw);
  check("F7 Election-Day workspace: worker data op allowed (200)", live.status === 200 && (await puListVoters(live.cookie)) === 200);
  const off = await pPost({ op: "set_workspace_modules", workspaceId: A.wsId, modules: ["budget"] }, PO);
  check("F8 Platform Owner removes Election Day from workspace A (200)", off.statusCode === 200 && modulesOf(A.wsId) === "budget");
  check("F9 the worker's EXISTING session dies on its next request (session 401, data op 401)",
    (await puSessionStatus(live.cookie)) === 401 && (await puListVoters(live.cookie)) === 401);
  const relog = await puLogin(A.code, "s9-manager", managerPw);
  check("F10 new worker logins are refused (403 MODULE_NOT_ENABLED)", relog.status === 403 && relog.error === "MODULE_NOT_ENABLED");
  check("F11 the Owner's Election Day data ops are refused (403) while administration still works (200)",
    (await oGet("list_voters", A.token)).statusCode === 403 && (await oGet("list_permission_users", A.token)).statusCode === 200);
  const on = await pPost({ op: "set_workspace_modules", workspaceId: A.wsId, modules: ["election_day"] }, PO);
  const back = await puLogin(A.code, "s9-manager", managerPw);
  check("F12 restoring Election Day restores worker login (200)", on.statusCode === 200 && back.status === 200);
}

// ---------------------------------------------------------------------------
section("G. PLATFORM OWNER ENTITLEMENT READ / EDIT");
{
  const g = await pGet("/api/platform/session?op=workspace_modules", PO);
  const ws = g.body?.workspaces?.find((w) => w.workspace_id === B.wsId);
  check("G1 Platform read: catalog of 3 modules + each workspace's modules", g.statusCode === 200 && g.body?.catalog?.length === 3 && JSON.stringify(ws?.modules) === '["budget","election_day"]');
  check("G2 aal1 / stranger / Election Owner tokens cannot read entitlements (401)",
    (await pGet("/api/platform/session?op=workspace_modules", PO_AAL1)).statusCode === 401 &&
      (await pGet("/api/platform/session?op=workspace_modules", A.token)).statusCode === 401);
  const e1 = await pPost({ op: "set_workspace_modules", workspaceId: B.wsId, modules: [] }, PO);
  const e2 = await pPost({ op: "set_workspace_modules", workspaceId: B.wsId, modules: ["nope_module"] }, PO);
  const e3 = await pPost({ op: "set_workspace_modules", workspaceId: crypto.randomUUID(), modules: ["budget"] }, PO);
  const e4 = await pPost({ op: "set_workspace_modules", workspaceId: B.wsId, modules: ["budget"] }, A.token);
  const e5 = await pPost({ op: "set_workspace_modules", workspaceId: B.wsId, modules: ["budget"], extra: 1 }, PO);
  check("G3 edit refusals: empty 400, unknown 400, missing workspace 404, Election Owner 401, extra key 400",
    e1.statusCode === 400 && e2.statusCode === 400 && e3.statusCode === 404 && e4.statusCode === 401 && e5.statusCode === 400,
    [e1, e2, e3, e4, e5].map((x) => x.statusCode).join(","));
  check("G4 every refused edit left workspace B's entitlements unchanged", modulesOf(B.wsId) === "budget,election_day");
  const noOrigin = await callHandler(H.platformSession, { method: "POST", url: "/api/platform/session", headers: auth(PO), body: { op: "set_workspace_modules", workspaceId: B.wsId, modules: ["budget"] } });
  check("G5 an edit without the Platform Origin -> 403", noOrigin.statusCode === 403);
  const pend = await pPost({ op: "create_owner_access", name: "S9 pending", email: email("pending"), modules: ["voter_management", "election_day"] }, PO);
  const list = await pGet("/api/platform/session?op=owner_access", PO);
  const row = list.body?.approvals?.find((x) => x.pending_id === pend.body?.pendingId);
  check("G6 the approvals list shows the requested modules of a pending approval", JSON.stringify(row?.requested_modules) === '["election_day","voter_management"]');
}

// ---------------------------------------------------------------------------
section("H. ROLES: MANAGER FLAG (Owner-only)");
{
  const p = await proof(A.token, A.pw, "create_role");
  const cr = await callHandler(H.ownerRoles, { method: "POST", url: "/api/election-day/owner-roles", headers: { ...auth(A.token), origin: ORIGIN }, body: { op: "create", reauthProof: p.value, name: "S9 אזורי", description: "", permissions: ["voter.viewName"], scopeType: "all", isManager: true } });
  check("H1 Owner creates a role flagged as Manager", cr.statusCode === 200 && cr.body?.is_manager === true, `${cr.statusCode}`);
  const p2 = await proof(A.token, A.pw, "update_role");
  const up = await callHandler(H.ownerRoles, { method: "POST", url: "/api/election-day/owner-roles", headers: { ...auth(A.token), origin: ORIGIN }, body: { op: "update", reauthProof: p2.value, roleId: cr.body?.id, name: "S9 אזורי", description: "", permissions: ["voter.viewName"], scopeType: "all" } });
  check("H2 an update without isManager keeps the flag", up.statusCode === 200 && psql(`select is_manager from public.election_day_roles where id = '${cr.body?.id}'`) === "t");
  const p3 = await proof(A.token, A.pw, "update_role");
  const up2 = await callHandler(H.ownerRoles, { method: "POST", url: "/api/election-day/owner-roles", headers: { ...auth(A.token), origin: ORIGIN }, body: { op: "update", reauthProof: p3.value, roleId: cr.body?.id, name: "S9 אזורי", description: "", permissions: ["voter.viewName"], scopeType: "all", isManager: false } });
  check("H3 an update with isManager=false clears it", up2.statusCode === 200 && up2.body?.is_manager === false);
}

// ---------------------------------------------------------------------------
section("I. REMOVED BOOTSTRAP + IDENTITY INVARIANTS");
{
  const b1 = await oPost({ op: "bootstrap_first_user", reauthProof: "x", name: "x", password: "x", roleId: opsRoleA.id }, A.token);
  check("I1 the bootstrap_first_user op no longer exists (400)", b1.statusCode === 400);
  const b2 = await callHandler(H.ownerReauth, { method: "POST", url: "/api/election-day/owner-reauth", headers: { ...auth(A.token), origin: ORIGIN }, body: { password: A.pw, action: "bootstrap_first_user" } });
  check("I2 no proof can be minted for bootstrap_first_user (400 INVALID_ACTION)", b2.statusCode === 400 && b2.body?.error === "INVALID_ACTION");
  const owners = psql(`select string_agg(c::text, ',') from (select count(*) c from public.election_owners where workspace_id in ('${A.wsId}','${B.wsId}','${D.wsId}') group by workspace_id) x`);
  check("I3 exactly one Owner per workspace", owners === "1,1,1", owners);
  const dup = psql(`select count(*) from public.election_day_permission_users u join public.election_owners o on o.workspace_id = u.workspace_id where lower(u.name) in (lower(o.email), lower(o.name))`);
  check("I4 no PermissionUser duplicates an Owner identity", dup === "0");
  check("I5 exactly one Auth account per onboarded Owner",
    (await usersWith(A.addr)).length === 1 && (await usersWith(B.addr)).length === 1 && (await usersWith(D.addr)).length === 1);
  check("I6 the Owner's own password still works after every operation (no lockout)",
    !(await anon().auth.signInWithPassword({ email: A.addr, password: A.pw })).error);
}
{
  const p = await proof(A.token, A.pw, "delete_permission_user");
  const d1 = await oPost({ op: "delete_permission_user", reauthProof: p.value, targetUserId: ordinaryA.id }, A.token);
  const p2 = await proof(A.token, A.pw, "delete_permission_user");
  const d2 = await oPost({ op: "delete_permission_user", reauthProof: p2.value, targetUserId: managerA.id }, A.token);
  check("I7 Owner deletes an ordinary user and a Manager (200, 200)", d1.statusCode === 200 && d2.statusCode === 200);
  check("I8 workspace A is back to zero users and still administrable",
    (await oGet("list_permission_users", A.token)).body?.length === 0 && (await oGet("session", A.token)).statusCode === 200);
}

// ---------------------------------------------------------------------------
section("J. ENTITLEMENT AUDIT (append-only, attributed, atomic with the change)");
{
  const auditOf = (where) =>
    psql(`select count(*) from public.platform_entitlement_audit where ${where};`);
  const aPending = psql(`select id from public.election_workspace_pending_owner_access where email = '${A.addr}';`);
  const aOwner = psql(`select auth_user_id from public.election_owners where workspace_id = '${A.wsId}';`);
  check("J1 approval_selected for Owner A's approval: election_day, attributed to the Platform Owner",
    auditOf(`pending_access_id_snapshot = '${aPending}' and action = 'approval_selected' and module_key = 'election_day' and acting_platform_owner_auth_user_id = '${po.user.id}'`) === "1");
  check("J2 provisioning_granted for workspace A: attributed to the approving Platform Owner, executed by Owner A",
    auditOf(`workspace_id_snapshot = '${A.wsId}' and action = 'provisioning_granted' and module_key = 'election_day' and acting_platform_owner_auth_user_id = '${po.user.id}' and acting_auth_user_id = '${aOwner}'`) === "1");
  check("J3 the F8/F12 edits are audited exactly (Election Day disabled then re-enabled; budget enabled then disabled)",
    auditOf(`workspace_id_snapshot = '${A.wsId}' and action = 'disabled' and module_key = 'election_day'`) === "1" &&
      auditOf(`workspace_id_snapshot = '${A.wsId}' and action = 'enabled' and module_key = 'election_day'`) === "1" &&
      auditOf(`workspace_id_snapshot = '${A.wsId}' and action = 'enabled' and module_key = 'budget'`) === "1" &&
      auditOf(`workspace_id_snapshot = '${A.wsId}' and action = 'disabled' and module_key = 'budget'`) === "1");
  check("J4 refused edits (G3) left no audit row on workspace B",
    auditOf(`workspace_id_snapshot = '${B.wsId}' and action in ('enabled', 'disabled')`) === "0");
  const upd = psql(`
    create function pg_temp.s9_try_update() returns text language plpgsql as $f$
    begin
      update public.platform_entitlement_audit set module_key = 'x';
      return 'UPDATED';
    exception when others then
      return sqlerrm;
    end $f$;
    select pg_temp.s9_try_update();`);
  check("J5 the audit cannot be rewritten (UPDATE refused with AUDIT_IMMUTABLE)", upd === "AUDIT_IMMUTABLE", upd);
  const six = await a.rpc("platform_create_pending_owner_access", {
    p_platform_owner_auth_user_id: po.user.id, p_auth_user_id: po.user.id, p_name: "x",
    p_email: email("x6"), p_phone: null, p_expires_in_days: 7,
  });
  check("J6 the 6-argument (module-less) approval function is callable by no server role (42501)", six.error?.code === "42501", six.error?.code ?? "no error");
}

// ---------------------------------------------------------------------------
section("K. LEGACY APPROVAL WITHOUT MODULES FAILS CLOSED");
{
  const addr = email("legacy");
  const lpw = randomPassword();
  const { data: lu } = await a.auth.admin.createUser({ email: addr, password: lpw, email_confirm: true });
  psql(`insert into public.election_workspace_pending_owner_access (auth_user_id, name, email, status, expires_at) values ('${lu.user.id}', 'S9 legacy', '${addr}', 'pending', now() + interval '3 days');`);
  const ltok = (await signIn(addr, lpw)).token;
  const st = await oGet("provisioning_state", ltok);
  const wsBefore = psql("select count(*) from public.election_workspaces;");
  const prov = await oPost({ op: "provision_workspace", workspaceName: "S9API legacy", electionEndAt: "2026-12-31T20:00:00Z" }, ltok);
  check("K1 the legacy approval is still recognised as pending (the Owner can sign in)", st.statusCode === 200 && st.body?.state === "pending");
  check("K2 provisioning it -> 409 APPROVAL_MODULES_MISSING", prov.statusCode === 409 && prov.body?.error === "APPROVAL_MODULES_MISSING", `${prov.statusCode} ${prov.body?.error}`);
  check("K3 nothing was created or inferred (no workspace, no Owner, approval still pending)",
    psql("select count(*) from public.election_workspaces;") === wsBefore &&
      psql(`select count(*) from public.election_owners where auth_user_id = '${lu.user.id}';`) === "0" &&
      psql(`select status from public.election_workspace_pending_owner_access where auth_user_id = '${lu.user.id}';`) === "pending");
}

// ---------------------------------------------------------------------------
section("L. MULTI-ENTITY: A WORKSPACE WITHOUT ELECTION DAY IS UNAVAILABLE, NO COUNTS");
{
  const me = await pPost({ op: "provision_multi_entity_owner", name: "S9 Seat", email: email("me") }, PO);
  const setup = anon();
  await setup.auth.verifyOtp({ token_hash: new URL(me.body?.activationLink).searchParams.get("token_hash"), type: "recovery" });
  const mePw = randomPassword();
  await setup.auth.updateUser({ password: mePw });
  await setup.auth.signOut();
  const ME = (await enrollTotp((await signIn(email("me"), mePw)).client, "s9-me")).token;
  // D (Budget only) and B (Election Day + Budget), 12 contacts each.
  for (const ws of [D.wsId, B.wsId]) {
    psql(`insert into public.election_day_voters (workspace_id, first_name, last_name, voted) select '${ws}', 'S9API', 'v' || g, g <= 5 from generate_series(1, 12) g;`);
    await pPost({ op: "assign_workspace", workspaceId: ws }, PO);
  }
  const agg = await callHandler(H.platformSession, { method: "GET", url: "/api/platform/session?me_op=aggregates", headers: auth(ME) });
  const rows = agg.body?.workspaces ?? [];
  const dRow = rows.find((w) => w.workspaceId === D.wsId);
  const bRow = rows.find((w) => w.workspaceId === B.wsId);
  check("L1 both assigned workspaces are represented", agg.statusCode === 200 && rows.length === 2, `${agg.statusCode} rows=${rows.length}`);
  check("L2 the Budget-only workspace is 'unavailable' with metrics null", dRow?.status === "unavailable" && dRow?.metrics === null);
  check("L3 the Election Day workspace reports its counts", bRow?.status === "reported" && bRow?.metrics?.contactsTotal === 12 && bRow?.metrics?.voted === 5);
  check("L4 totals count the unavailable workspace but include none of its contacts",
    agg.body?.totals?.unavailableWorkspaceCount === 1 && agg.body?.totals?.reportedWorkspaceCount === 1 && agg.body?.totals?.metrics?.contactsTotal === 12);
  const one = await callHandler(H.platformSession, { method: "GET", url: `/api/platform/session?me_op=workspace_aggregates&workspaceId=${D.wsId}`, headers: auth(ME) });
  check("L5 the single-workspace read is 'unavailable' with metrics null too", one.statusCode === 200 && one.body?.status === "unavailable" && one.body?.metrics === null, `${one.statusCode}`);
  psql(`delete from public.multi_entity_assignments; delete from public.multi_entity_owner;`);
}

section("CLEANUP");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_day_voters where workspace_id in (select id from public.election_workspaces where name like 'S9API %');
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.election_workspaces where name like 'S9API %';
  delete from public.platform_owners;
  delete from public.election_day_login_attempts;
`);
for (const u of await listUsers())
  if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);

process.exit(tally("STAGE 9 API") > 0 ? 1 : 0);
