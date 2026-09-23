// Multi-Entity MULTI-OWNER - API suite, against the REAL bundled handlers.
//
// The DB suite (scripts/multi-owner/db-multi-owner.sql) proves the RPCs are
// owner-scoped. This one proves the HTTP surface in front of them is too:
// that an owner selector is genuinely required where it matters, that it is
// never inferred, and that two real aal2 Multi-Entity Owners signing in at the
// same time see strictly their own workspaces and nothing else.
//
// Real Auth users, real passwords, real TOTP/aal2 sessions, on the isolated
// kolboxs5 scratch stack only. Synthetic *@multiowner-api.invalid identities.
// Nothing secret is printed.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/multi-owner/api-multi-owner.mjs
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
  verifyTotp,
} from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();

const ORIGIN = "https://platform.test";
process.env.PLATFORM_ALLOWED_ORIGIN = ORIGIN;
process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL = "http://127.0.0.1:5186";
process.env.KOLBOX_ELECTION_APP_BASE_URL = "http://127.0.0.1:5187";

const H = await buildHandlers();
const PS = H.platformSession;
const a = admin();
const DOMAIN = "multiowner-api.invalid";
const email = (l) => `${l}@${DOMAIN}`;
const stamp = Date.now();

const auth = (t) => ({ authorization: `Bearer ${t}` });
const pGet = (url, token) => callHandler(PS, { method: "GET", url, headers: auth(token) });
const pPost = (body, token) =>
  callHandler(PS, {
    method: "POST",
    url: "/api/platform/session",
    headers: { ...auth(token), origin: ORIGIN, "content-type": "application/json" },
    body,
  });
const meGet = (op, token, extra = "") =>
  pGet(`/api/platform/session?me_op=${op}${extra}`, token);

// ------------------------------------------------------------- fixtures ----
section("FIXTURES");
psql(`
  delete from public.multi_entity_assignments;
  delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'MOAPI %';
`);
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
for (const u of await listUsers()) {
  if (u.email?.endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}

const poPw = randomPassword();
const { data: poUser } = await a.auth.admin.createUser({
  email: email("po"),
  password: poPw,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'MO API PO', '${email("po")}');`,
);
const PO = (await enrollTotp((await signIn(email("po"), poPw)).client, "mo-api-po")).token;

const wsRows = psql(`
  insert into public.election_workspaces (name, election_end_at, login_code) values
    ('MOAPI Alpha',  now() + interval '10 days', public.election_day_generate_workspace_login_code()),
    ('MOAPI Beta',   now() + interval '12 days', public.election_day_generate_workspace_login_code()),
    ('MOAPI Shared', now() + interval '14 days', public.election_day_generate_workspace_login_code())
  returning name || '|' || id;
`).split("\n");
const WS = Object.fromEntries(
  wsRows.map((r) => {
    const [name, id] = r.split("|");
    return [name.replace("MOAPI ", ""), id];
  }),
);
check("F1 three workspaces created", Object.keys(WS).length === 3, JSON.stringify(Object.keys(WS)));

// =========================================================================
section("A. ADDING SEVERAL OWNERS THROUGH THE REAL ENDPOINT");
// =========================================================================
async function addOwner(label) {
  return pPost(
    {
      op: "provision_multi_entity_owner",
      name: `Owner ${label}`,
      email: email(label),
      phone: "0501234567",
      username: `mo-${label}-${stamp}`,
    },
    PO,
  );
}

const a1 = await addOwner("one");
check("A1 first owner created (201) with an owner_id", a1.statusCode === 201 && typeof a1.body?.ownerId === "string", `${a1.statusCode} ${JSON.stringify(a1.body?.ownerId)}`);
const a2 = await addOwner("two");
check(
  "A2 SECOND owner created alongside the first - no replacement, no 409",
  a2.statusCode === 201 && a2.body?.replaced === false && a2.body.ownerId !== a1.body.ownerId,
  `${a2.statusCode} replaced=${a2.body?.replaced}`,
);
const a3 = await addOwner("three");
check("A3 a third owner too", a3.statusCode === 201, String(a3.statusCode));

const OWNER_1 = a1.body.ownerId;
const OWNER_2 = a2.body.ownerId;
const OWNER_3 = a3.body.ownerId;

const state1 = await pGet("/api/platform/session?op=multi_entity_state", PO);
check(
  // Phase-independent. Under EXPAND the legacy `seat` key still exists for the
  // PREVIOUS deployment, but must be null once several owners exist rather
  // than naming an arbitrary one; under CONTRACT it is gone entirely. Both
  // satisfy the invariant that matters: `owners` is authoritative, and `seat`
  // never points at one of several.
  "A4 the console state lists all three owners, and never an arbitrary single seat",
  state1.statusCode === 200 &&
    Array.isArray(state1.body?.owners) &&
    state1.body.owners.length === 3 &&
    (state1.body.seat === undefined || state1.body.seat === null),
  `owners=${state1.body?.owners?.length} seat=${JSON.stringify(state1.body?.seat)}`,
);
check(
  "A5 each owner carries their OWN login username (resolved per identity)",
  new Set(state1.body.owners.map((o) => o.username)).size === 3 &&
    state1.body.owners.every((o) => typeof o.username === "string" && o.username.startsWith("mo-")),
  JSON.stringify(state1.body.owners.map((o) => o.username)),
);
check(
  "A6 every owner starts with an empty assignment list, never null",
  state1.body.owners.every((o) => Array.isArray(o.assigned_workspace_ids) && o.assigned_workspace_ids.length === 0),
  "",
);

// =========================================================================
section("B. THE OWNER SELECTOR IS REQUIRED, AND NEVER INFERRED");
// =========================================================================
const noOwner = await pPost({ op: "assign_workspace", workspaceId: WS.Alpha }, PO);
check(
  "B1 assign WITHOUT an ownerId is refused (400) - not silently applied to someone",
  noOwner.statusCode === 400,
  `${noOwner.statusCode} ${JSON.stringify(noOwner.body)}`,
);
const noOwnerUn = await pPost({ op: "unassign_workspace", workspaceId: WS.Alpha }, PO);
check("B2 unassign WITHOUT an ownerId is refused (400)", noOwnerUn.statusCode === 400, String(noOwnerUn.statusCode));
const badOwner = await pPost(
  { op: "assign_workspace", ownerId: "not-a-uuid", workspaceId: WS.Alpha },
  PO,
);
check("B3 a malformed ownerId is refused (400)", badOwner.statusCode === 400, String(badOwner.statusCode));
const missingOwner = await pPost(
  { op: "assign_workspace", ownerId: "00000000-0000-4000-8000-000000000000", workspaceId: WS.Alpha },
  PO,
);
check(
  "B4 assigning to a NONEXISTENT owner is refused even though other owners exist",
  missingOwner.statusCode === 409,
  `${missingOwner.statusCode} ${JSON.stringify(missingOwner.body)}`,
);
const extraKey = await pPost(
  { op: "assign_workspace", ownerId: OWNER_1, workspaceId: WS.Alpha, authUserId: "x" },
  PO,
);
check("B5 an unexpected body key is still refused (400)", extraKey.statusCode === 400, String(extraKey.statusCode));

// =========================================================================
section("C. ASSIGNMENT, INCLUDING A SHARED WORKSPACE");
// =========================================================================
const okA = await pPost({ op: "assign_workspace", ownerId: OWNER_1, workspaceId: WS.Alpha }, PO);
check("C1 owner 1 assigned Alpha", okA.statusCode === 200, String(okA.statusCode));
await pPost({ op: "assign_workspace", ownerId: OWNER_1, workspaceId: WS.Shared }, PO);
await pPost({ op: "assign_workspace", ownerId: OWNER_2, workspaceId: WS.Beta }, PO);
const shared = await pPost({ op: "assign_workspace", ownerId: OWNER_2, workspaceId: WS.Shared }, PO);
check(
  "C2 THE SAME workspace assigned to a SECOND owner succeeds (was structurally impossible)",
  shared.statusCode === 200 && shared.body?.already_assigned === false,
  `${shared.statusCode} ${JSON.stringify(shared.body)}`,
);
const again = await pPost({ op: "assign_workspace", ownerId: OWNER_2, workspaceId: WS.Shared }, PO);
check(
  "C3 re-assigning the same pair is an idempotent no-op",
  again.statusCode === 200 && again.body?.already_assigned === true,
  JSON.stringify(again.body),
);

const state2 = await pGet("/api/platform/session?op=multi_entity_state", PO);
const sharedWs = state2.body.workspaces.find((w) => w.workspace_id === WS.Shared);
check(
  "C4 the console reports BOTH owners on the shared workspace",
  Array.isArray(sharedWs?.assigned_owner_ids) &&
    sharedWs.assigned_owner_ids.length === 2 &&
    sharedWs.assigned_owner_ids.includes(OWNER_1) &&
    sharedWs.assigned_owner_ids.includes(OWNER_2),
  JSON.stringify(sharedWs?.assigned_owner_ids),
);
const ownerThree = state2.body.owners.find((o) => o.owner_id === OWNER_3);
check(
  "C5 the owner assigned nothing reports an empty list, not everyone's workspaces",
  ownerThree?.assigned_workspace_ids.length === 0,
  JSON.stringify(ownerThree?.assigned_workspace_ids),
);

// =========================================================================
section("D. TWO LIVE OWNERS - REAL aal2 SESSIONS, REAL ISOLATION");
// =========================================================================
/** Takes an owner from the activation link through to an aal2 session. */
async function liveOwner(label, ownerId) {
  const authUserId = psql(
    `select auth_user_id from public.multi_entity_owner where owner_id = '${ownerId}';`,
  ).trim();
  const pw = randomPassword();
  const { error } = await a.auth.admin.updateUserById(authUserId, { password: pw });
  if (error) throw new Error(`setPassword ${label}: ${error.message}`);
  const s = await signIn(email(label), pw);
  const en = await enrollTotp(s.client, `mo-api-${label}`);
  return { authUserId, pw, factor: en, token: en.token };
}

const live1 = await liveOwner("one", OWNER_1);
const live2 = await liveOwner("two", OWNER_2);
const live3 = await liveOwner("three", OWNER_3);

const s1 = await meGet("session", live1.token);
const s2 = await meGet("session", live2.token);
check(
  "D1 BOTH owners hold a valid Multi-Entity session at the same time",
  s1.statusCode === 200 && s2.statusCode === 200,
  `${s1.statusCode}/${s2.statusCode}`,
);
const names1 = (s1.body?.workspaces ?? []).map((w) => w.name).sort();
const names2 = (s2.body?.workspaces ?? []).map((w) => w.name).sort();
check(
  "D2 owner 1 sees exactly Alpha + Shared",
  JSON.stringify(names1) === JSON.stringify(["MOAPI Alpha", "MOAPI Shared"]),
  JSON.stringify(names1),
);
check(
  "D3 owner 2 sees exactly Beta + Shared - NOT Alpha",
  JSON.stringify(names2) === JSON.stringify(["MOAPI Beta", "MOAPI Shared"]),
  JSON.stringify(names2),
);
const s3 = await meGet("session", live3.token);
check(
  "D4 the unassigned owner is authorized but sees nothing (not refused, not everything)",
  s3.statusCode === 200 && (s3.body?.workspaces ?? []).length === 0,
  `${s3.statusCode} n=${s3.body?.workspaces?.length}`,
);

// The single-workspace endpoint is the per-workspace leak path.
const cross = await meGet("workspace", live2.token, `&workspaceId=${WS.Alpha}`);
check(
  "D5 owner 2 asking for owner 1's workspace is FORBIDDEN (403)",
  cross.statusCode === 403,
  `${cross.statusCode} ${JSON.stringify(cross.body)}`,
);
const own = await meGet("workspace", live1.token, `&workspaceId=${WS.Alpha}`);
check("D6 ... and owner 1 gets it (D5 is not a blanket refusal)", own.statusCode === 200, String(own.statusCode));
const sharedRead1 = await meGet("workspace", live1.token, `&workspaceId=${WS.Shared}`);
const sharedRead2 = await meGet("workspace", live2.token, `&workspaceId=${WS.Shared}`);
check(
  "D7 the SHARED workspace is readable by both, and reports the same workspace",
  sharedRead1.statusCode === 200 &&
    sharedRead2.statusCode === 200 &&
    sharedRead1.body?.workspace?.name === sharedRead2.body?.workspace?.name,
  `${sharedRead1.statusCode}/${sharedRead2.statusCode}`,
);

// Aggregates carry business data - the highest-value leak path.
const agg1 = await meGet("aggregates", live1.token);
const agg2 = await meGet("aggregates", live2.token);
check(
  "D8 aggregate lists are owner-scoped too",
  agg1.statusCode === 200 &&
    agg2.statusCode === 200 &&
    !JSON.stringify(agg2.body).includes("MOAPI Alpha") &&
    JSON.stringify(agg1.body).includes("MOAPI Alpha"),
  `${agg1.statusCode}/${agg2.statusCode}`,
);
const aggCross = await meGet("workspace_aggregates", live2.token, `&workspaceId=${WS.Alpha}`);
check(
  "D9 a cross-owner aggregate read is FORBIDDEN (403) - no counts leak",
  aggCross.statusCode === 403,
  String(aggCross.statusCode),
);
check(
  "D10 a Platform Owner token is still refused on the Multi-Entity partition",
  (await meGet("session", PO)).statusCode === 401,
);

// =========================================================================
section("E. UNASSIGN AND REMOVE ARE OWNER-SCOPED");
// =========================================================================
const un = await pPost({ op: "unassign_workspace", ownerId: OWNER_1, workspaceId: WS.Shared }, PO);
check("E1 owner 1 unassigned from the shared workspace", un.statusCode === 200 && un.body?.removed === true, JSON.stringify(un.body));
const after1 = await meGet("session", live1.token);
const after2 = await meGet("session", live2.token);
check(
  "E2 owner 1 immediately loses it",
  !(after1.body?.workspaces ?? []).some((w) => w.name === "MOAPI Shared"),
  JSON.stringify((after1.body?.workspaces ?? []).map((w) => w.name)),
);
check(
  "E3 ... and owner 2 STILL has it (one unassign never revokes another owner)",
  (after2.body?.workspaces ?? []).some((w) => w.name === "MOAPI Shared"),
  JSON.stringify((after2.body?.workspaces ?? []).map((w) => w.name)),
);

const removed = await pPost({ op: "remove_multi_entity_owner", ownerId: OWNER_2 }, PO);
check(
  "E4 removing owner 2 succeeds and names their Auth account for the purge step",
  removed.statusCode === 200 && removed.body?.previousAuthUserId === live2.authUserId,
  `${removed.statusCode} ${JSON.stringify(removed.body)}`,
);
const dead = await meGet("session", live2.token);
check("E5 the removed owner's live session stops working immediately (401)", dead.statusCode === 401, String(dead.statusCode));
const survivor = await meGet("session", live1.token);
check("E6 the OTHER owners are unaffected", survivor.statusCode === 200, String(survivor.statusCode));

const state3 = await pGet("/api/platform/session?op=multi_entity_state", PO);
check("E7 the console now lists two owners", state3.body.owners.length === 2, String(state3.body.owners.length));
check(
  "E8 the removed owner's Auth account is queued for the separate purge",
  JSON.stringify(state3.body.pending_auth_cleanup).includes(live2.authUserId),
  JSON.stringify(state3.body.pending_auth_cleanup).slice(0, 160),
);
const purge = await pPost({ op: "purge_replaced_auth_user", previousAuthUserId: live2.authUserId }, PO);
check(
  "E9 ... and that purge actually runs for a REMOVED owner, not only a replaced one",
  purge.statusCode === 200 && purge.body?.previousAccountDeleted === true,
  `${purge.statusCode} ${JSON.stringify(purge.body)}`,
);
// The response is a claim; this is the fact. Without the guard widening, the
// guard would have answered NOT_A_REPLACED_PRINCIPAL and this row would still
// be here - which is exactly the regression this check exists to catch.
check(
  "E9b ... and the Auth account is GONE from the database, not merely reported gone",
  psql(`select count(*) from auth.users where id = '${live2.authUserId}';`).trim() === "0",
  psql(`select count(*) from auth.users where id = '${live2.authUserId}';`).trim(),
);
check(
  "E9c ... and the terminal audit row was written (the purge is recorded, not silent)",
  psql(
    `select count(*) from public.multi_entity_audit where action='previous_auth_deleted' and previous_auth_user_id='${live2.authUserId}';`,
  ).trim() === "1",
);

const removeMissing = await pPost(
  { op: "remove_multi_entity_owner", ownerId: "00000000-0000-4000-8000-000000000000" },
  PO,
);
check("E10 removing a nonexistent owner is refused (404)", removeMissing.statusCode === 404, String(removeMissing.statusCode));

// =========================================================================
section("F. REPLACEMENT STILL WORKS, AND IS OWNER-SCOPED");
// =========================================================================
const replaced = await pPost(
  {
    op: "provision_multi_entity_owner",
    ownerId: OWNER_1,
    name: "Owner One Successor",
    email: email(`successor-${stamp}`),
    phone: "0509998888",
    username: `mo-successor-${stamp}`,
  },
  PO,
);
check(
  "F1 replacing a NAMED owner reports replaced=true and keeps the owner_id",
  replaced.statusCode === 201 && replaced.body?.replaced === true && replaced.body.ownerId === OWNER_1,
  `${replaced.statusCode} ${JSON.stringify(replaced.body?.ownerId)}`,
);
check(
  "F2 the predecessor's session stops working",
  (await meGet("session", live1.token)).statusCode === 401,
);
const state4 = await pGet("/api/platform/session?op=multi_entity_state", PO);
const successor = state4.body.owners.find((o) => o.owner_id === OWNER_1);
check(
  "F3 the successor inherited that owner's assignments",
  successor?.assigned_workspace_ids.length === 1 &&
    successor.assigned_workspace_ids[0] === WS.Alpha,
  JSON.stringify(successor?.assigned_workspace_ids),
);
check("F4 the owner count is unchanged by a replacement", state4.body.owners.length === 2, String(state4.body.owners.length));
check(
  "F5 the third owner, untouched throughout, is still there and still sees nothing",
  (await meGet("session", live3.token)).statusCode === 200 &&
    ((await meGet("session", live3.token)).body?.workspaces ?? []).length === 0,
);

tally("MULTI-OWNER API");
