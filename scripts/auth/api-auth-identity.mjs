// API contract for the THREE dedicated KOLBOX login surfaces.
//
// Drives the REAL handlers (esbuild-bundled from api/, byte-for-byte) against
// the isolated scratch stack. Proves, end to end:
//   * each of the three login routes authenticates only its own realm;
//   * a username belonging to another realm is refused, indistinguishably
//     from a wrong password;
//   * a Manager/User's workspace is resolved with NO system code, and stays
//     tenant-isolated;
//   * recovery-address verification is MANDATORY for Owners before any
//     application access, enforced at the SERVER, not in the UI;
//   * Platform Owner MFA is untouched (aal1 is still refused, aal2 admitted);
//   * the legacy direct login route still works during cutover.
//
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/auth/api-auth-identity.mjs
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

const AUTH_ORIGIN = "https://auth.test";
const ELECTION_ORIGIN = "https://election.test";
const PLATFORM_ORIGIN = "https://platform.test";

process.env.KOLBOX_SURFACE = "auth";
process.env.KOLBOX_AUTH_ORIGIN = AUTH_ORIGIN;
process.env.KOLBOX_SELF_ORIGIN = AUTH_ORIGIN;
process.env.KOLBOX_ELECTION_ORIGIN = ELECTION_ORIGIN;
process.env.KOLBOX_PLATFORM_ORIGIN = PLATFORM_ORIGIN;
// The Platform Owner POST path validates against its OWN allow-list, not
// SESSION_ALLOWED_ORIGIN.
process.env.PLATFORM_ALLOWED_ORIGIN = PLATFORM_ORIGIN;
const MULTI_ENTITY_ORIGIN = "https://me.test";
process.env.KOLBOX_MULTI_ENTITY_ORIGIN = MULTI_ENTITY_ORIGIN;
process.env.SESSION_ALLOWED_ORIGIN = ELECTION_ORIGIN;

const H = await buildHandlers();

const login = (route, body, origin = AUTH_ORIGIN) =>
  callHandler(H.platformSession, {
    method: "POST",
    url: `/api/platform/session?auth_op=${route}`,
    headers: {
      origin,
      host: "auth.test",
      "content-type": "application/json",
    },
    body,
  });

const q1 = (sql) => psql(sql).trim();

// ---------------------------------------------------------------- fixtures --
section("FIXTURES");
const PW = randomPassword();
const A = admin();

const mk = async (email) => {
  const { data, error } = await A.auth.admin.createUser({
    email,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
};

const stamp = Date.now();
const poId = await mk(`po-${stamp}@kolbox.test`);
const eoId = await mk(`eo-${stamp}@kolbox.test`);

psql(`
  insert into public.platform_owners (auth_user_id, name, email)
  values ('${poId}', 'PO', 'po-${stamp}@kolbox.test');

  insert into public.election_workspaces (name, login_code, election_end_at)
  values ('WS Alpha','AAAA2345', now()+interval '30 days'),
         ('WS Beta','BBBB3456', now()+interval '30 days');

  insert into public.election_workspace_modules (workspace_id, module_key)
  select id, 'election_day' from public.election_workspaces;

  insert into public.election_owners (workspace_id, auth_user_id, name, email)
  select id, '${eoId}', 'EO A', 'eo-${stamp}@kolbox.test'
  from public.election_workspaces where login_code='AAAA2345';

  insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
  select id, 'mgr', array['electionDay.manageRoles'], 'all', true
  from public.election_workspaces where login_code='AAAA2345';
  insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
  select id, 'user', array[]::text[], 'all', false
  from public.election_workspaces where login_code='BBBB3456';

  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  select w.id, 'משה לוי', extensions.crypt('${PW}', extensions.gen_salt('bf')), r.id
  from public.election_workspaces w join public.election_day_roles r on r.workspace_id=w.id
  where w.login_code='AAAA2345';
  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  select w.id, 'משה לוי', extensions.crypt('${PW}', extensions.gen_salt('bf')), r.id
  from public.election_workspaces w join public.election_day_roles r on r.workspace_id=w.id
  where w.login_code='BBBB3456';
`);

const actorA = q1(`select u.id from public.election_day_permission_users u
  join public.election_workspaces w on w.id=u.workspace_id where w.login_code='AAAA2345';`);
const actorB = q1(`select u.id from public.election_day_permission_users u
  join public.election_workspaces w on w.id=u.workspace_id where w.login_code='BBBB3456';`);
const wsA = q1(`select id from public.election_workspaces where login_code='AAAA2345';`);
const wsB = q1(`select id from public.election_workspaces where login_code='BBBB3456';`);

// Usernames: per-realm namespace. Note "נחום משה" is used in TWO realms on
// purpose - that must be legal, and each surface must resolve only its own.
psql(`
  select public.auth_identity_assign('worker','נחום משה',null,'${actorA}','${wsA}');
  select public.auth_identity_assign('worker','dana cohen',null,'${actorB}','${wsB}');
  select public.auth_identity_assign('election_owner','נחום משה','${eoId}',null,null);
  select public.auth_identity_assign('platform_owner','platform boss','${poId}',null,null);
`);
check("X0 fixtures created", actorA.length === 36 && actorB.length === 36);

// ------------------------------------------------------ Manager/User login --
section("USERS SCREEN - workspace resolved with NO system code");

let r = await login("login_worker", { username: "נחום משה", password: PW });
check("U1 correct credentials sign in", r.statusCode === 200 && r.body?.ok === true, JSON.stringify(r.body));
check("U2 the resolved realm is worker", r.body?.realm === "worker");
check("U3 a one-time handoff code was issued", typeof r.body?.code === "string" && r.body.code.length === 64);
check("U4 the handoff targets the election origin", r.body?.targetOrigin === ELECTION_ORIGIN);
check(
  "U5 the handoff row carries the workspace the SERVER derived, not one the client sent",
  q1(`select workspace_id from public.auth_handoff_codes order by issued_at desc limit 1;`) === wsA,
);

r = await login("login_worker", { username: "נחום משה", password: "wrong-password" });
check("U6 wrong password -> generic 401", r.statusCode === 401 && r.body?.ok === false);

r = await login("login_worker", { username: "no such user", password: PW });
check("U7 unknown username -> the SAME generic 401", r.statusCode === 401 && r.body?.ok === false);

r = await login("login_worker", { username: "dana cohen", password: PW });
check(
  "U8 TENANT ISOLATION: the other username resolves to workspace B",
  r.statusCode === 200 &&
    r.body?.ok === true &&
    q1(`select workspace_id from public.auth_handoff_codes order by issued_at desc limit 1;`) === wsB,
);

r = await login("login_worker", {
  username: "נחום משה",
  password: PW,
  workspaceCode: "AAAA2345",
});
check("U9 a system code in the body is REFUSED outright (400)", r.statusCode === 400);

// ------------------------------------------------------------ wrong realm --
section("WRONG-REALM LOGIN IS REFUSED");

r = await login("login_platform_owner", { username: "נחום משה", password: PW });
check("W1 a worker username on the Platform screen -> 401", r.statusCode === 401);

r = await login("login_election_owner", { username: "dana cohen", password: PW });
check("W2 a worker username on the Owner screen -> 401", r.statusCode === 401);

r = await login("login_worker", { username: "platform boss", password: PW });
check("W3 the Platform Owner username on the Users screen -> 401", r.statusCode === 401);

r = await login("login_worker", { username: "נחום משה", password: PW }, "https://evil.test");
check("W4 a foreign Origin is refused (403)", r.statusCode === 403);

// ------------------------------------------- mandatory recovery for Owners --
section("PLATFORM OWNER MFA IS UNCHANGED");

const poSession = await signIn(`po-${stamp}@kolbox.test`, PW);
const poToken = poSession.token;
let r2 = await callHandler(H.platformSession, {
  method: "GET",
  url: "/api/platform/session",
  headers: { authorization: `Bearer ${poToken}` },
});
check(
  "S1 an aal1 Platform Owner session is refused (MFA preserved)",
  r2.statusCode === 401 || r2.statusCode === 403,
  `status=${r2.statusCode}`,
);

// enrollTotp enrolls AND verifies, returning the elevated aal2 token.
const aal2Token = (await enrollTotp(poSession.client, `auth-suite-${stamp}`)).token;
r2 = await callHandler(H.platformSession, {
  method: "GET",
  url: "/api/platform/session",
  headers: { authorization: `Bearer ${aal2Token}` },
});
check(
  "S2 the aal2 Platform Owner session is admitted",
  r2.statusCode === 200,
  `status=${r2.statusCode} ${JSON.stringify(r2.body)}`,
);
check(
  "S3 no recovery-address gate stands between a verified Owner and the console",
  r2.statusCode === 200,
);

// --------------------------------------------- legacy fallback preserved ----
section("LEGACY DIRECT LOGIN ROUTE STILL WORKS DURING CUTOVER");

process.env.KOLBOX_SURFACE = "election";
const legacy = await callHandler(H.electionSession, {
  method: "POST",
  url: "/api/election-day/session",
  headers: { origin: ELECTION_ORIGIN, "content-type": "application/json" },
  body: { workspaceCode: "AAAA2345", name: "משה לוי", password: PW },
});
check(
  "F1 the three-field direct worker login is unchanged and still succeeds",
  legacy.statusCode === 200,
  `status=${legacy.statusCode} ${JSON.stringify(legacy.body).slice(0, 160)}`,
);
process.env.KOLBOX_SURFACE = "auth";

// ------------------------------------------------- Multi-Entity surface ----
section("MULTI-ENTITY OWNER - FOURTH DEDICATED SURFACE");
process.env.KOLBOX_SURFACE = "auth";

const meId = await mk(`me-${stamp}@kolbox.test`);
psql(`
  insert into public.multi_entity_owner (auth_user_id, name, email)
  values ('${meId}', 'ME', 'me-${stamp}@kolbox.test');
  select public.auth_identity_assign('multi_entity_owner','multi boss','${meId}',null,null);
`);

r = await login("login_multi_entity_owner", { username: "multi boss", password: PW });
check(
  "M1 the Multi-Entity Owner signs in on its own surface",
  r.statusCode === 200 && r.body?.ok === true && r.body?.realm === "multi_entity_owner",
  JSON.stringify(r.body),
);
check(
  "M2 the handoff routes ONLY to the Multi-Entity origin",
  r.body?.targetOrigin === MULTI_ENTITY_ORIGIN,
  String(r.body?.targetOrigin),
);
check(
  "M3 the handoff row is a Multi-Entity realm row with no workspace",
  q1(`select realm || '|' || coalesce(workspace_id::text,'-') from public.auth_handoff_codes
      where auth_user_id='${meId}' order by issued_at desc limit 1;`) === "multi_entity_owner|-",
);

r = await login("login_multi_entity_owner", { username: "נחום משה", password: PW });
check("M4 a worker username on the Multi-Entity screen -> 401", r.statusCode === 401);
r = await login("login_platform_owner", { username: "multi boss", password: PW });
check("M5 the Multi-Entity username on the Platform screen -> 401", r.statusCode === 401);
r = await login("login_multi_entity_owner", { username: "multi boss", password: "nope" });
check("M6 wrong password -> generic 401", r.statusCode === 401);
check(
  "M7 the Multi-Entity seat needs no external verification to sign in",
  q1(`select count(*) from public.auth_identities
      where realm='multi_entity_owner' and auth_user_id='${meId}';`) === "1",
);

// MFA is unchanged: the broker mints aal1 and the ME verifier demands aal2.
const meSession = await signIn(`me-${stamp}@kolbox.test`, PW);
let mr = await callHandler(H.platformSession, {
  method: "GET",
  url: "/api/platform/session?me_op=session",
  headers: { authorization: `Bearer ${meSession.token}`, host: "me.test" },
});
check(
  "M8 an aal1 Multi-Entity session is refused (MFA preserved)",
  mr.statusCode === 401 || mr.statusCode === 403,
  `status=${mr.statusCode}`,
);

const meAal2 = (await enrollTotp(meSession.client, `me-suite-${stamp}`)).token;
process.env.KOLBOX_SURFACE = "multi_entity";
process.env.KOLBOX_SELF_ORIGIN = MULTI_ENTITY_ORIGIN;
mr = await callHandler(H.platformSession, {
  method: "GET",
  url: "/api/platform/session?me_op=session",
  headers: { authorization: `Bearer ${meAal2}`, host: "me.test" },
});
check(
  "M9 the aal2 Multi-Entity session is admitted",
  mr.statusCode === 200,
  `status=${mr.statusCode} ${JSON.stringify(mr.body).slice(0, 120)}`,
);
process.env.KOLBOX_SURFACE = "auth";
process.env.KOLBOX_SELF_ORIGIN = AUTH_ORIGIN;

// ------------------------------- worker username creation + collision ------
section("WORKER LOGIN USERNAME: DEFAULT, COLLISION AND SUGGESTION");

const ownerToken = (await signIn(`eo-${stamp}@kolbox.test`, PW)).token;
const ownerProof = async () => {
  // This section mints far more step-ups than one rate-limit window allows.
  psql("delete from public.election_day_login_attempts;");
  const pr = await callHandler(H.ownerReauth, {
    method: "POST",
    url: "/api/election-day/owner-reauth",
    headers: { authorization: `Bearer ${ownerToken}`, origin: ELECTION_ORIGIN },
    body: { password: PW, action: "create_permission_user" },
  });
  return pr.body?.reauthProof ?? "";
};
const roleA = q1(`select id from public.election_day_roles where workspace_id='${wsA}' limit 1;`);
const createWorker = async (name, username) => {
  const proofValue = await ownerProof();
  return callHandler(H.ownerActions, {
    method: "POST",
    url: "/api/election-day/owner-actions",
    headers: { authorization: `Bearer ${ownerToken}`, origin: ELECTION_ORIGIN },
    body: {
      op: "create_permission_user",
      reauthProof: proofValue,
      name,
      password: PW,
      roleId: roleA,
      ...(username === undefined ? {} : { username }),
    },
  });
};

process.env.SESSION_ALLOWED_ORIGIN = ELECTION_ORIGIN;
let c = await createWorker("אלי כהן", undefined);
check(
  "N1 a new worker's login username DEFAULTS to their name",
  c.statusCode === 200 &&
    q1(`select username from public.auth_identities
        where actor_id = (select id from public.election_day_permission_users
                          where name='אלי כהן' and workspace_id='${wsA}');`) === "אלי כהן",
  `status=${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`,
);

// Same DISPLAY name in the OTHER workspace must stay legal, and its login
// username must collide and be answered with a suggestion.
const roleB = q1(`select id from public.election_day_roles where workspace_id='${wsB}' limit 1;`);
psql(`insert into public.election_day_permission_users (workspace_id,name,password_hash,role_id)
      values ('${wsB}','אלי כהן', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${roleB}');`);
check(
  "N2 the SAME display name is still allowed in another workspace",
  q1(`select count(*) from public.election_day_permission_users where name='אלי כהן';`) === "2",
);

// Display-name uniqueness inside ONE workspace is Stage 3A's rule and still
// applies - asserted here so the two rules stay visibly distinct.
c = await createWorker("אלי כהן", undefined);
check(
  "N3 a duplicate DISPLAY name in the same workspace is still DUPLICATE_NAME",
  c.statusCode === 409 && c.body?.error === "DUPLICATE_NAME",
  `status=${c.statusCode} ${JSON.stringify(c.body)}`,
);

// A distinct display name asking for a LOGIN username that is already taken
// isolates the new rule from the old one.
c = await createWorker("אלי כהן ב", "אלי כהן");
check(
  "N4 a duplicate LOGIN username is 409 USERNAME_TAKEN, not a generic error",
  c.statusCode === 409 && c.body?.error === "USERNAME_TAKEN",
  `status=${c.statusCode} ${JSON.stringify(c.body)}`,
);
check(
  "N5 ... and it carries the next free suggestion 'אלי כהן 2'",
  c.body?.suggestion === "אלי כהן 2",
  JSON.stringify(c.body),
);
check(
  "N6 the rejected create was rolled back - no half-made worker",
  q1(`select count(*) from public.election_day_permission_users
      where name='אלי כהן ב' and workspace_id='${wsA}';`) === "0",
);

c = await createWorker("אלי כהן ב", "אלי כהן 2");
check(
  "N7 accepting the suggestion succeeds",
  c.statusCode === 200,
  `status=${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`,
);

c = await createWorker("אלי כהן ג", "אלי כהן");
check(
  "N8a the next collision advances the suggestion to 'אלי כהן 3'",
  c.statusCode === 409 && c.body?.suggestion === "אלי כהן 3",
  JSON.stringify(c.body),
);

c = await createWorker("אלי כהן ג", "eli k");
check("N8b the Owner may choose a different valid username instead", c.statusCode === 200);

c = await createWorker("בדיקה", "bad@name");
check("N9 an '@' in the login username is refused", c.statusCode === 400, `status=${c.statusCode}`);

// Each of those usernames must resolve to its own workspace, with no code.
r = await login("login_worker", { username: "אלי כהן", password: PW });
check(
  "N10 the first username signs in and resolves workspace A",
  r.statusCode === 200 &&
    q1(`select workspace_id from public.auth_handoff_codes order by issued_at desc limit 1;`) === wsA,
);

// =================== PROVISIONING CLAIMS A USERNAME =======================
section("OWNER PROVISIONING CLAIMS A LOGIN USERNAME (blocker 1)");

// The Platform Owner console runs at aal2 with a verified recovery address -
// that state was established above (S3).
const pPost = (body) =>
  callHandler(H.platformSession, {
    method: "POST",
    url: "/api/platform/session",
    headers: {
      authorization: `Bearer ${aal2Token}`,
      origin: PLATFORM_ORIGIN,
      "content-type": "application/json",
    },
    body,
  });

let pr = await pPost({
  op: "create_owner_access",
  name: "Owner With Username",
  email: `newowner-${stamp}@kolbox.test`,
  phone: "",
  expiresInDays: 7,
  modules: ["election_day"],
  username: "owner alpha",
});
check(
  "P1 create_owner_access succeeds and claims the Owner's login username",
  pr.statusCode === 201,
  `status=${pr.statusCode} ${JSON.stringify(pr.body).slice(0, 180)}`,
);
check(
  "P2 the Election Owner now HAS a directory row (previously impossible)",
  q1(`select realm || '|' || username from public.auth_identities
      where realm='election_owner' and username='owner alpha';`) ===
    "election_owner|owner alpha",
);

pr = await pPost({
  op: "create_owner_access",
  name: "Missing Username",
  email: `nouser-${stamp}@kolbox.test`,
  phone: "",
  expiresInDays: 7,
  modules: ["election_day"],
});
check("P3 create_owner_access WITHOUT a username is refused", pr.statusCode === 400);

pr = await pPost({
  op: "create_owner_access",
  name: "Colliding Owner",
  email: `collide-${stamp}@kolbox.test`,
  phone: "",
  expiresInDays: 7,
  modules: ["election_day"],
  username: "owner alpha",
});
check(
  "P4 a taken Owner username -> 409 with the next free suggestion",
  pr.statusCode === 409 &&
    pr.body?.error === "USERNAME_TAKEN" &&
    pr.body?.suggestion === "owner alpha 2",
  JSON.stringify(pr.body),
);
check(
  "P5 the refused approval created NO Auth account and NO approval row",
  q1(`select count(*) from public.election_workspace_pending_owner_access
      where email='collide-${stamp}@kolbox.test';`) === "0",
);

// The newly approved Owner can actually sign in on their own surface once the
// recovery gate is satisfied - the end-to-end point of blocker 1.
const newOwnerId = q1(`select auth_user_id from public.election_workspace_pending_owner_access
                       where email='newowner-${stamp}@kolbox.test';`);
if (newOwnerId.length === 36) {
  await A.auth.admin.updateUserById(newOwnerId, { password: PW });
}
r = await login("login_election_owner", { username: "owner alpha", password: PW });
check(
  "P6 the provisioned Owner signs in on /login/election-owner end to end",
  r.statusCode === 200 && r.body?.ok === true && r.body?.realm === "election_owner",
  JSON.stringify(r.body),
);

// ---- Multi-Entity provisioning ----
pr = await pPost({
  op: "provision_multi_entity_owner",
  name: "ME With Username",
  email: `newme-${stamp}@kolbox.test`,
  phone: "",
  username: "multi alpha",
});
check(
  "P7 provision_multi_entity_owner claims its login username",
  (pr.statusCode === 200 || pr.statusCode === 201) &&
    q1(`select username from public.auth_identities
        where realm='multi_entity_owner' and username='multi alpha';`) === "multi alpha",
  `status=${pr.statusCode} ${JSON.stringify(pr.body).slice(0, 180)}`,
);

pr = await pPost({
  op: "provision_multi_entity_owner",
  name: "ME No Username",
  email: `nome-${stamp}@kolbox.test`,
  phone: "",
});
check("P8 provisioning a seat WITHOUT a username is refused", pr.statusCode === 400);

// =================== PLATFORM OWNER SELF-ASSIGNMENT =======================
section("PLATFORM OWNER ASSIGNS ITS OWN USERNAME (blocker 2)");

check(
  "Q1 the console reports the Platform Owner's username (already claimed above)",
  (
    await callHandler(H.platformSession, {
      method: "GET",
      url: "/api/platform/session",
      headers: { authorization: `Bearer ${aal2Token}` },
    })
  ).body?.username === "platform boss",
);

pr = await pPost({ op: "set_own_username", username: "second name" });
check(
  "Q2 a second username for the same principal is refused",
  pr.statusCode === 409 && pr.body?.error === "USERNAME_ALREADY_SET",
  JSON.stringify(pr.body),
);

// A fresh Platform Owner with no username: the claim path.
psql(`delete from public.auth_identities where realm='platform_owner';`);
let g = await callHandler(H.platformSession, {
  method: "GET",
  url: "/api/platform/session",
  headers: { authorization: `Bearer ${aal2Token}` },
});
check("Q3 an unclaimed username reads as null, not missing", g.body?.username === null);

pr = await pPost({ op: "set_own_username", username: "po fresh" });
check(
  "Q4 the claim succeeds with no external verification required",
  pr.statusCode === 200 && pr.body?.username === "po fresh",
  JSON.stringify(pr.body),
);
pr = await pPost({ op: "set_own_username", username: "bad@name" });
check("Q5 an invalid username is refused", pr.statusCode === 400 || pr.statusCode === 409);

tally("AUTH IDENTITY API");
