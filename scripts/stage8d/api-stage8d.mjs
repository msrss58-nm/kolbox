// Platform Stage 8D - REAL-LOCAL API suite: H-3 recovery-link takeover
// remediation (migration 20260915000000 + api/platform/session.ts reissue
// finalize). Real GoTrue + real Postgres (scratch stack kolboxs5), the REAL
// bundled Platform + Owner handlers, synthetic *@stage8d-api.invalid identities.
//
// Asserts the SECURE post-fix invariants as PASS: once provisioning is committed
// and the approval consumed, NO outstanding approval-originated recovery link
// (original or re-issued) can establish an Owner session or reset the password;
// the reissue-after-consume race returns 409 with the just-minted link dead; and
// the legitimate pre-provision reissue/renew flow still works with no duplicate
// auth user / orphan approval / Owner lockout.
//
// Run:  S5_STACK_DIR=<scratch>/s8stack [S5_PORT_OFFSET=1000] node scripts/stage8d/api-stage8d.mjs
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
const handlers = await buildHandlers();
const PS = handlers.platformSession;
const OA = handlers.ownerActions;
const a = admin();

const DOMAIN = "stage8d-api.invalid";
const email = (l) => `${l}@${DOMAIN}`;
let seq = 0;
const uniq = (l) => email(`${l}-${Date.now().toString(36)}-${seq++}`);

const pPost = (body, token) =>
  callHandler(PS, {
    method: "POST",
    url: "/api/platform/session",
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    body,
  });
const th = (link) => {
  try {
    return new URL(link).searchParams.get("token_hash");
  } catch {
    return null;
  }
};
const provision = (token, name) =>
  callHandler(OA, {
    method: "POST",
    url: "/api/election-day/owner-actions",
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    body: { op: "provision_workspace", workspaceName: name, electionEndAt: "2026-12-31T20:00:00Z" },
  });

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

// linkRedeems: true if the recovery link still opens a session (i.e. exploitable)
async function linkRedeems(link) {
  const r = await anon().auth.verifyOtp({ token_hash: th(link), type: "recovery" });
  return { ok: !r.error, token: r.data?.session?.access_token ?? null, err: r.error?.code ?? r.error?.status ?? "" };
}
async function ownerSession(token) {
  if (!token) return -1;
  const r = await callHandler(OA, {
    method: "GET",
    url: "/api/election-day/owner-actions?op=session",
    headers: { authorization: `Bearer ${token}` },
  });
  return r.statusCode;
}

// Build a Platform Owner (aal2) once.
section("SETUP");
psql(`
  delete from public.multi_entity_assignments; delete from public.multi_entity_owner;
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.platform_owners;
  delete from public.election_workspaces where name like 'S8D %';
`);
for (const u of await listUsers()) if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
const poPw = randomPassword();
const { data: po } = await a.auth.admin.createUser({ email: email("po"), password: poPw, email_confirm: true });
psql(`insert into public.platform_owners (auth_user_id, name, email) values ('${po.user.id}', 'S8D PO', '${email("po")}');`);
const PO = (await enrollTotp((await signIn(email("po"), poPw)).client, "s8d-po")).token;
check("SETUP Platform Owner aal2 ready", !!PO);

// approve an owner, redeem L1, set password, return { addr, pendingId, ownerPw, ownerToken }
async function freshOwner(label) {
  const addr = uniq(label);
  const appr = await pPost({ op: "create_owner_access", name: `EO ${label}`, email: addr, modules: ["election_day"] }, PO);
  const pendingId = appr.body?.pendingId;
  const L1 = appr.body?.activationLink;
  const c = anon();
  await c.auth.verifyOtp({ token_hash: th(L1), type: "recovery" });
  const ownerPw = randomPassword();
  await c.auth.updateUser({ password: ownerPw });
  const ownerToken = (await signIn(addr, ownerPw)).token;
  return { addr, pendingId, ownerPw, ownerToken, L1 };
}

// -------------------------------------------------------------------------
section("H-3 CORE: reissued link is dead after provisioning (the exploit, now blocked)");
{
  const o = await freshOwner("core");
  const re = await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO);
  const L2 = re.body?.activationLink;
  check("C1 reissue while active -> 200 + a live link (legitimate)", re.statusCode === 200 && !!L2);
  const prov = await provision(o.ownerToken, "S8D core");
  check("C2 owner provisions -> 200, approval consumed", prov.statusCode === 200 && psql(`select status from public.election_workspace_pending_owner_access where id='${o.pendingId}'`) === "consumed");
  const red = await linkRedeems(L2);
  check("C3 the re-issued link is DEAD after provisioning (no redeem)", !red.ok, `err=${red.err}`);
  check("C4 it opens NO owner session", (await ownerSession(red.token)) !== 200);
  // takeover attempt fully neutralised: owner's own password still works
  const ownerStill = await anon().auth.signInWithPassword({ email: o.addr, password: o.ownerPw });
  check("C5 the real owner's password still works (no lockout / no takeover)", !ownerStill.error);
}

// -------------------------------------------------------------------------
section("H-3 RACE MATRIX");
{
  // R1 provision BEFORE the reissue RPC -> RPC serializes on the consumed row -> 409
  const o = await freshOwner("r1");
  await provision(o.ownerToken, "S8D r1");
  const re = await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO);
  check("R1 reissue of an already-provisioned approval -> 409 PENDING_ACCESS_ALREADY_CONSUMED, no link", re.statusCode === 409 && re.body?.error === "PENDING_ACCESS_ALREADY_CONSUMED" && !re.body?.activationLink, `st=${re.statusCode}`);
}
{
  // R2 the finalize path: reissue RPC returns active, link minted, THEN provision
  // consumes DURING the mint window -> finalize must invalidate + 409. Modelled
  // deterministically at the primitive level: run the reissue RPC, mint a link,
  // provision (consume), then call platform_reissue_finalize -> consumed + link dead.
  const o = await freshOwner("r2");
  const rpc = await a.rpc("platform_reissue_pending_owner_access", { p_platform_owner_auth_user_id: po.user.id, p_pending_id: o.pendingId, p_expires_in_days: 7 });
  check("R2a reissue RPC (active) returns the owner account", !rpc.error && rpc.data?.auth_user_id, rpc.error?.message ?? "");
  const g = await a.auth.admin.generateLink({ type: "recovery", email: o.addr });
  const L2 = `${ORIGIN}/election-day/owner-set-password?token_hash=${g.data?.properties?.hashed_token}&type=recovery`;
  await provision(o.ownerToken, "S8D r2"); // consumes during the "mint window"
  const fin = await a.rpc("platform_reissue_finalize", { p_platform_owner_auth_user_id: po.user.id, p_pending_id: o.pendingId });
  check("R2b finalize sees the race and reports consumed=true", !fin.error && fin.data?.consumed === true, fin.error?.message ?? JSON.stringify(fin.data));
  check("R2c the link minted mid-race is DEAD (finalize invalidated it)", !(await linkRedeems(L2)).ok);
}
{
  // R3 simultaneous reissue + provision, several rounds. Whatever the interleave,
  // after both settle: approval consumed, no usable link survives, owner intact.
  let clean = 0;
  const rounds = 4;
  for (let i = 0; i < rounds; i++) {
    const o = await freshOwner(`r3-${i}`);
    const [re] = await Promise.all([
      pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO),
      provision(o.ownerToken, `S8D r3-${i}`),
    ]);
    const consumed = psql(`select status from public.election_workspace_pending_owner_access where id='${o.pendingId}'`) === "consumed";
    // if the handler returned a link, it must NOT be usable now that provisioning committed
    const link = re.statusCode === 200 ? re.body?.activationLink : null;
    const usable = link ? (await linkRedeems(link)).ok : false;
    const ownerOk = !(await anon().auth.signInWithPassword({ email: o.addr, password: o.ownerPw })).error;
    if (consumed && !usable && ownerOk) clean++;
  }
  check("R3 simultaneous reissue+provision: no usable post-consume link, owner intact", clean === rounds, `${clean}/${rounds}`);
}
{
  // R4 two reissues, then provision -> every issued link dead
  const o = await freshOwner("r4");
  const a1 = (await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO)).body?.activationLink;
  const a2 = (await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO)).body?.activationLink;
  check("R4a the earlier reissued link is already dead once a newer one is minted", !(await linkRedeems(a1)).ok);
  await provision(o.ownerToken, "S8D r4");
  check("R4b the newest reissued link is dead after provisioning", !(await linkRedeems(a2)).ok);
}
{
  // R5 response-lost-after-reissue retry: reissue twice (idempotent), then provision.
  // No duplicate auth user / orphan approval, and no surviving link.
  const o = await freshOwner("r5");
  const l1 = (await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO)).body?.activationLink;
  const l2 = (await pPost({ op: "reissue_owner_access", pendingId: o.pendingId }, PO)).body?.activationLink;
  await provision(o.ownerToken, "S8D r5");
  const users = await usersWith(o.addr);
  const pend = psql(`select count(*) from public.election_workspace_pending_owner_access where lower(email)=lower('${o.addr}')`);
  check("R5 no dup auth user, exactly one approval, both links dead", users.length === 1 && pend === "1" && !(await linkRedeems(l1)).ok && !(await linkRedeems(l2)).ok, `users=${users.length} pend=${pend}`);
}

// -------------------------------------------------------------------------
section("LEGITIMATE FLOW NON-REGRESSION");
{
  // L1 pre-provision reissue works end to end (owner can still set password + provision)
  const addr = uniq("legit");
  const appr = await pPost({ op: "create_owner_access", name: "EO legit", email: addr, modules: ["election_day"] }, PO);
  const re = await pPost({ op: "reissue_owner_access", pendingId: appr.body?.pendingId }, PO);
  const L2 = re.body?.activationLink;
  const c = anon();
  const red = await c.auth.verifyOtp({ token_hash: th(L2), type: "recovery" });
  check("L1 a pre-provision reissued link still redeems (legit recovery preserved)", !red.error);
  const pw = randomPassword();
  await c.auth.updateUser({ password: pw });
  const tok = (await signIn(addr, pw)).token;
  const prov = await provision(tok, "S8D legit");
  check("L1b owner sets password via reissued link and provisions successfully", prov.statusCode === 200);
}
{
  // L2 expired approval renewal still works
  const addr = uniq("exp");
  const appr = await pPost({ op: "create_owner_access", name: "EO exp", email: addr, modules: ["election_day"] }, PO);
  psql(`update public.election_workspace_pending_owner_access set expires_at = now() - interval '1 day' where id='${appr.body?.pendingId}'`);
  const re = await pPost({ op: "reissue_owner_access", pendingId: appr.body?.pendingId }, PO);
  check("L2 expired approval -> renewed=true, fresh window, usable link", re.statusCode === 200 && re.body?.renewed === true && !!re.body?.activationLink && (await linkRedeems(re.body.activationLink)).ok, `st=${re.statusCode} renewed=${re.body?.renewed}`);
}

section("CLEANUP");
psql(`
  delete from public.election_owners where email like '%@${DOMAIN}';
  delete from public.election_workspace_pending_owner_access where email like '%@${DOMAIN}';
  delete from public.election_workspaces where name like 'S8D %';
  delete from public.platform_owners;
`);
for (const u of await listUsers()) if (u.email?.toLowerCase().endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);

process.exit(tally("STAGE 8D API") > 0 ? 1 : 0);
