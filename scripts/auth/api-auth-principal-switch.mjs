// KOLBOX - A SIGN-IN ENDS THE PREVIOUS PRINCIPAL. Server side (worker -> owner).
//
// WHY THIS SUITE EXISTS. Both principals of the Election origin hold entirely
// independent credentials - the worker an HttpOnly `__Host-kb_ed_session`
// cookie, the Owner a Supabase session in the page's own storage - and nothing
// made one exclude the other. A browser that had signed in as a worker carried
// that still-valid cookie into an Owner sign-in, and the application resolved
// the cookie first: the Owner was shown, scoped and AUDITED as the worker.
// Nothing asserted what a sign-in does to a session that ALREADY EXISTS, which
// is how that survived - and, until this file, nothing drove leg 1 and leg 2 of
// the handoff against the real handlers at all.
//
// This proves the server half: an Owner sign-in revokes the worker session in
// the DATABASE and clears its cookie, while a FAILED sign-in and another
// tenant's session are left alone. The mirror direction (owner -> worker) is
// client-side storage and is proven in scripts/auth/ui-auth-complete.mjs.
//
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/auth/api-auth-principal-switch.mjs
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
  tally,
} from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();

const AUTH_ORIGIN = "https://auth.test";
const ELECTION_ORIGIN = "https://election.test";

process.env.KOLBOX_SURFACE = "auth";
process.env.KOLBOX_AUTH_ORIGIN = AUTH_ORIGIN;
process.env.KOLBOX_SELF_ORIGIN = AUTH_ORIGIN;
process.env.KOLBOX_ELECTION_ORIGIN = ELECTION_ORIGIN;
process.env.SESSION_ALLOWED_ORIGIN = ELECTION_ORIGIN;

const H = await buildHandlers();
const q1 = (sql) => psql(sql).trim();

const TXN_COOKIE = "__Host-kb_auth_txn";
const SESSION_COOKIE = "__Host-kb_ed_session";

/** The auth deployment answers the two login ops. */
const login = (op, body) =>
  callHandler(H.platformSession, {
    method: "POST",
    url: `/api/platform/session?auth_op=${op}`,
    headers: {
      origin: AUTH_ORIGIN,
      host: "auth.test",
      "content-type": "application/json",
    },
    body,
  });

/**
 * Leg 1 and leg 2 answer only on a TARGET deployment, so the surface gate has
 * to be flipped around them. `currentSurface()`/`selfOrigin()` read env at
 * CALL time, not module load, which is what makes this legitimate rather than
 * a stub - the same gate code runs, just configured as the election project.
 */
async function onElection(fn) {
  const saved = {
    surface: process.env.KOLBOX_SURFACE,
    self: process.env.KOLBOX_SELF_ORIGIN,
  };
  process.env.KOLBOX_SURFACE = "election";
  process.env.KOLBOX_SELF_ORIGIN = ELECTION_ORIGIN;
  try {
    return await fn();
  } finally {
    process.env.KOLBOX_SURFACE = saved.surface;
    process.env.KOLBOX_SELF_ORIGIN = saved.self;
  }
}

const legOne = (code) =>
  onElection(() =>
    callHandler(H.platformSession, {
      method: "POST",
      url: "/api/platform/session?auth_op=continue",
      headers: {
        origin: AUTH_ORIGIN,
        host: "election.test",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `code=${code}`,
    }),
  );

const legTwo = (cookies) =>
  onElection(() =>
    callHandler(H.platformSession, {
      method: "POST",
      url: "/api/platform/session?auth_op=complete",
      headers: {
        origin: ELECTION_ORIGIN,
        host: "election.test",
        "content-type": "application/json",
      },
      body: { action: "continue" },
      cookies,
    }),
  );

/** Every Set-Cookie the response emitted, whichever form was used. */
const cookiesOf = (res) => {
  const v = res?.headers?.["set-cookie"];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
};
const cookieNamed = (res, name) =>
  cookiesOf(res).find((c) => c.startsWith(`${name}=`)) ?? null;
/** The raw value a Set-Cookie carries - the empty string when it is a clear. */
const cookieValue = (line) =>
  line === null ? null : line.split(";")[0].split("=").slice(1).join("=");

/**
 * A full shared-login sign-in, through both legs. `carry` is whatever the
 * browser ALREADY holds when leg 2 is reached - which is the whole point.
 */
async function signInThrough(username, password, carry = {}) {
  const r = await login("login", { username, password });
  if (r.statusCode !== 200 || r.body?.ok !== true) {
    return { stage: "login", two: r, realm: null };
  }
  const one = await legOne(r.body.code);
  const txn = cookieValue(cookieNamed(one, TXN_COOKIE));
  if (!txn) return { stage: "leg1", two: one, realm: r.body.realm };
  const two = await legTwo({ ...carry, [TXN_COOKIE]: txn });
  return { stage: "leg2", realm: r.body.realm, two };
}

/** The live GET endpoint - the real test of whether a token still works. */
const getSession = (rawToken) =>
  onElection(() =>
    callHandler(H.electionSession, {
      method: "GET",
      url: "/api/election-day/session",
      headers: { origin: ELECTION_ORIGIN, host: "election.test" },
      cookies: { [SESSION_COOKIE]: rawToken },
    }),
  );

const liveSessions = (actorId) =>
  Number(
    q1(`select count(*) from public.election_day_sessions
        where permission_user_id='${actorId}' and expires_at > now();`),
  );

// ---------------------------------------------------------------- fixtures --
section("FIXTURES - two workspaces, a worker in each, one Election Owner");
const PW = randomPassword();
const A = admin();
const stamp = Date.now();

const mk = async (email) => {
  const { data, error } = await A.auth.admin.createUser({
    email,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
};
const eoId = await mk(`ps-eo-${stamp}@kolbox.test`);

// Unique per run: a login code is 8 characters and a shared-login username is
// globally unique, so reusing fixed literals would make a second run collide
// rather than re-prove anything.
const tag = String(stamp).slice(-6);
// A login code is exactly 8 characters from an alphabet that deliberately
// EXCLUDES the ambiguous glyphs 0/1/I/L/O, so it cannot be derived from a
// timestamp - it has to be drawn from that alphabet.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const codeSuffix = Array.from(
  { length: 6 },
  () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
).join("");
const CODE_A = `PA${codeSuffix}`;
const CODE_B = `PB${codeSuffix}`;
const U_WORKER_A = `ps worker a ${tag}`;
const U_WORKER_B = `ps worker b ${tag}`;
const U_OWNER = `ps owner ${tag}`;

psql(`
  insert into public.election_workspaces (name, login_code, election_end_at)
  values ('PS Alpha ${tag}','${CODE_A}', now()+interval '30 days'),
         ('PS Beta ${tag}','${CODE_B}', now()+interval '30 days');

  insert into public.election_workspace_modules (workspace_id, module_key)
  select id, 'election_day' from public.election_workspaces
  where login_code in ('${CODE_A}','${CODE_B}');

  insert into public.election_owners (workspace_id, auth_user_id, name, email)
  select id, '${eoId}', 'PS Owner', 'ps-eo-${stamp}@kolbox.test'
  from public.election_workspaces where login_code='${CODE_A}';

  insert into public.election_day_roles (workspace_id, name, permissions, scope_type, is_manager)
  select id, 'caller', array[]::text[], 'assigned_to_me', false
  from public.election_workspaces where login_code in ('${CODE_A}','${CODE_B}');

  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  select w.id, 'worker a', extensions.crypt('${PW}', extensions.gen_salt('bf')), r.id
  from public.election_workspaces w join public.election_day_roles r on r.workspace_id=w.id
  where w.login_code='${CODE_A}';
  insert into public.election_day_permission_users (workspace_id, name, password_hash, role_id)
  select w.id, 'worker b', extensions.crypt('${PW}', extensions.gen_salt('bf')), r.id
  from public.election_workspaces w join public.election_day_roles r on r.workspace_id=w.id
  where w.login_code='${CODE_B}';
`);

const actorA = q1(`select u.id from public.election_day_permission_users u
  join public.election_workspaces w on w.id=u.workspace_id
  where w.login_code='${CODE_A}' and u.name='worker a';`);
const actorB = q1(`select u.id from public.election_day_permission_users u
  join public.election_workspaces w on w.id=u.workspace_id
  where w.login_code='${CODE_B}' and u.name='worker b';`);

psql(`
  select public.auth_identity_assign('worker','${U_WORKER_A}',null,'${actorA}',
    (select id from public.election_workspaces where login_code='${CODE_A}'));
  select public.auth_identity_assign('worker','${U_WORKER_B}',null,'${actorB}',
    (select id from public.election_workspaces where login_code='${CODE_B}'));
  select public.auth_identity_assign('election_owner','${U_OWNER}','${eoId}',null,null);
`);
check(
  "X0 fixtures created",
  actorA.length === 36 && actorB.length === 36 && eoId.length === 36,
);

// ================================================================= THE BUG ==
section("A. WORKER -> OWNER: the Owner sign-in ENDS the worker session");

const wa = await signInThrough(U_WORKER_A, PW);
const workerToken = cookieValue(cookieNamed(wa.two, SESSION_COOKIE));
check(
  "A1 the worker signed in through both legs and received a session cookie",
  wa.realm === "worker" &&
    wa.two.statusCode === 200 &&
    typeof workerToken === "string" &&
    workerToken.length === 64,
  `${wa.stage} ${JSON.stringify(wa.two?.body)}`,
);
check("A2 that session is LIVE - the server accepts the token", (await getSession(workerToken)).statusCode === 200);
check(
  "A3 ... and resolves the worker, in their own workspace",
  (await getSession(workerToken)).body?.name === "worker a",
);
check("A4 exactly one live session row exists for that worker", liveSessions(actorA) === 1);

// The browser still holds the worker cookie. This is the exact Production
// condition that was reported: a worker signed in, the Owner a minute later.
const owner = await signInThrough(U_OWNER, PW, { [SESSION_COOKIE]: workerToken });
check(
  "A5 the Owner sign-in itself succeeds",
  owner.realm === "election_owner" &&
    owner.two.statusCode === 200 &&
    typeof owner.two.body?.tokenHash === "string",
  `${owner.stage} ${JSON.stringify(owner.two?.body)}`,
);

const cleared = cookieNamed(owner.two, SESSION_COOKIE);
check(
  "A6 leg 2 emits a Set-Cookie that CLEARS the worker session cookie",
  cleared !== null && /Max-Age=0/.test(cleared),
  String(cleared),
);
check(
  "A7 ... with the attributes it was SET with, or the browser keeps the original",
  cleared !== null &&
    /HttpOnly/.test(cleared) &&
    /Secure/.test(cleared) &&
    /SameSite=Strict/.test(cleared) &&
    /Path=\/;/.test(cleared),
  String(cleared),
);
check(
  "A8 ... and still clears the transaction cookie in the SAME response",
  cookieNamed(owner.two, TXN_COOKIE) !== null &&
    /Max-Age=0/.test(cookieNamed(owner.two, TXN_COOKIE)),
);
check(
  "A9 both are emitted as separate Set-Cookie headers, not one merged value",
  cookiesOf(owner.two).length === 2,
  JSON.stringify(cookiesOf(owner.two)),
);

// REVOKED, not merely unreachable from this browser: the token must be dead.
check("A10 the worker session ROW is gone from the database", liveSessions(actorA) === 0);
const replay = await getSession(workerToken);
check(
  "A11 replaying the old worker token is now REFUSED (401)",
  replay.statusCode === 401,
  `status=${replay.statusCode}`,
);
check(
  "A12 no session token appears in any response body",
  !JSON.stringify(owner.two.body).includes(workerToken),
);

// ================================================== the boundary conditions ==
section("B. TENANT ISOLATION - only THIS browser's session ends");

const wb = await signInThrough(U_WORKER_B, PW);
const tokenB = cookieValue(cookieNamed(wb.two, SESSION_COOKIE));
check(
  "B1 a worker in the OTHER workspace is signed in",
  wb.two.statusCode === 200 && liveSessions(actorB) === 1,
);

const wa2 = await signInThrough(U_WORKER_A, PW);
const tokenA2 = cookieValue(cookieNamed(wa2.two, SESSION_COOKIE));
const owner2 = await signInThrough(U_OWNER, PW, { [SESSION_COOKIE]: tokenA2 });
check("B2 a second Owner sign-in succeeds", owner2.two.statusCode === 200);
check("B3 it ended the session presented in ITS OWN request", liveSessions(actorA) === 0);
check(
  "B4 the OTHER workspace's worker is untouched - no cross-tenant revocation",
  liveSessions(actorB) === 1 && (await getSession(tokenB)).statusCode === 200,
);

section("C. ONLY A SUCCESSFUL SIGN-IN ENDS ANYTHING");

const wa3 = await signInThrough(U_WORKER_A, PW);
const tokenA3 = cookieValue(cookieNamed(wa3.two, SESSION_COOKIE));
check("C1 the worker is signed in again", liveSessions(actorA) === 1);

// A leg 2 with no valid transaction is exactly what anyone who can reach the
// endpoint has. It must not become a way to sign a working worker out.
const bogus = await legTwo({
  [SESSION_COOKIE]: tokenA3,
  [TXN_COOKIE]: "0".repeat(64),
});
check("C2 a leg 2 with an invalid transaction is refused (401)", bogus.statusCode === 401);
check(
  "C3 ... and did NOT revoke the worker session - a failed handoff is not a logout",
  liveSessions(actorA) === 1 && (await getSession(tokenA3)).statusCode === 200,
);

const noTxn = await legTwo({ [SESSION_COOKIE]: tokenA3 });
check("C4 a leg 2 with no transaction cookie at all is refused (401)", noTxn.statusCode === 401);
check("C5 ... and still left the worker session alone", liveSessions(actorA) === 1);

section("D. WORKER -> WORKER, and an Owner with no worker session at all");

const wa4 = await signInThrough(U_WORKER_A, PW, { [SESSION_COOKIE]: tokenA3 });
const tokenA4 = cookieValue(cookieNamed(wa4.two, SESSION_COOKIE));
check(
  "D1 a second worker sign-in issues a NEW token",
  tokenA4 !== tokenA3 && wa4.two.statusCode === 200,
);
check("D2 the new token works", (await getSession(tokenA4)).statusCode === 200);

// The clear is unconditional, so the invariant must not depend on a cookie
// having been present to read back.
const ownerClean = await signInThrough(U_OWNER, PW);
check(
  "D3 an Owner sign-in with NO worker cookie still succeeds",
  ownerClean.two.statusCode === 200 && typeof ownerClean.two.body?.tokenHash === "string",
);
check(
  "D4 ... and still emits the clear, so the invariant is unconditional",
  cookieNamed(ownerClean.two, SESSION_COOKIE) !== null &&
    /Max-Age=0/.test(cookieNamed(ownerClean.two, SESSION_COOKIE)),
);
check(
  "D5 ... and revoked nothing it was not given - the other tenant is still live",
  liveSessions(actorB) === 1,
);

section("E. THE HANDOFF'S OWN PROTECTIONS ARE UNCHANGED");

const foreign = await onElection(() =>
  callHandler(H.platformSession, {
    method: "POST",
    url: "/api/platform/session?auth_op=complete",
    headers: {
      origin: "https://evil.test",
      host: "election.test",
      "content-type": "application/json",
    },
    body: { action: "continue" },
    cookies: { [TXN_COOKIE]: "0".repeat(64) },
  }),
);
check("E1 leg 2 from a foreign Origin is still refused (403)", foreign.statusCode === 403);

const wa5 = await signInThrough(U_WORKER_A, PW);
const txnGuess = await legTwo({ [TXN_COOKIE]: "0".repeat(64) });
check(
  "E2 a transaction value is still unguessable / single-use",
  txnGuess.statusCode === 401 && wa5.two.statusCode === 200,
);

const ownerBody = await signInThrough(U_OWNER, PW);
check(
  "E3 the Owner response still carries only ok, tokenHash and redirect",
  Object.keys(ownerBody.two.body).sort().join(",") === "ok,redirect,tokenHash",
  JSON.stringify(Object.keys(ownerBody.two.body)),
);
check(
  "E4 the Owner still lands on the shared shell route",
  ownerBody.two.body?.redirect === "/election-day",
);

process.exitCode = tally("PRINCIPAL SWITCH (SERVER)") === 0 ? 0 : 1;
