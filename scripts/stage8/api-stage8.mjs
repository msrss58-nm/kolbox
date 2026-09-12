// Platform Stage 8B - REAL-LOCAL API suite: Election Owner approval recovery.
//
// Real GoTrue + real Postgres (the isolated kolboxs5 scratch stack), the REAL
// bundled Platform handler, a real password + TOTP/aal2 Platform Owner,
// synthetic *@stage8-api.invalid identities only. Faults are injected through
// scripts/stage5/faultableOwnerAuth.mjs (test bundles only).
//
// Covers: approval create (marker, duplicate / case / foreign / principal
// addresses, concurrency), failure-after-create cleanup (confirmed delete,
// unconfirmed delete -> AUTH_CLEANUP_INCOMPLETE, 404-as-confirmed, malformed
// row, createUser race), re-use of a leftover account (no duplicate), link
// failure, the approvals list, re-issue (active / expired / consumed / not
// found / link failure / old link invalidated), and auth/AAL2/Origin/body
// allow-list regression on the new ops.
//
// Run:  S5_STACK_DIR=<scratch>/s8stack [S5_PORT_OFFSET=1000] node scripts/stage8/api-stage8.mjs
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
const handlers = await buildHandlers();
const a = admin();

const DOMAIN = "stage8-api.invalid";
const ORIGIN = "http://localhost:5173";
const email = (local) => `${local}@${DOMAIN}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setFaults = (f) => {
  globalThis.__S5_FAULTS = f;
};
const clearFaults = () => setFaults({});
clearFaults();

const PS = handlers.platformSession;
const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const pGet = (url, token) =>
  callHandler(PS, { method: "GET", url, headers: auth(token) });
const pPost = (body, token, origin = ORIGIN) =>
  callHandler(PS, {
    method: "POST",
    url: "/api/platform/session",
    headers: { ...auth(token), ...(origin ? { origin } : {}) },
    body,
  });
const approve = (local, token, extra = {}) =>
  pPost(
    {
      op: "create_owner_access",
      name: `EO ${local}`,
      email: email(local),
      modules: ["election_day"], // Stage 9: explicit module choice is required
      ...extra,
    },
    token,
  );
const reissue = (pendingId, token) =>
  pPost({ op: "reissue_owner_access", pendingId }, token);
const listOp = (token) => pGet("/api/platform/session?op=owner_access", token);

async function listUsers() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const { data, error } = await a.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}
const usersWith = async (e) =>
  (await listUsers()).filter((u) => (u.email ?? "").toLowerCase() === e.toLowerCase());
const pendingFor = (e) =>
  psql(
    `select id || '|' || auth_user_id || '|' || status from public.election_workspace_pending_owner_access where lower(email) = lower('${e}');`,
  );
const tokenHash = (link) => {
  try {
    return new URL(link).searchParams.get("token_hash");
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S8API %';
`);
for (const u of await listUsers()) {
  if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

const pw = {};
async function mkUser(local) {
  pw[local] = randomPassword();
  const { data, error } = await a.auth.admin.createUser({
    email: email(local),
    password: pw[local],
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${local}: ${error.message}`);
  return data.user.id;
}

const poId = await mkUser("po");
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poId}', 'S8 PO', '${email("po")}');`,
);
const poSession = await signIn(email("po"), pw.po);
const PO = (await enrollTotp(poSession.client, "s8-po")).token;
const PO_AAL1 = (await signIn(email("po"), pw.po)).token;
await mkUser("stranger");
const strangerSession = await signIn(email("stranger"), pw.stranger);
const STRANGER = (await enrollTotp(strangerSession.client, "s8-stranger")).token;
check("SETUP fixtures ready", !!PO && !!PO_AAL1 && !!STRANGER);

// ---------------------------------------------------------------------------
section("CREATE - marker, duplicates, foreign and principal addresses");
let firstLink = "";
let firstPendingId = "";
{
  const r = await approve("fresh", PO);
  firstLink = r.body?.activationLink ?? "";
  firstPendingId = r.body?.pendingId ?? "";
  const users = await usersWith(email("fresh"));
  check(
    "A1 new address -> 201 with an Election Owner set-password link",
    r.statusCode === 201 &&
      firstLink.startsWith(`${ORIGIN}/election-day/owner-set-password?`) &&
      UUID_RE.test(firstPendingId),
    String(r.statusCode),
  );
  check(
    "A1 exactly one Auth user, carrying the service-role mint marker",
    users.length === 1 &&
      users[0].app_metadata?.kolbox_mint === "election_owner_approval",
  );
  check(
    "A1 response contract unchanged",
    Object.keys(r.body ?? {})
      .sort()
      .join(",") === "activationLink,alreadyExisted,expiresAt,pendingId",
  );

  const dup = await approve("fresh", PO);
  check(
    "A2 same address again -> 409 APPROVAL_EXISTS",
    dup.statusCode === 409 && dup.body?.error === "APPROVAL_EXISTS",
    String(dup.statusCode),
  );
  const dupCase = await pPost(
    {
      op: "create_owner_access",
      name: "x",
      email: `  FRESH@${DOMAIN.toUpperCase()} `,
      modules: ["election_day"],
    },
    PO,
  );
  check(
    "A3 different case / whitespace -> 409 APPROVAL_EXISTS",
    dupCase.statusCode === 409 && dupCase.body?.error === "APPROVAL_EXISTS",
    String(dupCase.statusCode),
  );
  check(
    "A2/A3 still exactly one Auth user for that address (no duplicate)",
    (await usersWith(email("fresh"))).length === 1,
  );

  const foreignId = await mkUser("foreign");
  const f = await approve("foreign", PO);
  const fu = (await usersWith(email("foreign")))[0];
  check(
    "A4 existing account without the marker -> 409 EMAIL_ALREADY_REGISTERED",
    f.statusCode === 409 && f.body?.error === "EMAIL_ALREADY_REGISTERED",
    String(f.statusCode),
  );
  check(
    "A4 that account is untouched (not adopted, no marker, no approval)",
    fu?.id === foreignId &&
      !fu?.app_metadata?.kolbox_mint &&
      pendingFor(email("foreign")) === "",
  );
  const self = await approve("po", PO);
  check(
    "A5 the Platform Owner's own address -> 409 EMAIL_ALREADY_REGISTERED",
    self.statusCode === 409 && self.body?.error === "EMAIL_ALREADY_REGISTERED",
    String(self.statusCode),
  );

  const both = await Promise.all([approve("race", PO), approve("race", PO)]);
  const codes = both
    .map((x) => x.statusCode)
    .sort()
    .join(",");
  check(
    "A6 two concurrent approvals of one new address -> exactly one 201 and one 409",
    codes === "201,409",
    codes,
  );
  check(
    "A6 exactly one Auth user and one approval after the race",
    (await usersWith(email("race"))).length === 1 &&
      pendingFor(email("race")).split("\n").filter(Boolean).length === 1,
  );
}

// ---------------------------------------------------------------------------
section("FAILURE AFTER CREATE - explicit, never silent");
{
  let deleteCalls = 0;
  setFaults({
    rpc: {
      platform_create_pending_owner_access: () => ({
        data: null,
        error: { message: "injected" },
      }),
    },
  });
  const r = await approve("o-confirmed", PO);
  clearFaults();
  check(
    "O1 approval failure + confirmed delete -> plain 500, no warning",
    r.statusCode === 500 &&
      r.body?.error === "SERVER_ERROR" &&
      !("warning" in (r.body ?? {})),
    JSON.stringify(r.body),
  );
  check(
    "O1 the created account is gone and no approval exists",
    (await usersWith(email("o-confirmed"))).length === 0 &&
      pendingFor(email("o-confirmed")) === "",
  );

  setFaults({
    rpc: {
      platform_create_pending_owner_access: () => ({
        data: null,
        error: { message: "injected" },
      }),
    },
    admin: {
      deleteUser: () => {
        deleteCalls++;
        return {
          data: null,
          error: { status: 500, code: "unexpected_failure", message: "injected" },
        };
      },
    },
  });
  const o = await approve("orphan", PO);
  clearFaults();
  const orphanUsers = await usersWith(email("orphan"));
  check(
    "O2 unconfirmed delete -> SAME status/code + AUTH_CLEANUP_INCOMPLETE + the id",
    o.statusCode === 500 &&
      o.body?.error === "SERVER_ERROR" &&
      o.body?.warning === "AUTH_CLEANUP_INCOMPLETE" &&
      o.body?.orphanedAuthUserId === orphanUsers[0]?.id,
    JSON.stringify(o.body),
  );
  check(
    "O2 the delete WAS attempted (compensation not skipped)",
    deleteCalls === 1,
    String(deleteCalls),
  );
  check(
    "O2 the leftover account still carries the marker and has no approval",
    orphanUsers.length === 1 &&
      orphanUsers[0].app_metadata?.kolbox_mint === "election_owner_approval" &&
      pendingFor(email("orphan")) === "",
  );

  setFaults({
    rpc: {
      platform_create_pending_owner_access: () => ({
        data: null,
        error: { message: "injected" },
      }),
    },
  });
  const o4 = await approve("orphan", PO);
  clearFaults();
  check(
    "O3 a failing retry on an ADOPTED account never deletes it (plain error, account kept)",
    o4.statusCode === 500 &&
      !("warning" in (o4.body ?? {})) &&
      (await usersWith(email("orphan"))).length === 1,
    JSON.stringify(o4.body),
  );

  const again = await approve("orphan", PO);
  const after = await usersWith(email("orphan"));
  const pend = pendingFor(email("orphan")).split("|");
  check(
    "O4 re-approving the address re-uses the leftover account -> 201 with a link",
    again.statusCode === 201 && typeof again.body?.activationLink === "string",
    String(again.statusCode),
  );
  check(
    "O4 still exactly one Auth user (same id), now attached to the approval",
    after.length === 1 && after[0].id === orphanUsers[0]?.id && pend[1] === after[0].id,
  );

  setFaults({
    rpc: { platform_create_pending_owner_access: () => ({ data: [{}], error: null }) },
  });
  const m = await approve("o-malformed", PO);
  clearFaults();
  check(
    "O5 malformed approval row -> 500 and the created account is removed",
    m.statusCode === 500 && (await usersWith(email("o-malformed"))).length === 0,
    String(m.statusCode),
  );

  setFaults({
    rpc: {
      platform_create_pending_owner_access: () => ({
        data: null,
        error: { message: "injected" },
      }),
    },
    admin: {
      deleteUser: () => ({
        data: null,
        error: { status: 404, code: "user_not_found", message: "gone" },
      }),
    },
  });
  const nf = await approve("o-404", PO);
  clearFaults();
  check(
    "O6 delete answering structured 404 counts as confirmed -> plain error",
    nf.statusCode === 500 && !("warning" in (nf.body ?? {})),
    JSON.stringify(nf.body),
  );
  const stray = (await usersWith(email("o-404")))[0];
  if (stray) await a.auth.admin.deleteUser(stray.id); // the injected 404 left the real account behind

  let raceDeletes = 0;
  setFaults({
    admin: {
      createUser: () => ({
        data: { user: null },
        error: {
          status: 422,
          message: "A user with this email address has already been registered",
        },
      }),
      deleteUser: () => {
        raceDeletes++;
        return { data: null, error: null };
      },
    },
  });
  const rc = await approve("o-race", PO);
  clearFaults();
  check(
    "O7 createUser race ('already registered') -> 409 EMAIL_ALREADY_REGISTERED, nothing deleted",
    rc.statusCode === 409 &&
      rc.body?.error === "EMAIL_ALREADY_REGISTERED" &&
      raceDeletes === 0,
    String(rc.statusCode),
  );

  setFaults({
    admin: { generateLink: () => ({ data: null, error: { message: "injected" } }) },
  });
  const nl = await approve("nolink", PO);
  clearFaults();
  check(
    "O8 link generation failure -> 201 with activationLink null, approval stands",
    nl.statusCode === 201 &&
      nl.body?.activationLink === null &&
      pendingFor(email("nolink")) !== "",
    JSON.stringify(nl.body),
  );
}

// ---------------------------------------------------------------------------
section("LIST - approvals with state");
let approvals = [];
{
  const r = await listOp(PO);
  approvals = r.body?.approvals ?? [];
  const mine = approvals.filter((x) => String(x.email).endsWith(`@${DOMAIN}`));
  check(
    "G1 GET ?op=owner_access -> 200 {approvals}",
    r.statusCode === 200 &&
      Array.isArray(r.body?.approvals) &&
      Object.keys(r.body).join(",") === "approvals",
    String(r.statusCode),
  );
  check(
    "G1 every approval created above is listed as active",
    ["fresh", "race", "orphan", "nolink"].every(
      (l) => mine.find((x) => x.email === email(l))?.state === "active",
    ),
  );
  check(
    "G1 row keys exact (no auth_user_id / credential)",
    mine.every(
      (x) =>
        Object.keys(x).sort().join(",") ===
        // Stage 9 added requested_modules (the approval's module choice).
        "consumed_at,created_at,email,expires_at,name,pending_id,phone,requested_modules,state,workspace_name",
    ),
  );
  check("G2 no token -> 401", (await listOp(null)).statusCode === 401);
  check("G2 aal1 Platform Owner -> 401", (await listOp(PO_AAL1)).statusCode === 401);
  check("G2 aal2 stranger -> 401", (await listOp(STRANGER)).statusCode === 401);
  check(
    "G3 unknown GET op still 400",
    (await pGet("/api/platform/session?op=nope", PO)).statusCode === 400,
  );
  check(
    "G3 default GET payload unchanged",
    Object.keys((await pGet("/api/platform/session", PO)).body ?? {})
      .sort()
      .join(",") === "email,platformOwnerId",
  );
}

// ---------------------------------------------------------------------------
section("REISSUE - active / expired / consumed / not found");
{
  const usersBefore = (await listUsers()).length;

  const r1 = await reissue(firstPendingId, PO);
  const newLink = r1.body?.activationLink ?? "";
  check(
    "R1 active -> 200 renewed=false with a NEW link on the Election Owner screen",
    r1.statusCode === 200 &&
      r1.body?.renewed === false &&
      newLink.startsWith(`${ORIGIN}/election-day/owner-set-password?`) &&
      newLink !== firstLink,
    String(r1.statusCode),
  );
  check(
    "R1 response contract",
    Object.keys(r1.body ?? {})
      .sort()
      .join(",") === "activationLink,expiresAt,pendingId,renewed",
  );
  const oldTry = await anon().auth.verifyOtp({
    token_hash: tokenHash(firstLink),
    type: "recovery",
  });
  check("R2 the previously issued link no longer works", !!oldTry.error);
  const newTry = await anon().auth.verifyOtp({
    token_hash: tokenHash(newLink),
    type: "recovery",
  });
  check(
    "R2 the new link works (redeems to the approval's own account)",
    !newTry.error && newTry.data?.user?.email === email("fresh"),
  );

  psql(
    `update public.election_workspace_pending_owner_access set expires_at = now() - interval '1 day' where id = '${firstPendingId}';`,
  );
  const r3 = await reissue(firstPendingId, PO);
  const exp = Date.parse(r3.body?.expiresAt ?? "");
  check(
    "R3 expired -> 200 renewed=true, window ~7 days, link present",
    r3.statusCode === 200 &&
      r3.body?.renewed === true &&
      Math.abs(exp - (Date.now() + 7 * 864e5)) < 5 * 60e3 &&
      !!r3.body?.activationLink,
    JSON.stringify({ s: r3.statusCode, renewed: r3.body?.renewed }),
  );
  check(
    "R3 the approval is pending again in the DB",
    pendingFor(email("fresh")).endsWith("|pending"),
  );

  setFaults({
    admin: { generateLink: () => ({ data: null, error: { message: "injected" } }) },
  });
  const r4 = await reissue(firstPendingId, PO);
  clearFaults();
  const r4b = await reissue(firstPendingId, PO);
  check(
    "R4 link failure -> 200 with activationLink null; a retry issues the link",
    r4.statusCode === 200 &&
      r4.body?.activationLink === null &&
      r4b.statusCode === 200 &&
      !!r4b.body?.activationLink,
    `${r4.statusCode}/${r4b.statusCode}`,
  );

  const racePending = pendingFor(email("race")).split("|")[0];
  psql(
    `update public.election_workspace_pending_owner_access set status = 'consumed', consumed_at = now() where id = '${racePending}';`,
  );
  const r5 = await reissue(racePending, PO);
  check(
    "R5 consumed -> 409 PENDING_ACCESS_ALREADY_CONSUMED",
    r5.statusCode === 409 && r5.body?.error === "PENDING_ACCESS_ALREADY_CONSUMED",
    String(r5.statusCode),
  );
  const listed = (await listOp(PO)).body?.approvals?.find(
    (x) => x.pending_id === racePending,
  );
  check("R5 the list reports it as consumed", listed?.state === "consumed");

  check(
    "R6 unknown id -> 404 PENDING_ACCESS_NOT_FOUND",
    (await reissue("00000000-0000-4000-8000-000000000000", PO)).body?.error ===
      "PENDING_ACCESS_NOT_FOUND",
  );
  check("R6 malformed id -> 400", (await reissue("not-a-uuid", PO)).statusCode === 400);
  check(
    "R6 extra body key -> 400",
    (
      await pPost(
        { op: "reissue_owner_access", pendingId: firstPendingId, expiresInDays: 30 },
        PO,
      )
    ).statusCode === 400,
  );
  check(
    "R7 no Origin -> 403",
    (await pPost({ op: "reissue_owner_access", pendingId: firstPendingId }, PO, null))
      .statusCode === 403,
  );
  check(
    "R7 foreign Origin -> 403",
    (
      await pPost(
        { op: "reissue_owner_access", pendingId: firstPendingId },
        PO,
        "https://evil.example",
      )
    ).statusCode === 403,
  );
  check("R7 no token -> 401", (await reissue(firstPendingId, null)).statusCode === 401);
  check(
    "R7 aal1 Platform Owner -> 401",
    (await reissue(firstPendingId, PO_AAL1)).statusCode === 401,
  );
  check(
    "R7 aal2 stranger -> 401",
    (await reissue(firstPendingId, STRANGER)).statusCode === 401,
  );
  check(
    "R8 re-issue never created or removed an Auth user",
    (await listUsers()).length === usersBefore,
  );
}

// ---------------------------------------------------------------------------
section("CLEANUP");
clearFaults();
psql(
  `delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}'; delete from public.platform_owners;`,
);
for (const u of await listUsers()) {
  if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check(
  "CLEANUP synthetic identities removed",
  (await listUsers()).every((u) => !u.email?.toLowerCase().endsWith(`@${DOMAIN}`)),
);

process.exit(tally("STAGE 8B API") > 0 ? 1 : 0);
