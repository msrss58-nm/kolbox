// ACTIVITY-LOG PURGE + PLATFORM-DRIVEN BUDGET EXPORT - API suite.
//
// Drives the REAL bundled handlers against the isolated kolboxs5 scratch stack.
// The database contract is proven by scripts/platform/db-audit-purge.sql; this
// suite proves what only the HTTP boundary can:
//
//   * the purge is refused without a Platform Owner session, from a foreign
//     Origin, with an Election Owner's own token, and without the word
//   * it really empties what the activity-log endpoint returns
//   * a workspace HOLDING Budget data can be deleted, once - and only once -
//     the export has actually been produced and verified through the same ops
//     the Election Owner's own export uses
//   * an export that is started but not completed leaves the workspace exactly
//     as it was, and the guard still refuses
//   * another workspace is untouched throughout
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/platform/api-audit-purge.mjs
import { createHash } from "node:crypto";
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
process.env.BUDGET_ALLOWED_ORIGIN = ELECTION_ORIGIN;

const H = await buildHandlers();
const PS = H.platformSession;
const A = admin();
const DOMAIN = "purge-api.invalid";
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
const pGet = (url, token) =>
  callHandler(PS, { method: "GET", url, headers: token ? auth(token) : {} });

const one = (sql) => psql(sql).trim();
const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
/** Every row anywhere that still names this workspace. */
const owned = (ws) =>
  Number(
    one(`select coalesce(sum(n), 0) from (
      select (xpath('/row/c/text()', query_to_xml(
        format('select count(*) as c from %s where workspace_id = %L', c.oid::regclass, '${ws}'),
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
  -- Deliberately NOT forced: a leftover workspace still holding Budget data is
  -- protected by the very guard this suite exists to prove.
  delete from public.election_workspaces w
   where w.name like 'PGAPI %' and not public.budget_workspace_has_data(w.id);
`);
for (let p = 1; p < 20; p++) {
  const { data, error } = await A.auth.admin.listUsers({ page: p, perPage: 200 });
  if (error) throw error;
  for (const u of data.users) {
    if (u.email?.endsWith(`@${DOMAIN}`)) await A.auth.admin.deleteUser(u.id);
  }
  if (data.users.length < 200) break;
}

const PW = randomPassword();
const { data: poUser } = await A.auth.admin.createUser({
  email: email("po"),
  password: PW,
  email_confirm: true,
});
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${poUser.user.id}', 'PGAPI PO', '${email("po")}');`,
);
const PO = (await enrollTotp((await signIn(email("po"), PW)).client, "pgapi-po")).token;

/** A real workspace with an Owner, and optionally real Budget data. */
async function makeWorkspace(label, { budget = false } = {}) {
  const mail = email(`owner-${label}`);
  const { data, error } = await A.auth.admin.createUser({
    email: mail,
    password: PW,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${label}: ${error.message}`);
  const ws = one(`insert into public.election_workspaces (name, login_code, election_end_at)
    values ('PGAPI ${label}', public.election_day_generate_workspace_login_code(), now() + interval '20 days')
    returning id;`);
  psql(`
    insert into public.election_owners (workspace_id, auth_user_id, name, email)
      values ('${ws}', '${data.user.id}', 'PGAPI Owner ${label}', '${mail}');
    insert into public.election_workspace_modules (workspace_id, module_key)
      values ('${ws}', 'election_day')${budget ? `, ('${ws}', 'budget')` : ""};
    insert into public.election_day_voters (workspace_id, masad, first_name, last_name, city, street, house_number)
      values ('${ws}', 'PGAPI', '${label}', 'Voter', 'City', 'Street', 1);
  `);
  if (budget) {
    // Real Budget rows, with the actor context the append-only audit demands.
    psql(`
      select set_config('kolbox.budget_actor',
        format('{"type":"owner","id":"%s","name":"PGAPI Owner ${label}","workspace_id":"%s"}', '${data.user.id}', '${ws}'), false);
      insert into public.budget_settings (workspace_id) values ('${ws}');
      insert into public.budget_categories (workspace_id, name) values ('${ws}', 'PGAPI Category ${label}');
      insert into public.budget_funding_sources (workspace_id, name, kind, original_amount_agorot)
        values ('${ws}', 'PGAPI Source ${label}', 'donation', 100000);
    `);
  }
  const { token } = await signIn(mail, PW);
  return { label, mail, authUserId: data.user.id, workspaceId: ws, name: `PGAPI ${label}`, token, ownedAtStart: owned(ws) };
}

const WITH = await makeWorkspace("WithBudget", { budget: true });
const OTHER = await makeWorkspace("Other");

// Something in the activity log, from a real audited action.
psql(`
  insert into public.platform_module_availability_audit (module_key, previous_available, new_available, acting_platform_owner_auth_user_id)
  values ('budget', false, true, '${poUser.user.id}');
  insert into public.platform_owner_account_audit
    (acting_platform_owner_auth_user_id, action, target_workspace_id_snapshot, target_owner_auth_user_id_snapshot, target_owner_email_snapshot, details)
  values ('${poUser.user.id}', 'profile_updated', '${WITH.workspaceId}', '${WITH.authUserId}', '${WITH.mail}', '{"changed":["name"]}'::jsonb);
`);

const logRows = async () => {
  const r = await pGet("/api/platform/session?op=activity&limit=500", PO);
  const events = r.body?.events;
  return Array.isArray(events) ? events.length : -1;
};
const before = await logRows();
check("F1 the activity endpoint returns real recorded events", before > 1, `rows=${before}`);
check(
  "F2 a workspace holding real Budget data, and a second one that does not",
  one(`select public.budget_workspace_has_data('${WITH.workspaceId}');`) === "t" &&
    one(`select public.budget_workspace_has_data('${OTHER.workspaceId}');`) === "f",
  `with=${WITH.ownedAtStart} other=${OTHER.ownedAtStart}`,
);

// =========================================================================
section("A. WHO MAY PURGE THE LOG");
// =========================================================================
const PURGE = { op: "purge_activity_log", confirm: "מחיקה" };
check("A1 no session -> 401", (await pPost(PURGE, null)).statusCode === 401);
check(
  "A2 an ELECTION OWNER's own token -> 401",
  (await pPost(PURGE, WITH.token)).statusCode === 401,
);
check(
  "A3 a foreign Origin -> 403, before the op is even read",
  (await pPost(PURGE, PO, "https://evil.invalid")).statusCode === 403,
);
const wrongWord = await pPost({ op: "purge_activity_log", confirm: "delete" }, PO);
check(
  "A4 the wrong word -> 409 PURGE_NOT_CONFIRMED",
  wrongWord.statusCode === 409 && wrongWord.body?.error === "PURGE_NOT_CONFIRMED",
  JSON.stringify(wrongWord.body),
);
check(
  "A5 no confirmation at all -> 400",
  (await pPost({ op: "purge_activity_log" }, PO)).statusCode === 400,
);
check(
  "A6 an extra body key -> 400 (no escape hatch)",
  (await pPost({ ...PURGE, all: true }, PO)).statusCode === 400,
);
check("A7 every refusal left the log exactly as it was", (await logRows()) === before, `rows=${before}`);

// =========================================================================
section("B. THE PURGE REALLY EMPTIES THE LOG");
// =========================================================================
// The purge trace is immutable BY DESIGN, so no fixture can clear it: what is
// asserted is the increase this run caused, never an absolute count.
const tracesBefore = Number(one("select count(*) from public.platform_audit_purge_log;"));
const purged = await pPost(PURGE, PO);
check(
  "B1 the purge reports how many records it removed",
  purged.statusCode === 200 && purged.body?.purged === before,
  `${purged.statusCode} ${JSON.stringify(purged.body)}`,
);
check("B2 the activity endpoint now returns nothing at all", (await logRows()) === 0);
check(
  "B3 every one of the four audited tables is empty - a real deletion",
  one(`select (select count(*) from public.platform_owner_account_audit)
            + (select count(*) from public.platform_entitlement_audit)
            + (select count(*) from public.platform_module_availability_audit)
            + (select count(*) from public.multi_entity_audit);`) === "0",
  "empty",
);
check(
  "B4 the purge itself is on the record, and that record is not in the log",
  Number(one("select count(*) from public.platform_audit_purge_log;")) === tracesBefore + 1 &&
    (await logRows()) === 0,
  `traces ${tracesBefore} -> ${one("select count(*) from public.platform_audit_purge_log;")}`,
);
check(
  "B5 no workspace data was touched by a LOG purge",
  owned(WITH.workspaceId) === WITH.ownedAtStart && owned(OTHER.workspaceId) === OTHER.ownedAtStart,
  `with=${owned(WITH.workspaceId)} other=${owned(OTHER.workspaceId)}`,
);
const again = await pPost(PURGE, PO);
check(
  "B6 purging an empty log is a confirmed no-op - and is still recorded",
  again.statusCode === 200 &&
    again.body?.purged === 0 &&
    Number(one("select count(*) from public.platform_audit_purge_log;")) === tracesBefore + 2,
  JSON.stringify(again.body),
);

// =========================================================================
section("C. THE DELETION PREVIEW");
// =========================================================================
const previewUrl = (ws) =>
  `/api/platform/session?op=deletion_preview&workspaceId=${encodeURIComponent(ws)}`;
check(
  "C1 the preview is refused without a session",
  (await pGet(previewUrl(WITH.workspaceId), null)).statusCode === 401,
);
check(
  "C2 ... and with an Election Owner's own token",
  (await pGet(previewUrl(WITH.workspaceId), WITH.token)).statusCode === 401,
);
check(
  "C3 a malformed workspace id -> 400",
  (await pGet(previewUrl("not-a-uuid"), PO)).statusCode === 400,
);
const prev = await pGet(previewUrl(WITH.workspaceId), PO);
check(
  "C4 it names the workspace, counts its real rows, and reports the Budget verdict",
  prev.statusCode === 200 &&
    prev.body?.name === WITH.name &&
    Number(prev.body?.totalRows) > 0 &&
    prev.body?.budget?.hasBudgetData === true &&
    prev.body?.budget?.deletionAllowed === false,
  JSON.stringify(prev.body).slice(0, 180),
);
const prevOther = await pGet(previewUrl(OTHER.workspaceId), PO);
check(
  "C5 a workspace with no Budget data is already allowed - data alone never blocks",
  prevOther.body?.budget?.hasBudgetData === false &&
    prevOther.body?.budget?.deletionAllowed === true &&
    Number(prevOther.body?.totalRows) > 0,
  JSON.stringify(prevOther.body?.budget),
);

// =========================================================================
section("D. AN INCOMPLETE EXPORT BLOCKS, AND CHANGES NOTHING");
// =========================================================================
const exp = (step, args = {}) =>
  pPost({ op: "workspace_budget_export", workspaceId: WITH.workspaceId, step, args }, PO);
check("E0 the export is refused without a session", (await callHandler(PS, {
  method: "POST",
  url: "/api/platform/session",
  headers: { origin: PLATFORM_ORIGIN, "content-type": "application/json" },
  body: { op: "workspace_budget_export", workspaceId: WITH.workspaceId, step: "status", args: {} },
})).statusCode === 401);
const badStep = await exp("purge");
check("D1 an unknown export step -> 400", badStep.statusCode === 400, JSON.stringify(badStep.body));
const started = await exp("start");
check(
  "D2 start returns a real manifest with parts to fetch",
  started.statusCode === 200 &&
    started.body?.format === "kolbox-budget-export-v1" &&
    Number(started.body?.totals?.parts) > 0,
  `${started.statusCode} parts=${started.body?.totals?.parts}`,
);
// Starting an export legitimately adds its own bookkeeping row, so what is
// asserted below is what the REFUSED DELETION changed - measured from the state
// immediately before it, not from before the export.
const beforeRefusedDelete = owned(WITH.workspaceId);
const blocked = await pPost(
  { op: "delete_workspace", workspaceId: WITH.workspaceId, confirmName: WITH.name },
  PO,
);
check(
  "D3 an export that was started but never completed does NOT satisfy the guard -> 409 BUDGET_EXPORT_REQUIRED",
  blocked.statusCode === 409 && blocked.body?.error === "BUDGET_EXPORT_REQUIRED",
  `${blocked.statusCode} ${JSON.stringify(blocked.body)}`,
);
check(
  "D4 and the workspace is intact - row for row, and its business data with it",
  one(`select count(*) from public.election_workspaces where id = '${WITH.workspaceId}';`) === "1" &&
    owned(WITH.workspaceId) === beforeRefusedDelete &&
    one(`select count(*) from public.budget_categories where workspace_id = '${WITH.workspaceId}';`) === "1" &&
    one(`select count(*) from public.election_owners where workspace_id = '${WITH.workspaceId}';`) === "1" &&
    one(`select count(*) from public.election_day_voters where workspace_id = '${WITH.workspaceId}';`) === "1",
  `owned=${owned(WITH.workspaceId)} (was ${beforeRefusedDelete})`,
);
const halfVerify = await exp("verify", { exportId: started.body.exportId, parts: [], documents: [] });
check(
  "D5 verifying without having fetched the parts is refused - the export must really be served",
  halfVerify.statusCode === 409 && halfVerify.body?.error === "BUDGET_EXPORT_INCOMPLETE",
  `${halfVerify.statusCode} ${JSON.stringify(halfVerify.body)}`,
);
check(
  "D6 the workspace is STILL intact after the refused verification",
  owned(WITH.workspaceId) === beforeRefusedDelete &&
    one(`select count(*) from public.election_workspaces where id = '${WITH.workspaceId}';`) === "1",
  `owned=${owned(WITH.workspaceId)} (was ${beforeRefusedDelete})`,
);

// =========================================================================
section("E. THE COMPLETE EXPORT, THEN THE DELETION");
// =========================================================================
// Exactly what the shared export driver does, step for step: fetch every part,
// check the served bytes against the manifest's sha256, fetch every document,
// then verify with what was actually received.
const manifest = (await exp("start")).body;
const parts = [];
let mismatched = 0;
for (const table of manifest.tables) {
  for (const p of table.parts) {
    const got = await exp("part", { exportId: manifest.exportId, table: table.name, part: p.part });
    if (got.statusCode !== 200 || sha256(got.body.rowsJson) !== p.sha256) mismatched++;
    else parts.push({ table: table.name, part: p.part, sha256: p.sha256 });
  }
}
check(
  "E1 every part was served and its bytes hash to exactly what the manifest recorded",
  mismatched === 0 && parts.length === Number(manifest.totals.parts),
  `parts=${parts.length}/${manifest.totals.parts} mismatched=${mismatched}`,
);
const docs = [];
const versionRows = JSON.parse(
  (await exp("part", {
    exportId: manifest.exportId,
    table: "budget_document_versions",
    part: 0,
  })).body?.rowsJson ?? "[]",
);
for (const v of versionRows) {
  const link = await exp("document", { exportId: manifest.exportId, versionId: v.id });
  if (link.statusCode === 200) docs.push({ versionId: v.id, sha256: v.sha256 });
}
check(
  "E2 the document step exists and refuses a version that is not in this workspace",
  (await exp("document", {
    exportId: manifest.exportId,
    versionId: "00000000-0000-4000-8000-000000000000",
  })).statusCode === 404,
  `documents in this export: ${docs.length}`,
);
const verified = await exp("verify", { exportId: manifest.exportId, parts, documents: docs });
check(
  "E3 verification succeeds and the Budget side now allows the deletion",
  verified.statusCode === 200 && verified.body?.deletionAllowed === true,
  `${verified.statusCode} ${JSON.stringify(verified.body?.deletionAllowed)}`,
);
const previewNow = await pGet(previewUrl(WITH.workspaceId), PO);
check(
  "E4 the preview agrees - still holding Budget data, and now deletable",
  previewNow.body?.budget?.hasBudgetData === true &&
    previewNow.body?.budget?.deletionAllowed === true,
  JSON.stringify(previewNow.body?.budget),
);
const otherOwnedBefore = owned(OTHER.workspaceId);
const deleted = await pPost(
  { op: "delete_workspace", workspaceId: WITH.workspaceId, confirmName: WITH.name },
  PO,
);
check(
  "E5 a workspace HOLDING DATA is deleted - data presence never blocked it, only the prerequisite did",
  deleted.statusCode === 200 && deleted.body?.name === WITH.name,
  `${deleted.statusCode} ${JSON.stringify(deleted.body)}`,
);
check(
  "E6 the workspace and every row it owned are gone",
  one(`select count(*) from public.election_workspaces where id = '${WITH.workspaceId}';`) === "0" &&
    owned(WITH.workspaceId) === 0,
  `owned=${owned(WITH.workspaceId)} (was ${WITH.ownedAtStart})`,
);
check(
  "E7 the Budget side recorded its own permanent deletion record, naming the export that allowed it",
  one(`select count(*) from public.budget_workspace_deletions where workspace_id = '${WITH.workspaceId}';`) === "1" &&
    one(`select export_id::text from public.budget_workspace_deletions where workspace_id = '${WITH.workspaceId}';`) ===
      manifest.exportId,
  "budget deletion record",
);
check(
  "E8 and the platform recorded its own, which survives the workspace",
  one(`select count(*) from public.platform_deletion_audit where workspace_id_snapshot = '${WITH.workspaceId}';`) === "1",
  "platform deletion record",
);
check(
  "E9 the OTHER workspace is untouched - row for row",
  one(`select count(*) from public.election_workspaces where id = '${OTHER.workspaceId}';`) === "1" &&
    owned(OTHER.workspaceId) === otherOwnedBefore,
  `owned=${owned(OTHER.workspaceId)} (was ${otherOwnedBefore})`,
);
const goneExport = await exp("status");
check(
  "E10 the export endpoint no longer knows that workspace",
  goneExport.statusCode === 404 && goneExport.body?.error === "WORKSPACE_NOT_FOUND",
  `${goneExport.statusCode} ${JSON.stringify(goneExport.body)}`,
);

// =========================================================================
section("F. A WORKSPACE WITH NO BUDGET DATA NEEDS NO EXPORT AT ALL");
// =========================================================================
const plain = await pPost(
  { op: "delete_workspace", workspaceId: OTHER.workspaceId, confirmName: OTHER.name },
  PO,
);
check(
  "F1 it is deleted directly, with data in it and no export anywhere",
  plain.statusCode === 200 &&
    one(`select count(*) from public.election_workspaces where id = '${OTHER.workspaceId}';`) === "0" &&
    owned(OTHER.workspaceId) === 0 &&
    one(`select count(*) from public.budget_data_exports where workspace_id = '${OTHER.workspaceId}';`) === "0",
  `${plain.statusCode} owned=${owned(OTHER.workspaceId)}`,
);

// =========================================================================
section("G. THE PURGE TRACE IS OUT OF EVERY CALLER'S REACH");
// =========================================================================
for (const [label, key] of [
  ["the browser anon key", process.env.VITE_SUPABASE_PUBLISHABLE_KEY],
  ["the server key", process.env.SUPABASE_SECRET_KEY],
]) {
  const r = await fetch(
    `${process.env.VITE_SUPABASE_URL}/rest/v1/platform_audit_purge_log?select=id&limit=1`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  check(`G the purge record is not readable over the API with ${label}`, r.status !== 200, String(r.status));
}
const rpcDirect = await fetch(
  `${process.env.VITE_SUPABASE_URL}/rest/v1/rpc/platform_purge_activity_log`,
  {
    method: "POST",
    headers: {
      apikey: process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      authorization: `Bearer ${process.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_platform_owner_auth_user_id: poUser.user.id, p_confirm: "מחיקה" }),
  },
);
check(
  "G3 the purge function is not callable with the browser key even with a real Platform Owner id",
  rpcDirect.status !== 200,
  String(rpcDirect.status),
);

process.exitCode = tally("AUDIT PURGE + ASSISTED EXPORT API") === 0 ? 0 : 1;
