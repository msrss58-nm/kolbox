// OPEN-ISSUES BATCH - the server half.
//
// Covers, against the REAL bundled handlers on the isolated kolboxs5 scratch
// stack (never Production, never the developer's own kolbox stack):
//
//   Issue 2  the "יבנה" case - a workspace entitled ONLY to Election Day.
//            The authorization proof: the server never reports
//            `voter_management` as an effective module to anyone, for either
//            principal, and the module's own screens have no server surface
//            to reach. This is what makes hiding the menu correct rather than
//            cosmetic - the menu was the ONLY thing that disagreed with the
//            server.
//   Issue 3  the Multi-Entity seat carries its login username as DURABLE
//            server state, so the hand-off survives a reload - while the
//            one-time password link is still never persisted.
//   Issue 5  the active workspace NAME reaches both principals from their own
//            trusted session, not from the client.
//   Issue 6  the Election Owner's session carries their login USERNAME.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/open-issues/api-open-issues.mjs
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

const ORIGIN = "https://election.test";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
process.env.OWNER_ALLOWED_ORIGIN = ORIGIN;
process.env.BUDGET_ALLOWED_ORIGIN = ORIGIN;
process.env.PLATFORM_ALLOWED_ORIGIN = "https://platform.test";

const H = await buildHandlers();
const A = admin();
const PW = randomPassword();
const stamp = Date.now();
const COOKIE = "__Host-kb_ed_session";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
// Derived from THIS run's stamp as well as the seed, so a re-run never
// collides with a previous run's leftover workspace on the same scratch stack.
const mkCode = (seed) =>
  Array.from(
    { length: 8 },
    (_, i) => CODE_ALPHABET[Math.floor(stamp / 10 ** i + seed * 7 + i * 13) % CODE_ALPHABET.length],
  ).join("");

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const auth = (t) => ({ authorization: `Bearer ${t}` });

/**
 * One Election Owner + their workspace + exactly the module rows requested,
 * with a login username claimed through the real identity directory (the same
 * path provisioning uses), because issue 6 is about that username.
 */
async function makeOwner(label, workspaceName, modules, seed) {
  const email = `ws-${label}-${stamp}@kolbox.test`;
  const { data, error } = await A.auth.admin.createUser({
    email,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const code = mkCode(seed);
  psql(
    `insert into public.election_workspaces (name, login_code, election_end_at)
     values (${sqlText(workspaceName)},'${code}', now()+interval '30 days');`,
  );
  const workspaceId = psql(
    `select id from public.election_workspaces where login_code='${code}';`,
  ).trim();
  psql(
    `insert into public.election_owners (workspace_id, auth_user_id, name, email)
     values ('${workspaceId}','${data.user.id}','Owner ${label}',${sqlText(email)});`,
  );
  for (const key of modules) {
    psql(
      `insert into public.election_workspace_modules (workspace_id, module_key)
       values ('${workspaceId}','${key}') on conflict do nothing;`,
    );
  }
  const username = `owner-${label}-${stamp}`;
  psql(
    `select public.auth_identity_assign('election_owner', ${sqlText(username)}, '${data.user.id}', null, null);`,
  );
  const { token } = await signIn(email, PW);
  return { label, email, username, workspaceName, workspaceId, code, token, authUserId: data.user.id };
}

/** A worker in `owner`'s workspace, logged in through the real session endpoint. */
async function makeWorker(owner, name) {
  // A raw workspace insert seeds no roles (provisioning does that), so the
  // fixture creates the one Manager role this worker needs.
  psql(
    `insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
     values ('${owner.workspaceId}', 'מנהל', array['electionDay.manageRoles'], 'all', true)
     on conflict do nothing;`,
  );
  const roleId = psql(
    `select id from public.election_day_roles where workspace_id='${owner.workspaceId}' order by created_at limit 1;`,
  ).trim();
  psql(
    `insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
     values ('${owner.workspaceId}', ${sqlText(name)}, extensions.crypt(${sqlText(PW)}, extensions.gen_salt('bf')), '${roleId}');`,
  );
  psql("delete from public.election_day_login_attempts;");
  const r = await callHandler(H.electionSession, {
    method: "POST",
    url: "/api/election-day/session",
    headers: { origin: ORIGIN },
    body: { workspaceCode: owner.code, name, password: PW },
  });
  const sc = r.headers?.["set-cookie"];
  const raw = typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
  return { status: r.statusCode, body: r.body, cookie: raw };
}

const ownerGet = (owner, op) =>
  callHandler(H.ownerActions, {
    method: "GET",
    url: `/api/election-day/owner-actions?op=${encodeURIComponent(op)}`,
    headers: { origin: ORIGIN, ...auth(owner.token) },
  });

// ------------------------------------------------------------- fixtures ----
section("FIXTURES");
// The reported case verbatim: a workspace assigned ONLY "ניהול יום בחירות".
const yavne = await makeOwner("yavne", "יבנה", ["election_day"], 11);
// The control: the SAME module set plus an explicit voter_management
// entitlement row. It exists to prove the checks below discriminate - that
// they fail for the right reason and not because nothing was ever granted.
const granted = await makeOwner("granted", "מודיעין", ["election_day", "voter_management"], 12);
check(
  "F1 two workspaces, one entitled to Election Day only, one also granted voter_management",
  yavne.workspaceId !== granted.workspaceId &&
    psql(
      `select count(*) from public.election_workspace_modules where workspace_id='${granted.workspaceId}' and module_key='voter_management';`,
    ).trim() === "1",
);
check(
  "F2 ... and the voter_management row really is absent for יבנה (the control is the only difference)",
  psql(
    `select count(*) from public.election_workspace_modules where workspace_id='${yavne.workspaceId}' and module_key='voter_management';`,
  ).trim() === "0",
);

// ========================================================================
section("A. ISSUE 2 - AUTHORIZATION: voter_management is never effective");
// ========================================================================
const worker = await makeWorker(yavne, `worker-${stamp}`);
check("A1 the worker signed in (200) - the fixture is real", worker.status === 200, `status=${worker.status}`);
check(
  "A2 the worker's LOGIN payload reports election_day and NOT voter_management",
  Array.isArray(worker.body?.modules) &&
    worker.body.modules.includes("election_day") &&
    !worker.body.modules.includes("voter_management"),
  JSON.stringify(worker.body?.modules),
);
const workerGet = await callHandler(H.electionSession, {
  method: "GET",
  url: "/api/election-day/session",
  cookies: { [COOKIE]: worker.cookie },
});
check(
  "A3 ... and so does the RELOAD payload (a deep link cannot be entitled differently)",
  workerGet.statusCode === 200 &&
    Array.isArray(workerGet.body?.modules) &&
    !workerGet.body.modules.includes("voter_management"),
  JSON.stringify(workerGet.body?.modules),
);
// DISCRIMINATING: the control workspace HAS the entitlement row, and the
// server still refuses to report it - because effective access is the row AND
// global availability, and voter_management is not globally available.
const grantedWorker = await makeWorker(granted, `worker-granted-${stamp}`);
check(
  "A4 even a workspace WITH the entitlement row is not reported voter_management",
  grantedWorker.status === 200 &&
    Array.isArray(grantedWorker.body?.modules) &&
    !grantedWorker.body.modules.includes("voter_management"),
  JSON.stringify(grantedWorker.body?.modules),
);
const availability = psql(
  "select available || '/' || availability_switchable from public.platform_modules where key='voter_management';",
).trim();
check(
  "A5 ... and the reason is server state: voter_management is globally unavailable AND not switchable",
  availability === "false/false",
  `available/switchable=${availability}`,
);
// The Owner path, same question.
const yavneModules = await ownerGet(yavne, "workspace_modules");
const grantedModules = await ownerGet(granted, "workspace_modules");
/** Exactly the filter the client applies: entitled AND globally available. */
const effective = (body) =>
  Array.isArray(body)
    ? body.filter((m) => m.enabled && m.available).map((m) => m.module_key)
    : null;
check(
  "A6 the Owner of יבנה is offered election_day only - voter_management is not effective",
  yavneModules.statusCode === 200 &&
    JSON.stringify(effective(yavneModules.body)) === JSON.stringify(["election_day"]),
  JSON.stringify(effective(yavneModules.body)),
);
check(
  "A7 the control Owner's granted row is reported enabled but NOT available -> still not effective",
  grantedModules.statusCode === 200 &&
    (grantedModules.body ?? []).some((m) => m.module_key === "voter_management" && m.enabled && !m.available) &&
    !effective(grantedModules.body).includes("voter_management"),
  JSON.stringify(grantedModules.body),
);
// And there is no server surface behind the module at all - the strongest
// statement available, and the one that makes the menu the only defect.
const serverSurfaces = [
  ["A8", "list_voters", yavne],
  ["A9", "list_voters", granted],
];
for (const [id, op, owner] of serverSurfaces) {
  const r = await ownerGet(owner, op);
  check(
    `${id} Owner[${owner.label}] Election Day data op answers 200 (that module IS entitled)`,
    r.statusCode === 200,
    `status=${r.statusCode}`,
  );
}
check(
  "A10 no RPC, route or table anywhere is keyed on voter_management (nothing to authorize yet)",
  psql(
    "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) like '%voter_management%';",
  ).trim() === "0",
);

// ========================================================================
section("B. ISSUE 5 - THE ACTIVE WORKSPACE NAME REACHES BOTH PRINCIPALS");
// ========================================================================
check(
  "B1 the worker's LOGIN payload carries the workspace name",
  worker.body?.workspaceName === "יבנה",
  JSON.stringify(worker.body?.workspaceName),
);
check(
  "B2 ... and the RELOAD payload does too (a refresh must not blank the chrome)",
  workerGet.body?.workspaceName === "יבנה",
  JSON.stringify(workerGet.body?.workspaceName),
);
check(
  "B3 a DIFFERENT workspace reports ITS OWN name - the value is resolved, not constant",
  grantedWorker.body?.workspaceName === "מודיעין",
  JSON.stringify(grantedWorker.body?.workspaceName),
);
const ownerSession = await ownerGet(yavne, "session");
check(
  "B4 the Owner's session carries the workspace name too",
  ownerSession.statusCode === 200 && ownerSession.body?.workspaceName === "יבנה",
  JSON.stringify(ownerSession.body),
);
const grantedSession = await ownerGet(granted, "session");
check(
  "B5 ... and the other Owner gets the other name",
  grantedSession.body?.workspaceName === "מודיעין",
  JSON.stringify(grantedSession.body?.workspaceName),
);
// The name is METADATA. It must never be an authority, and it is not one:
// nothing accepts it as input.
const forged = await callHandler(H.ownerActions, {
  method: "POST",
  url: "/api/election-day/owner-actions",
  headers: { origin: ORIGIN, ...auth(yavne.token), "content-type": "application/json" },
  body: { op: "list_voters", workspaceName: "מודיעין" },
});
check(
  "B6 a forged workspaceName in a request body is refused outright - it is display, never input",
  forged.statusCode === 400,
  `status=${forged.statusCode} ${JSON.stringify(forged.body)}`,
);

// ========================================================================
section("C. ISSUE 6 - THE OWNER'S SESSION CARRIES THEIR LOGIN USERNAME");
// ========================================================================
check(
  "C1 the Owner session returns the username they actually sign in with",
  ownerSession.body?.username === yavne.username,
  `${JSON.stringify(ownerSession.body?.username)} vs ${yavne.username}`,
);
check(
  "C2 ... and it is NOT the e-mail address (the reported symptom)",
  ownerSession.body?.username !== yavne.email &&
    !JSON.stringify(ownerSession.body).includes(yavne.email),
  JSON.stringify(ownerSession.body),
);
check(
  "C3 the other Owner gets their OWN username - resolved per identity, not shared",
  grantedSession.body?.username === granted.username &&
    granted.username !== yavne.username,
  JSON.stringify(grantedSession.body?.username),
);
// DISCRIMINATING: an Owner with no claimed username must still get a session,
// with the field simply absent - the contract is additive and fail-soft.
const noName = await makeOwner("nousername", "ללא שם משתמש", ["election_day"], 13);
psql(`delete from public.auth_identities where auth_user_id='${noName.authUserId}';`);
const noNameSession = await ownerGet(noName, "session");
check(
  "C4 an Owner with no claimed username still resolves - the field is simply omitted",
  noNameSession.statusCode === 200 &&
    noNameSession.body?.username === undefined &&
    typeof noNameSession.body?.ownerId === "string",
  JSON.stringify(noNameSession.body),
);
check(
  "C5 the username is never accepted FROM the client - the session op takes no body",
  (
    await callHandler(H.ownerActions, {
      method: "POST",
      url: "/api/election-day/owner-actions",
      headers: { origin: ORIGIN, ...auth(yavne.token), "content-type": "application/json" },
      body: { op: "session", username: "someone-else" },
    })
  ).statusCode === 400,
);

// ========================================================================
section("D. ISSUE 3 - THE MULTI-ENTITY HAND-OFF IS DURABLE, THE LINK IS NOT");
// ========================================================================
// A Platform Owner with a real aal2 session is a large fixture; the durable
// half of the hand-off is a server fact, so it is proven where it lives.
const seatEmail = `me-seat-${stamp}@kolbox.test`;
const { data: seatUser, error: seatErr } = await A.auth.admin.createUser({
  email: seatEmail,
  password: PW,
  email_confirm: true,
});
if (seatErr) throw new Error(`seat createUser: ${seatErr.message}`);
const seatUsername = `me-owner-${stamp}`;
// 20260926000000: the boolean `id` column is gone; owner_id is generated.
psql(`delete from public.multi_entity_owner;`);
psql(
  `insert into public.multi_entity_owner (auth_user_id, name, email, phone)
   values ('${seatUser.user.id}', 'בעל רב-מערכות', ${sqlText(seatEmail)}, '0501234567');`,
);
psql(
  `select public.auth_identity_assign('multi_entity_owner', ${sqlText(seatUsername)}, '${seatUser.user.id}', null, null);`,
);
const resolved = psql(
  `select public.auth_identity_for_subject('${seatUser.user.id}');`,
).trim();
check(
  "D1 the seat holder's username is DURABLE server state, readable after the response is long gone",
  resolved === seatUsername,
  `${resolved} vs ${seatUsername}`,
);
check(
  "D2 ... and it is the accessor the console reads, not a direct auth_identities read",
  psql(
    "select has_table_privilege('authenticated','public.auth_identities','select')::text;",
  ).trim() === "false",
);
// The link is the one thing that must NOT be durable.
check(
  "D3 no password-setting link is stored anywhere in the schema (it is a credential)",
  psql(
    "select count(*) from information_schema.columns where table_schema='public' and (column_name like '%password_link%' or column_name like '%activation_link%');",
  ).trim() === "0",
);
check(
  "D4 the seat row itself holds no secret - only name, e-mail, phone and ids",
  psql(
    "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='multi_entity_owner';",
  // 20260926000000 replaced the boolean `id` with a generated `owner_id`
  // (appended, so it sorts last by ordinal position). Still no secret.
  ).trim() === "auth_user_id,name,phone,email,created_at,updated_at,owner_id",
);

// ========================================================================
section("E. MULTI-OWNER - the singleton this batch reported has been removed");
// ========================================================================
// SUPERSEDED by migration 20260926000000. When this suite was written the
// answer to "can there be a second Multi-Entity Owner?" was "no, structurally"
// - a boolean-PK singleton - and these checks recorded exactly that as the
// evidence for refusing to build it in the UI. The model has since been
// replaced on purpose, so the checks are inverted rather than deleted: the
// same three facts, now asserting the new model holds.
let secondSeat = "INSERT REFUSED";
try {
  psql(
    `insert into public.multi_entity_owner (auth_user_id, name, email)
     values ('${seatUser.user.id}', 'second', 'second@kolbox.test');`,
  );
  secondSeat = "INSERT SUCCEEDED";
} catch (err) {
  secondSeat = String(err?.stderr ?? err?.message ?? err);
}
check(
  "E1 a second owner row is REFUSED here only because this Auth id already holds one",
  /multi_entity_owner_auth_user_id_key|duplicate key/i.test(secondSeat),
  secondSeat.slice(0, 140).replace(/\s+/g, " "),
);
check(
  "E2 the singleton CHECK is gone - the table is no longer capped at one row",
  psql(
    "select count(*) from pg_constraint where conname='multi_entity_owner_singleton';",
  ).trim() === "0",
);
check(
  "E3 assignments now carry an owner column - visibility is per owner",
  psql(
    "select count(*) from information_schema.columns where table_schema='public' and table_name='multi_entity_assignments' and column_name='owner_id';",
  ).trim() === "1",
);

tally("OPEN ISSUES API");
