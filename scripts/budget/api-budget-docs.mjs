// Budget Stage 4 - REAL-LOCAL suite for documents, the requirement engine,
// private storage, versioning, the supplier workflow and the order-form PDF.
//
// Real Postgres + real GoTrue + real Storage (the isolated kolboxs5 scratch
// stack started with S5_STORAGE=1), the REAL bundled handlers, real
// PermissionUser sessions and a real Election Owner. Files go browser-style:
// signed upload URL -> PUT straight to Storage -> server verification.
// Synthetic data only; no password, cookie, proof, token or signed URL is
// ever printed.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/api-budget-docs.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { PDFDocument } from "pdf-lib";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { admin, anon, callHandler, check, installLocalnetGuard, loadStack, psql, section, signIn, tally } from "../stage5/lib.mjs";

loadStack();
installLocalnetGuard();
const ORIGIN = "http://localhost:5173";
process.env.SESSION_ALLOWED_ORIGIN = ORIGIN;
const H = await buildHandlers();
const a = admin();

const COOKIE = "__Host-kb_ed_session";
const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S4D-${RUN}`;
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const DOMAIN = `budget-s4-${RUN}.invalid`;
const CODES = { A: code(), B: code() };
const PW = "S4-Docs-Pw-5!";
const uuid = () => crypto.randomUUID();
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const q1 = (sql) => psql(sql);
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
async function bw(cookie, op, args, extra = {}) {
  const r = await callHandler(H.budget, {
    method: "POST", url: "/api/budget/actions", headers: { origin: ORIGIN },
    body: extra.body ?? { op, ...(args === undefined ? {} : { args }) }, cookies: cookie ? { [COOKIE]: cookie } : {},
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function bo(token, op, args) {
  const r = await callHandler(H.budget, {
    method: "POST", url: "/api/budget/actions?principal=owner",
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` }, body: { op, ...(args === undefined ? {} : { args }) },
  });
  return { status: r.statusCode, error: r.body?.error, data: r.body?.data, body: r.body };
}
async function login(c, name) {
  psql("delete from public.election_day_login_attempts;");
  const r = await callHandler(H.electionSession, {
    method: "POST", url: "/api/election-day/session", headers: { origin: ORIGIN }, body: { workspaceCode: c, name, password: PW },
  });
  const sc = r.headers?.["set-cookie"];
  return typeof sc === "string" ? sc.split(";")[0].split("=").slice(1).join("=") : "";
}
const ok = (r) => r.status === 200;
const is = (r, status, err) => r.status === status && r.error === err;
const d = (r) => `${r.status} ${r.error ?? ""}`;

// ---------------------------------------------------------------------------
// Test files (real magic bytes; contents are synthetic).
// ---------------------------------------------------------------------------
const pad = (head, n) => Buffer.concat([head, crypto.randomBytes(Math.max(0, n - head.length))]);
const FILES = {
  pdf: (n = 2048) => pad(Buffer.from("%PDF-1.7\n%synthetic\n"), n),
  jpg: (n = 2048) => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), n),
  png: (n = 2048) => pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), n),
  heic: (n = 2048) => pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1heic")]), n),
  html: (n = 2048) => pad(Buffer.from("<html><script>alert(1)</script>"), n),
};

/** The browser flow: start -> PUT to the signed URL -> complete. */
async function upload(cookie, target, bytes, { mime = "application/pdf", name = "document.pdf", putType, skipPut = false, owner } = {}) {
  const call = owner ? (op, args) => bo(owner, op, args) : (op, args) => bw(cookie, op, args);
  const start = await call("document_upload_start", { ...target, fileName: name, mimeType: mime, sizeBytes: bytes.length });
  if (!ok(start)) return { start, stage: "start" };
  let put = null;
  if (!skipPut) {
    const res = await fetch(start.data.uploadUrl, { method: "PUT", headers: { "content-type": putType ?? mime, "x-upsert": "false" }, body: bytes });
    put = res.status;
    if (!res.ok) return { start, put, stage: "put" };
  }
  const complete = await call("document_upload_complete", { uploadId: start.data.uploadId });
  return { start, put, complete, stage: "complete", uploadId: start.data.uploadId };
}
const docsOf = async (cookie, expenseId) => (await bw(cookie, "get_expense_documents", { expenseId })).data;
const req = (docs, key) => docs.requirements.items.find((i) => i.key === key);
async function fetchSigned(cookie, versionId) {
  const r = await bw(cookie, "document_download", { versionId });
  if (!ok(r)) return { r };
  const res = await fetch(r.data.url);
  return { r, status: res.status, bytes: Buffer.from(await res.arrayBuffer()), disposition: res.headers.get("content-disposition") ?? "" };
}
function pdfStreams(buf) {
  const s = buf.toString("latin1");
  const out = [];
  let i = 0;
  while ((i = s.indexOf("stream", i)) !== -1) {
    let start = i + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    try { out.push(zlib.inflateSync(raw).toString("latin1")); } catch { out.push(raw.toString("latin1")); }
    i = end + 9;
  }
  return out;
}

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
q1(`update public.platform_modules set available = true where key = 'budget';`);
const bucket = q1(`select public::text || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'budget-documents';`);
check("S00 storage is running and the bucket exists (stack started with S5_STORAGE=1)", bucket.length > 0, bucket);
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const ws = (label, c) => q1(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() + interval '10 days', '${c}') returning id;`);
const WA = ws("A", CODES.A);
const WB = ws("B", CODES.B);
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}','election_day'),('${WA}','budget'),('${WB}','budget');`);
const role = (w, name, perms) => q1(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => q1(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
const ROLES = {
  full: ALL, view: ["budget.view"], exp: ["budget.view", "budget.manageExpenses"], sub: ["budget.view", "budget.manageFunderSubmissions"],
  sup: ["budget.view", "budget.manageSuppliers"], set: ["budget.view", "budget.manageSettings"], cap: ["budget.view", "budget.manageExpenses"],
};
for (const [k, perms] of Object.entries(ROLES)) user(WA, `u-${k}`, role(WA, k, perms));
user(WB, "u-bfull", role(WB, "b full", ALL));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
q1(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner S4', '${ownerEmail}');`);
const OWNER = (await signIn(ownerEmail, PW)).token;
const U = {};
for (const k of Object.keys(ROLES)) U[k] = await login(CODES.A, `u-${k}`);
const UB = await login(CODES.B, "u-bfull");
check("S01 fixtures + sessions", Object.values(U).every(Boolean) && Boolean(UB && OWNER));

const cat = async (name) => (await bw(U.full, "create_category", { name: `${PFX} ${name}` })).data.id;
const CS = await cat("שילוט");
const CP = await cat("אירועים");
const SRC_P = (await bw(U.full, "create_source", { name: `${PFX} party`, kind: "party", originalAmount: 100000000 })).data.id;
const SRC_D = (await bw(U.full, "create_source", { name: `${PFX} donation`, kind: "donation", originalAmount: 100000000 })).data.id;
const SUP = (await bw(U.full, "create_supplier", { businessName: `${PFX} דפוס הצפון`, taxId: "513000111", phone: "050-1234567", address: "רחוב הנביאים 5, חיפה" })).data.id;
const SUP2 = (await bw(U.full, "create_supplier", { businessName: `${PFX} ספק ב` })).data.id;
await bo(OWNER, "update_settings", { branchName: "סניף בדיקה", branchNumber: "17", defaultOrderer: "ישראל ישראלי",
  electionYearLabel: "בחירות 2026", funderHeaderLines: ["מפלגה לדוגמה", "מטה הבחירות"] });
const settings = (await bw(U.view, "get_settings")).data;
const rule = (key, cond) => settings.documentRules.find((r) => r.documentTypeKey === key && r.condition === cond);
const TYPE = Object.fromEntries(settings.documentTypes.map((t) => [t.key, t.id]));
/** A complete expense with one allocation (party by default). */
async function mkExpense(total, { source = SRC_P, category = CS, supplier = SUP, desc = "הוצאה" } = {}) {
  const e = (await bw(U.full, "create_expense", { description: `${PFX} ${desc}`, supplierId: supplier, categoryId: category, total, expenseDate: "2026-09-10" })).data;
  await bw(U.full, "set_allocation", { expenseId: e.id, sourceId: source, amount: total });
  return e.id;
}

// ---------------------------------------------------------------------------
section("REQUIREMENT ENGINE (one server-side evaluation)");
const E_SMALL = await mkExpense(100000);
let docs = await docsOf(U.view, E_SMALL);
check("R01 party-funded 1,000 ILS: order form, quotation, bank confirmation required",
  ["order_form", "quotation", "bank_confirmation"].every((k) => req(docs, k)?.required) && docs.requirements.partyFunded,
  JSON.stringify(docs.requirements.missing));
check("R02 ... invoice and supplier signature NOT required at 1,000 ILS; photo not required (no category/flag)",
  !docs.requirements.invoiceRequired && !docs.requirements.supplierSignatureRequired && !docs.requirements.photoRequired);
const tiny = await mkExpense(100);
check("R03 quotation is required for every party-funded expense (even 1.00 ILS)", req(await docsOf(U.view, tiny), "quotation")?.required === true);
const E1 = await mkExpense(149999, { desc: "149999" });
const E2 = await mkExpense(150000, { desc: "150000" });
const E3 = await mkExpense(150001, { desc: "150001" });
const r1 = (await docsOf(U.view, E1)).requirements;
const r2 = (await docsOf(U.view, E2)).requirements;
const r3 = (await docsOf(U.view, E3)).requirements;
check("R04 invoice threshold: 1,499.99 -> not required", r1.invoiceRequired === false);
check("R05 invoice threshold: 1,500.00 -> NOT required (strictly greater)", r2.invoiceRequired === false);
check("R06 invoice threshold: 1,500.01 -> required", r3.invoiceRequired === true);
check("R07 supplier signature: 1,499.99 / 1,500.00 not required, 1,500.01 required",
  r1.supplierSignatureRequired === false && r2.supplierSignatureRequired === false && r3.supplierSignatureRequired === true);
const E_DON = await mkExpense(500000, { source: SRC_D, desc: "donation" });
const rd = (await docsOf(U.view, E_DON)).requirements;
check("R08 non-party (donation) expense: nothing required, not party-funded", rd.items.every((i) => !i.required) && !rd.partyFunded && rd.ready);
const donUp = await upload(U.exp, { purpose: "expense", expenseId: E_DON, documentTypeId: TYPE.quotation }, FILES.pdf());
check("R09 ... but it can still hold documents (quotation uploaded, shown as optional + present)", ok(donUp.complete) &&
  req(donUp.complete.data, "quotation")?.satisfied === true && req(donUp.complete.data, "quotation")?.required === false, d(donUp.complete ?? donUp.start));
check("R10 photo category rule: set by manageSettings", ok(await bw(U.set, "update_document_rule", { ruleId: rule("photo", "category").id, categoryIds: [CP] })));
const E_PHOTO = await mkExpense(100000, { category: CP, desc: "event" });
check("R11 party expense in a photo category -> photo required", (await docsOf(U.view, E_PHOTO)).requirements.photoRequired === true);
check("R12 party expense outside it -> photo not required", (await docsOf(U.view, E_SMALL)).requirements.photoRequired === false);
const flagOn = await bw(U.exp, "set_expense_document_flag", { expenseId: E_SMALL, documentTypeId: TYPE.photo, required: true });
check("R13 per-expense override: photo required for THIS expense", ok(flagOn) && flagOn.data.requirements.photoRequired === true &&
  req(flagOn.data, "photo").rules.some((r) => r.condition === "manual" && r.matched));
const flagOff = await bw(U.exp, "set_expense_document_flag", { expenseId: E_SMALL, documentTypeId: TYPE.photo, required: false });
check("R14 override removed -> photo not required again", ok(flagOff) && flagOff.data.requirements.photoRequired === false);
check("R15 override on a type without a manual rule -> 400", is(await bw(U.exp, "set_expense_document_flag", { expenseId: E_SMALL, documentTypeId: TYPE.invoice, required: true }), 400, "INVALID_INPUT"));
check("R16 override needs manageExpenses", is(await bw(U.sub, "set_expense_document_flag", { expenseId: E_SMALL, documentTypeId: TYPE.photo, required: true }), 403, "FORBIDDEN"));
check("R17 invoice threshold is configurable per workspace", ok(await bw(U.set, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 200000 })) &&
  (await docsOf(U.view, E3)).requirements.invoiceRequired === false);
await bw(U.set, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 150000 });
check("R18 ... restored to 1,500 ILS -> 1,500.01 requires the invoice again", (await docsOf(U.view, E3)).requirements.invoiceRequired === true);
const E_MIX = (await bw(U.full, "create_expense", { description: `${PFX} mixed`, supplierId: SUP, categoryId: CS, total: 300000, expenseDate: "2026-09-10" })).data.id;
await bw(U.full, "set_allocation", { expenseId: E_MIX, sourceId: SRC_D, amount: 100000 });
await bw(U.full, "set_allocation", { expenseId: E_MIX, sourceId: SRC_P, amount: 200000 });
check("R19 mixed party + donation funding -> the party rules apply", (await docsOf(U.view, E_MIX)).requirements.partyFunded === true &&
  (await docsOf(U.view, E_MIX)).requirements.invoiceRequired === true);

// ---------------------------------------------------------------------------
section("STORAGE / SECURITY");
check("S02 bucket is PRIVATE with a 10 MiB limit and exactly PDF/JPEG/PNG/HEIC/HEIF", bucket ===
  "false|10485760|application/pdf,image/jpeg,image/png,image/heic,image/heif", bucket);
const pol = q1(`select permissive || ':' || array_to_string(roles, ',') || ':' || cmd from pg_policies
  where schemaname = 'storage' and tablename = 'objects' and policyname = 'budget_documents_bucket_deny';`);
check("S03 RESTRICTIVE deny policy for anon + authenticated on the bucket", pol === "RESTRICTIVE:anon,authenticated:ALL", pol);
const qBytes = FILES.pdf(3000);
const q = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.quotation }, qBytes,
  { name: `../../etc/pass${String.fromCharCode(0x202e)}fdp.exe` });
check("S04 authorized upload: signed URL -> PUT -> verified -> filed", ok(q.start) && q.put === 200 && ok(q.complete), `${d(q.start)} put=${q.put} ${d(q.complete ?? q.start)}`);
const qDoc = q.complete.data.documents.find((x) => x.typeKey === "quotation");
const qv1 = qDoc.versions[0];
check("S05 file name sanitized (no path, no bidi override, extension from the verified type)",
  qv1.fileName === "passfdp.exe.pdf" && !/[\\/‪-‮]/.test(qv1.fileName), qv1.fileName);
const qPath = q1(`select storage_path from public.budget_document_versions where id = '${qv1.id}';`);
check("S06 object path is server-generated <workspace>/<uuid> - the user's name is not in it",
  new RegExp(`^${WA}/[0-9a-f-]{36}$`).test(qPath) && !qPath.includes("pass"), qPath);
check("S07 stored sha256 + size = the uploaded bytes (computed server-side from Storage)",
  q1(`select sha256 || '|' || size_bytes from public.budget_document_versions where id = '${qv1.id}';`) === `${sha(qBytes)}|3000`);
const an = anon();
const anonList = await an.storage.from("budget-documents").list(WA);
check("S08 anon key cannot list the bucket", (anonList.data ?? []).length === 0);
const anonDl = await an.storage.from("budget-documents").download(qPath);
check("S09 anon key cannot download an object", Boolean(anonDl.error) && !anonDl.data);
const pub = await fetch(`${process.env.VITE_SUPABASE_URL}/storage/v1/object/public/budget-documents/${qPath}`);
check("S10 no public URL (public object endpoint refuses)", pub.status >= 400, String(pub.status));
const authed = (await signIn(ownerEmail, PW)).client;
const authDl = await authed.storage.from("budget-documents").download(qPath);
check("S11 a signed-in (authenticated) user cannot read the bucket directly either", Boolean(authDl.error) && !authDl.data);
const dl = await fetchSigned(U.view, qv1.id);
check("S12 budget.view downloads through a signed link (bytes intact)", ok(dl.r) && dl.status === 200 && dl.bytes.length === 3000);
const tok = new URL(dl.r.data.url).searchParams.get("token") ?? "";
const claims = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64url").toString() || "{}");
check("S13 the signed link lives 60 seconds", dl.r.data.expiresIn === 60 && claims.exp - claims.iat === 60, `${claims.exp - claims.iat}`);
check("S14 served as an attachment named by the sanitized file name", /attachment/i.test(dl.disposition), dl.disposition);
check("S15 view cannot upload", is(await bw(U.view, "document_upload_start", { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.quotation, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 403, "FORBIDDEN"));
const startArgs = (extra) => ({ purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.invoice, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10, ...extra });
check("S16 unsupported type (text/html) -> 400", is(await bw(U.exp, "document_upload_start", startArgs({ mimeType: "text/html" })), 400, "UNSUPPORTED_FILE_TYPE"));
check("S17 over 10 MiB -> 400", is(await bw(U.exp, "document_upload_start", startArgs({ sizeBytes: 10485761 })), 400, "FILE_TOO_LARGE"));
const atLimit = await bw(U.exp, "document_upload_start", startArgs({ sizeBytes: 10485760 }));
check("S18 exactly 10 MiB accepted at start", ok(atLimit), d(atLimit));
const s19 = await bw(U.exp, "document_upload_start", startArgs({ storagePath: `${WB}/x`, workspaceId: WB }));
const s19Path = s19.data ? decodeURIComponent(new URL(s19.data.uploadUrl).pathname) : "";
check("S19 a client-sent storage path / workspace is ignored (path server-generated in the caller's workspace)",
  ok(s19) && s19Path.includes(`/budget-documents/${WA}/`) && !s19Path.includes(WB), d(s19));
const spoof = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.invoice }, FILES.html(), { mime: "application/pdf", putType: "application/pdf" });
check("S20 MIME spoofing (HTML bytes declared as PDF) -> 400 INVALID_FILE", is(spoof.complete, 400, "INVALID_FILE"), d(spoof.complete ?? spoof.start));
const spoofPath = q1(`select storage_path || '|' || state || '|' || coalesce(reject_reason,'') from public.budget_document_uploads where id = '${spoof.uploadId}';`);
const spoofObj = await a.storage.from("budget-documents").download(spoofPath.split("|")[0]);
check("S21 ... the stored object is deleted and the intent rejected (type_mismatch)", Boolean(spoofObj.error) && spoofPath.endsWith("|rejected|type_mismatch"), spoofPath);
const htmlPut = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.invoice }, FILES.pdf(), { putType: "text/html" });
check("S22 Storage refuses a disallowed Content-Type on the signed upload (bucket allow-list)", htmlPut.stage === "put" && htmlPut.put >= 400, String(htmlPut.put));
const smaller = await (async () => {
  const s = await bw(U.exp, "document_upload_start", startArgs({ sizeBytes: 5000 }));
  await fetch(s.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: FILES.pdf(1000) });
  return bw(U.exp, "document_upload_complete", { uploadId: s.data.uploadId });
})();
check("S23 declared size != stored size -> 400 INVALID_FILE", is(smaller, 400, "INVALID_FILE"), d(smaller));
const wrongStored = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.photo }, FILES.png(),
  { mime: "image/png", name: "p.png", putType: "application/pdf" });
check("S23b real PNG bytes but stored with another (allowed) Content-Type -> 400 INVALID_FILE (served type must match)",
  is(wrongStored.complete, 400, "INVALID_FILE"), d(wrongStored.complete ?? wrongStored.start));
const early = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.invoice }, FILES.pdf(), { skipPut: true });
check("S24 complete before the bytes arrive -> 409 UPLOAD_MISSING (intent stays open)", is(early.complete, 409, "UPLOAD_MISSING"));
const exp = await bw(U.exp, "document_upload_start", startArgs({ sizeBytes: 2048 }));
await fetch(exp.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: FILES.pdf() });
// Direct fixture write: the audit trigger requires an actor context (as for
// every Budget table) - the refusal without one is itself proven in Stage 3.
q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"t","workspace_id":"${WA}"}', false);
    update public.budget_document_uploads set expires_at = now() - interval '1 second' where id = '${exp.data.uploadId}';`);
check("S25 expired intent -> 409 UPLOAD_EXPIRED", is(await bw(U.exp, "document_upload_complete", { uploadId: exp.data.uploadId }), 409, "UPLOAD_EXPIRED"));
const overwrite = await fetch(q.start.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: FILES.pdf(3000) });
const after = await fetchSigned(U.view, qv1.id);
check("S26 the upload URL cannot overwrite a stored (historical) file", overwrite.status >= 400 && sha(after.bytes) === sha(dl.bytes), String(overwrite.status));
for (const op of ["document_upload_finalize", "document_upload_lookup", "document_upload_reject", "document_version_locate", "order_form_data", "order_form_record"]) {
  const r = await bw(U.full, op, { uploadId: uuid(), versionId: uuid(), expenseId: E_SMALL });
  check(`S27 internal op '${op}' refused from a client`, is(r, 400, "INVALID_REQUEST"), d(r));
}
const foreignUp = await bw(U.full, "document_upload_complete", { uploadId: early.uploadId });
check("S28 another user cannot complete someone else's upload (404)", is(foreignUp, 404, "NOT_FOUND"), d(foreignUp));
check("S29 IDOR: another workspace's version -> 404", is(await bw(UB, "document_download", { versionId: qv1.id }), 404, "NOT_FOUND"));
check("S30 IDOR: another workspace's expense documents -> 404", is(await bw(UB, "get_expense_documents", { expenseId: E_SMALL }), 404, "NOT_FOUND"));
check("S31 IDOR: upload into another workspace's expense -> 404", is(await bw(UB, "document_upload_start", startArgs({})), 404, "NOT_FOUND"));
check("S32 IDOR: replace another workspace's document -> 404", is(await bw(UB, "document_upload_start", { purpose: "expense", documentId: qDoc.id, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 404, "NOT_FOUND"));
check("S33 IDOR: archive another workspace's document -> 404", is(await bw(UB, "archive_document", { documentId: qDoc.id, reason: "x" }), 404, "NOT_FOUND"));
check("S34 IDOR: another workspace's supplier file -> 404", is(await bw(UB, "get_supplier_file", { supplierId: SUP }), 404, "NOT_FOUND"));
check("S35 IDOR: a supplier document into another workspace's supplier -> 404", is(await bw(UB, "document_upload_start", { purpose: "supplier", supplierId: SUP, documentTypeId: TYPE.bank_confirmation, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 404, "NOT_FOUND"));
const png = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.photo }, FILES.png(), { mime: "image/png", name: "shot.png" });
const jpg = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.photo }, FILES.jpg(), { mime: "image/jpeg", name: "shot.jpeg" });
const heic = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.photo }, FILES.heic(), { mime: "image/heic", name: "IMG_0001.HEIC" });
const heif = await upload(U.exp, { purpose: "expense", expenseId: E_SMALL, documentTypeId: TYPE.photo }, FILES.heic(), { mime: "image/heif", name: "x.heif" });
check("S36 PNG, JPEG, HEIC accepted by real magic bytes", ok(png.complete) && ok(jpg.complete) && ok(heic.complete),
  `${d(png.complete ?? png.start)} ${d(jpg.complete ?? jpg.start)} ${d(heic.complete ?? heic.start)}`);
check("S37 HEIC bytes declared as HEIF accepted (same container family)", ok(heif.complete), d(heif.complete ?? heif.start));
const capPending = [];
for (let i = 0; i < 10; i++) capPending.push(await bw(U.cap, "document_upload_start", startArgs({ fileName: `c${i}.pdf` })));
check("S38 upload-abuse bound: the 11th open intent -> 429", capPending.every(ok) && is(await bw(U.cap, "document_upload_start", startArgs({})), 429, "TOO_MANY_PENDING_UPLOADS"));
const orphanCheck = async () => {
  const listed = await a.storage.from("budget-documents").list(WA, { limit: 1000 });
  const names = new Set((listed.data ?? []).map((o) => `${WA}/${o.name}`));
  const known = new Set(q1(`select coalesce(string_agg(storage_path, ','), '') from public.budget_document_versions where workspace_id = '${WA}';`).split(",").filter(Boolean));
  const pending = new Set(q1(`select coalesce(string_agg(storage_path, ','), '') from public.budget_document_uploads where workspace_id = '${WA}' and state = 'pending';`).split(",").filter(Boolean));
  return [...names].filter((n) => !known.has(n) && !pending.has(n));
};

// ---------------------------------------------------------------------------
section("VERSIONING");
const q2 = await upload(U.exp, { purpose: "expense", documentId: qDoc.id }, FILES.pdf(4000), { name: "הצעת מחיר מעודכנת.pdf" });
const qDoc2 = q2.complete?.data?.documents.find((x) => x.id === qDoc.id);
check("V01 replacement = the next version (v1 -> v2), same document", ok(q2.complete) && qDoc2?.versions.map((v) => v.versionNo).join(",") === "2,1", d(q2.complete ?? q2.start));
check("V02 the requirement is satisfied by the CURRENT version (v2)", req(q2.complete.data, "quotation").satisfiedBy?.versionNo === 2);
const old = await fetchSigned(U.view, qv1.id);
check("V03 v1 is still downloadable, byte-identical", old.status === 200 && sha(old.bytes) === sha(dl.bytes));
const verAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_type = 'budget_document_versions'
  and after_data ->> 'document_id' = '${qDoc.id}' and action = 'insert';`);
check("V04 each version is audited (2 inserts)", verAudit === "2", verAudit);
const hist = (await bw(U.view, "list_history", { entityType: "expense", entityId: E_SMALL })).data;
check("V05 expense history includes the document + version rows", hist.some((h) => h.entityType === "budget_documents") && hist.some((h) => h.entityType === "budget_document_versions"));
let err = "";
try { q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"t","workspace_id":"${WA}"}', false);
  update public.budget_document_versions set sha256 = repeat('0', 64) where id = '${qv1.id}';`); } catch (e) { err = String(e.stderr); }
check("V06 a historical version cannot be overwritten in the DB", err.includes("BUDGET_APPEND_ONLY"), err.split("\n")[0]);
err = "";
try { q1(`delete from public.budget_document_versions where id = '${qv1.id}';`); } catch (e) { err = String(e.stderr); }
check("V07 ... nor deleted", err.includes("BUDGET_APPEND_ONLY"));
err = "";
try { q1(`delete from public.budget_documents where id = '${qDoc.id}';`); } catch (e) { err = String(e.stderr); }
check("V08 documents are never deleted (archive only)", err.includes("BUDGET_APPEND_ONLY"));
check("V09 archive needs a reason", is(await bw(U.exp, "archive_document", { documentId: qDoc.id }), 400, "INVALID_INPUT"));
const arch = await bw(U.exp, "archive_document", { documentId: qDoc.id, reason: "הוחלף בהצעה אחרת" });
check("V10 archived: versions kept, requirement missing again", ok(arch) && req(arch.data, "quotation").satisfied === false &&
  arch.data.documents.find((x) => x.id === qDoc.id)?.versions.length === 2);
check("V11 a new version of an archived document -> 409", is(await bw(U.exp, "document_upload_start", { purpose: "expense", documentId: qDoc.id, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 409, "DOCUMENT_ARCHIVED"));
const rest = await bw(U.exp, "restore_document", { documentId: qDoc.id });
check("V12 restore -> satisfied again by v2", ok(rest) && req(rest.data, "quotation").satisfiedBy?.versionNo === 2);
const [c1, c2] = await Promise.all([
  (async () => { const s = await bw(U.exp, "document_upload_start", { purpose: "expense", documentId: qDoc.id, fileName: "c1.pdf", mimeType: "application/pdf", sizeBytes: 2048 });
    await fetch(s.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: FILES.pdf() }); return s.data.uploadId; })(),
  (async () => { const s = await bw(U.exp, "document_upload_start", { purpose: "expense", documentId: qDoc.id, fileName: "c2.pdf", mimeType: "application/pdf", sizeBytes: 2048 });
    await fetch(s.data.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: FILES.pdf() }); return s.data.uploadId; })(),
]);
const [f1, f2] = await Promise.all([bw(U.exp, "document_upload_complete", { uploadId: c1 }), bw(U.exp, "document_upload_complete", { uploadId: c2 })]);
const nums = q1(`select string_agg(version_no::text, ',' order by version_no) from public.budget_document_versions where document_id = '${qDoc.id}';`);
check("V13 two concurrent new versions -> 3 and 4, never a duplicate number", ok(f1) && ok(f2) && nums === "1,2,3,4", nums);
const replay = await bw(U.exp, "document_upload_complete", { uploadId: c1 });
check("V14 a replayed complete answers again without a new version", ok(replay) &&
  q1(`select count(*) from public.budget_document_versions where document_id = '${qDoc.id}';`) === "4");

// ---------------------------------------------------------------------------
section("PERMISSION BOUNDARIES");
const E_P2 = await mkExpense(200000, { desc: "party 2,000" });
check("M01 manageFunderSubmissions uploads the funder package on a PARTY expense",
  ok((await upload(U.sub, { purpose: "expense", expenseId: E_P2, documentTypeId: TYPE.quotation }, FILES.pdf())).complete));
check("M02 ... but not on a non-party expense", is(await bw(U.sub, "document_upload_start", { purpose: "expense", expenseId: E_DON, documentTypeId: TYPE.quotation, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 403, "FORBIDDEN"));
check("M03 manageSuppliers cannot upload an expense document", is(await bw(U.sup, "document_upload_start", { purpose: "expense", expenseId: E_P2, documentTypeId: TYPE.quotation, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 403, "FORBIDDEN"));
check("M04 manageExpenses cannot upload a supplier document", is(await bw(U.exp, "document_upload_start", { purpose: "supplier", supplierId: SUP, documentTypeId: TYPE.bank_confirmation, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 }), 403, "FORBIDDEN"));
check("M05 manageExpenses cannot generate an order form", is(await bw(U.exp, "order_form_generate", { expenseId: E_P2 }), 403, "FORBIDDEN"));
check("M06 budget.view cannot preview an order form", is(await bw(U.view, "order_form_preview", { expenseId: E_P2 }), 403, "FORBIDDEN"));
check("M07 budget.view cannot archive", is(await bw(U.view, "archive_document", { documentId: qDoc.id, reason: "x" }), 403, "FORBIDDEN"));
check("M08 manageSettings cannot upload", is(await bw(U.set, "document_upload_start", startArgs({})), 403, "FORBIDDEN"));
check("M09 the order-form workflow types cannot be uploaded by hand", is(await bw(U.full, "document_upload_start", startArgs({ documentTypeId: TYPE.order_form })), 409, "DOCUMENT_TYPE_MANAGED") &&
  is(await bw(U.full, "document_upload_start", startArgs({ documentTypeId: TYPE.order_form_signed })), 409, "DOCUMENT_TYPE_MANAGED"));
const newType = await bw(U.set, "create_document_type", { name: `${PFX} אישור עירייה` });
const custom = newType.data?.documentTypes.find((t) => t.name === `${PFX} אישור עירייה`);
check("M10 manageSettings creates a custom document type", ok(newType) && custom && !custom.isSystem);
check("M11 duplicate type name -> 409", is(await bw(U.set, "create_document_type", { name: `${PFX} אישור עירייה` }), 409, "DUPLICATE_NAME"));
check("M12 system types cannot be renamed", is(await bw(U.set, "update_document_type", { documentTypeId: TYPE.invoice, name: "x" }), 409, "DOCUMENT_TYPE_SYSTEM"));
check("M13 a custom type can be used for a document", ok((await upload(U.exp, { purpose: "expense", expenseId: E_P2, documentTypeId: custom.id }, FILES.pdf())).complete));
check("M14 manageExpenses cannot create a document type", is(await bw(U.exp, "create_document_type", { name: "x" }), 403, "FORBIDDEN"));
check("M15 the Owner holds document authority", ok((await upload(null, { purpose: "expense", expenseId: E_P2, documentTypeId: TYPE.photo }, FILES.jpg(), { mime: "image/jpeg", name: "o.jpg", owner: OWNER })).complete));

// ---------------------------------------------------------------------------
section("SUPPLIERS");
const bank = await upload(U.sup, { purpose: "supplier", supplierId: SUP, documentTypeId: TYPE.bank_confirmation, validUntil: "2099-12-31", title: "אישור ניהול חשבון 2026" }, FILES.pdf(), { name: "bank.pdf" });
check("P01 supplier document (bank-account confirmation, valid until 2099) uploaded by manageSuppliers", ok(bank.complete), d(bank.complete ?? bank.start));
const viaSupplier = req(await docsOf(U.view, E_P2), "bank_confirmation");
check("P02 it satisfies the bank-confirmation requirement of the supplier's party expenses", viaSupplier.satisfied && viaSupplier.satisfiedBy.source === "supplier");
const sfile = (await bw(U.view, "get_supplier_file", { supplierId: SUP })).data;
check("P03 supplier file: its documents, its expenses (with readiness) and their documents", sfile.documents.length === 1 &&
  sfile.expenses.some((e) => e.id === E_P2) && sfile.expenses.every((e) => typeof e.documentsReady === "boolean"));
check("P04 supplier file never carries bank data", !JSON.stringify(sfile).includes("accountNumber"));
const bankDoc = sfile.documents[0];
q1(`select set_config('kolbox.budget_actor', '{"type":"owner","id":"${uuid()}","name":"t","workspace_id":"${WA}"}', false);
    update public.budget_documents set valid_until = '2020-01-01' where id = '${bankDoc.id}';`);
check("P05 an EXPIRED supplier confirmation no longer satisfies the requirement", req(await docsOf(U.view, E_P2), "bank_confirmation").satisfied === false);
const renew = await upload(U.sup, { purpose: "supplier", documentId: bankDoc.id, validUntil: "2099-12-31" }, FILES.pdf(), { name: "bank-2.pdf" });
check("P06 a renewed version with a new validity satisfies it again", ok(renew.complete) && req(await docsOf(U.view, E_P2), "bank_confirmation").satisfied);
check("P07 deactivate supplier", ok(await bw(U.sup, "update_supplier", { supplierId: SUP2, isActive: false })));
const E_SUP2 = (await bw(U.full, "create_expense", { description: `${PFX} before deactivation` })).data.id;
check("P08 historical linkage kept: a deactivated supplier's file and expenses stay readable", ok(await bw(U.view, "get_supplier_file", { supplierId: SUP2 })) && Boolean(E_SUP2));
check("P09 there is no supplier deletion", is(await bw(U.full, "delete_supplier", { supplierId: SUP2 }), 400, "UNKNOWN_OP"));
err = "";
try { q1(`select set_config('kolbox.budget_actor', '{"type":"owner","id":"${uuid()}","name":"t","workspace_id":"${WA}"}', false);
  delete from public.budget_suppliers where id = '${SUP}';`); } catch (e) { err = String(e.stderr); }
check("P10 a supplier with documents/expenses cannot be deleted even with a valid actor context (RESTRICT FKs)",
  err.includes("violates foreign key"), err.split("\n")[0]);
check("P11 bank change without step-up -> 403 STEPUP_REQUIRED", is(await bw(U.sup, "set_supplier_bank", { supplierId: SUP, accountNumber: "5551234" }), 403, "STEPUP_REQUIRED"));
psql("delete from public.election_day_login_attempts;");
const ch = (await bw(U.sup, "stepup", { kind: "change", supplierId: SUP, password: PW })).body?.proof;
check("P12 change with a valid step-up proof", ok(await bw(U.sup, "set_supplier_bank", { supplierId: SUP, accountNumber: "5551234", proof: ch })));
check("P13 the proof is single-use", is(await bw(U.sup, "set_supplier_bank", { supplierId: SUP, accountNumber: "5559999", proof: ch }), 403, "STEPUP_REQUIRED"));
psql("delete from public.election_day_login_attempts;");
const rv = (await bw(U.sup, "stepup", { kind: "reveal", supplierId: SUP, password: PW })).body?.proof;
q1(`update public.election_day_reauth_proofs set expires_at = now() - interval '1 second' where proof_hash = decode('${sha(rv)}', 'hex');`);
check("P14 an expired reveal proof is refused", is(await bw(U.sup, "reveal_supplier_bank", { supplierId: SUP, proof: rv }), 403, "STEPUP_REQUIRED"));
check("P15 masked by default in the supplier file (last 4 only)", (await bw(U.view, "get_supplier_file", { supplierId: SUP })).data.supplier.bank?.accountLast4 === "1234");

// ---------------------------------------------------------------------------
section("ORDER FORM (server-side PDF, versions, supplier return)");
check("O01 non-party expense -> ORDER_FORM_NOT_APPLICABLE", is(await bw(U.sub, "order_form_preview", { expenseId: E_DON }), 409, "ORDER_FORM_NOT_APPLICABLE"));
const EO = await mkExpense(200000, { desc: "הדפסת 500 שלטי חוצות (120x80) כולל התקנה" });
const prev = await bw(U.sub, "order_form_preview", { expenseId: EO });
const prevPdf = Buffer.from(prev.data?.pdfBase64 ?? "", "base64");
check("O02 PREVIEW before the prior approval is allowed and is a PDF", ok(prev) && prevPdf.subarray(0, 5).toString() === "%PDF-" && prev.data.fileName.endsWith(".pdf"), d(prev));
check("O03 the preview is not stored", q1(`select count(*) from public.budget_order_form_versions where expense_id = '${EO}';`) === "0");
const prev2 = await bw(U.sub, "order_form_preview", { expenseId: EO });
check("O04 deterministic: the same data renders byte-identical PDFs", prev2.data?.pdfBase64 === prev.data?.pdfBase64);
check("O05 FINAL generation before the prior approval -> 409 PREAPPROVAL_REQUIRED", is(await bw(U.sub, "order_form_generate", { expenseId: EO }), 409, "PREAPPROVAL_REQUIRED"));
let eo = (await bw(U.view, "get_expense", { expenseId: EO })).data;
await bw(U.sub, "record_preapproval", { allocationId: eo.allocations[0].id, orderNumber: "77/2026", approvalCode: "AP-77", approverName: "מינהל הכספים", approvalDate: "2026-09-08", preapprovedAmount: 200000 });
const g1 = await bw(U.sub, "order_form_generate", { expenseId: EO });
check("O06 after the prior approval: final PDF generated and stored as version 1", ok(g1) && g1.data.orderForm.versions.length === 1 &&
  g1.data.orderForm.versions[0].versionNo === 1 && g1.data.orderForm.state === "generated", d(g1));
const v1 = g1.data.orderForm.versions[0];
check("O07 the order form requirement is now satisfied (by v1)", req(g1.data, "order_form").satisfied && req(g1.data, "order_form").satisfiedBy.versionNo === 1);
const pdf1 = await fetchSigned(U.view, v1.documentVersionId);
const doc1 = await PDFDocument.load(pdf1.bytes);
const text1 = pdf1.bytes.toString("latin1");
check("O08 stored PDF: valid, one A4 page", pdf1.status === 200 && text1.startsWith("%PDF-") && text1.trimEnd().endsWith("%%EOF") &&
  doc1.getPageCount() === 1 && Math.round(doc1.getPage(0).getWidth()) === 595);
// pdf-lib packs object dictionaries into compressed object streams, so the
// font objects are searched in the raw bytes AND the inflated streams.
const streams = pdfStreams(pdf1.bytes);
const allObjects = text1 + streams.join("\n");
check("O09 the embedded OFL Hebrew font is in the file (no system font)", allObjects.includes("/DavidLibre-Regular") &&
  allObjects.includes("/DavidLibre-Bold") && allObjects.includes("/FontFile2") && !/\/BaseFont\s*\/(Helvetica|Times|Arial)/.test(allObjects));
const hebrewMap = streams.some((s) => /beginbf(char|range)/.test(s) && /<05[D-E][0-9A-F]>/i.test(s));
check("O10 Hebrew content present (ToUnicode maps Hebrew letters)", hebrewMap);
check("O11 sha256 recorded = the stored bytes", q1(`select sha256 from public.budget_document_versions where id = '${v1.documentVersionId}';`) === sha(pdf1.bytes));
check("O12 generated file is a PDF (mime + name) - no spreadsheet path exists",
  pdf1.r.data.mimeType === "application/pdf" && pdf1.r.data.fileName.endsWith(".pdf") && is(await bw(U.sub, "order_form_xlsx", { expenseId: EO }), 400, "UNKNOWN_OP"));
check("O13 a 2,000 ILS order: supplier signature required, signed form missing", g1.data.requirements.supplierSignatureRequired &&
  !req(g1.data, "order_form_signed").satisfied && v1.supplierSignatureRequired);
const g2 = await bw(U.sub, "order_form_generate", { expenseId: EO });
const v2 = g2.data?.orderForm.versions[0];
check("O14 regeneration -> version 2; version 1 kept", ok(g2) && v2.versionNo === 2 && g2.data.orderForm.versions.length === 2 &&
  (await fetchSigned(U.view, v1.documentVersionId)).status === 200, d(g2));
check("O15 the superseded version cannot be marked sent", is(await bw(U.sub, "order_form_mark_sent", { orderFormVersionId: v1.id }), 409, "ORDER_FORM_SUPERSEDED"));
const sent = await bw(U.sub, "order_form_mark_sent", { orderFormVersionId: v2.id, note: "נשלח ב-WhatsApp" });
check("O16 user confirms version 2 was sent", ok(sent) && sent.data.orderForm.versions[0].sentAt && sent.data.orderForm.state === "sent");
check("O17 'sent' is one-way", is(await bw(U.sub, "order_form_mark_sent", { orderFormVersionId: v2.id }), 409, "INVALID_TRANSITION"));
const retOld = await upload(U.sub, { purpose: "order_form_return", orderFormVersionId: v1.id }, FILES.jpg(), { mime: "image/jpeg", name: "signed-v1.jpg" });
check("O18 a signed return for the OLD version links to v1 but does not satisfy the current form",
  ok(retOld.complete) && retOld.complete.data.orderForm.versions.find((x) => x.id === v1.id).returns.length === 1 &&
  !req(retOld.complete.data, "order_form_signed").satisfied);
const ret = await upload(U.sub, { purpose: "order_form_return", orderFormVersionId: v2.id, notes: "חתום ע\"י הספק" }, FILES.pdf(), { name: "signed-v2.pdf" });
check("O19 the supplier-signed return linked to version 2 satisfies the signature requirement", ok(ret.complete) &&
  req(ret.complete.data, "order_form_signed").satisfied && req(ret.complete.data, "order_form_signed").satisfiedBy.source === "order_form_return" &&
  ret.complete.data.orderForm.state === "returned");
const link = q1(`select order_form_version_id from public.budget_document_versions where id = '${ret.complete.data.orderForm.versions[0].returns[0].versionId}';`);
check("O20 DB link: the returned file references its originating generated version", link === v2.id, link);
const g3 = await bw(U.sub, "order_form_generate", { expenseId: EO });
check("O21 regeneration (N+1 = 3) preserves 1 and 2, and the new version needs a NEW signature", ok(g3) &&
  g3.data.orderForm.versions.map((x) => x.versionNo).join(",") === "3,2,1" && !req(g3.data, "order_form_signed").satisfied);
err = "";
try { q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"t","workspace_id":"${WA}"}', false);
  update public.budget_order_form_versions set snapshot = '{}'::jsonb where id = '${v1.id}';`); } catch (e) { err = String(e.stderr); }
check("O22 a generated version's content is immutable in the DB", err.includes("BUDGET_APPEND_ONLY"));
const [ga, gb] = await Promise.all([bw(U.sub, "order_form_generate", { expenseId: EO }), bw(U.sub, "order_form_generate", { expenseId: EO })]);
const ofCount = q1(`select count(*) from public.budget_order_form_versions where expense_id = '${EO}';`);
check("O23 two concurrent generations: exactly one becomes version 4, the other is refused", [ga, gb].filter(ok).length === 1 &&
  [ga, gb].some((r) => is(r, 409, "STALE_VERSION")) && ofCount === "4", `${d(ga)} | ${d(gb)} | ${ofCount}`);
const orphans = await orphanCheck();
check("O24 no orphan object in Storage (every object is a version or an open intent)", orphans.length === 0, `${orphans.length} orphan(s)`);
const EQ = await mkExpense(150000, { desc: "exactly 1,500" });
eo = (await bw(U.view, "get_expense", { expenseId: EQ })).data;
await bw(U.sub, "record_preapproval", { allocationId: eo.allocations[0].id, approvalCode: "AP-15", approverName: "x", approvalDate: "2026-09-08" });
const gq = await bw(U.sub, "order_form_generate", { expenseId: EQ });
check("O25 exactly 1,500 ILS: form generated, supplier signature NOT required (branch-signed form suffices)", ok(gq) &&
  !gq.data.requirements.supplierSignatureRequired && !req(gq.data, "order_form_signed").required && req(gq.data, "order_form").satisfied);
const vis = await build({ entryPoints: [path.resolve("api/budget/_orderFormPdf.ts")], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error" });
const modPath = path.join(os.tmpdir(), `kolbox-s4-pdf-${RUN}.cjs`);
(await import("node:fs")).writeFileSync(modPath, vis.outputFiles[0].text);
const pdfMod = createRequire(import.meta.url)(modPath);
check("O26 bidi: numbers stay left-to-right inside RTL text", pdfMod.toVisual("ח.פ 512345678") === "512345678 פ.ח");
check("O27 money formatting has no floating point (149,999 / 150,000 / 150,001 agorot)",
  pdfMod.formatMoney(149999) === "1,499.99 ₪" && pdfMod.formatMoney(150000) === "1,500.00 ₪" && pdfMod.formatMoney(150001) === "1,500.01 ₪");
const worst = {
  template: "kolbox-order-form-v1",
  header: { lines: Array.from({ length: 6 }, () => "ש".repeat(200)), electionYearLabel: "ב".repeat(50) },
  branch: { name: "ס".repeat(200), number: "9".repeat(50), orderer: "מ".repeat(200) },
  order: { referenceNo: 999999, description: "תיאור ארוך ".repeat(45).slice(0, 500), category: "ק".repeat(100), orderDate: "2026-09-10",
    deliveryDate: "2026-09-20", net: 999999999999, vat: 999999999999, vatRateBp: 1800, total: 1000000000000, partyAmount: 1000000000000 },
  supplier: { businessName: "ע".repeat(200), taxId: "123456789012", address: "כ".repeat(300), phone: "0".repeat(32), contactName: "א".repeat(200) },
  preapprovals: Array.from({ length: 5 }, (_, i) => ({ orderNumber: `N-${i}`, approvalCode: "C".repeat(100), approverName: "ש".repeat(200),
    approvalDate: "2026-09-08", preapprovedAmount: 1000000000000 })),
  supplierSignatureRequired: true,
  rules: { supplierSignature: { condition: "amount_gt", threshold: 150000 }, invoice: { condition: "amount_gte", threshold: 150000 } },
};
let worstPages = 0;
try { worstPages = (await PDFDocument.load(await pdfMod.renderOrderFormPdf(worst, { preview: false, versionNo: 9999 }))).getPageCount(); } catch { worstPages = -1; }
check("O28 worst-case data (6 max header lines, 5 approvals, max lengths/amounts) still renders one page", worstPages === 1, String(worstPages));

// ---------------------------------------------------------------------------
section("CLOSE GUARD + REQUIREMENT SNAPSHOT");
// EO (2,000 ILS, party): pay it fully, then walk the documents in.
eo = (await bw(U.view, "get_expense", { expenseId: EO })).data;
eo = (await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: eo.version, toStatus: "committed" })).data;
const alloc = eo.allocations[0].id;
await bw(U.sub, "mark_submission_sent", { allocationId: alloc });
await bw(U.sub, "record_payment_reference", { allocationId: alloc, referenceNumber: "R-77", authorizedAmount: 200000, receivedDate: "2026-09-12" });
await bw(U.exp, "record_payment", { allocationId: alloc, amount: 200000, paymentDate: "2026-09-13", confirmationSource: "funder_notice", idempotencyKey: uuid() });
eo = (await bw(U.view, "get_expense", { expenseId: EO })).data;
eo = (await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: eo.version, toStatus: "incurred" })).data;
const blocked = await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: eo.version, toStatus: "closed" });
check("K01 financially complete but documents missing -> CLOSE_BLOCKED with the document blockers only",
  is(blocked, 409, "CLOSE_BLOCKED") && blocked.body.blockers.includes("REQUIRED_DOCUMENTS_MISSING") &&
  blocked.body.blockers.includes("ORDER_FORM_INCOMPLETE") && !blocked.body.blockers.includes("SUPPLIER_NOT_FULLY_PAID"),
  JSON.stringify(blocked.body));
const g5 = await bw(U.sub, "order_form_generate", { expenseId: EO });
const vLatest = g5.data.orderForm.versions[0];
await upload(U.sub, { purpose: "order_form_return", orderFormVersionId: vLatest.id }, FILES.pdf(), { name: "signed.pdf" });
await upload(U.exp, { purpose: "expense", expenseId: EO, documentTypeId: TYPE.quotation }, FILES.pdf(), { name: "quote.pdf" });
const inv = await upload(U.exp, { purpose: "expense", expenseId: EO, documentTypeId: TYPE.invoice }, FILES.pdf(), { name: "invoice.pdf" });
check("K02 all required documents present (bank confirmation from the supplier file) -> ready", inv.complete?.data?.requirements.ready === true,
  JSON.stringify(inv.complete?.data?.requirements.missing));
eo = (await bw(U.view, "get_expense", { expenseId: EO })).data;
const closed = await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: eo.version, toStatus: "closed" });
check("K03 the expense closes", ok(closed) && closed.data.status === "closed", d(closed));
const atClose = await docsOf(U.view, EO);
check("K04 a requirement snapshot was taken at close and is what the closed expense shows", atClose.requirements.mode === "snapshot" &&
  atClose.requirements.invoiceRequired === true && q1(`select count(*) from public.budget_expense_requirement_snapshots where expense_id = '${EO}';`) === "1");
await bw(U.set, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 500000 });
await bw(U.set, "update_document_rule", { ruleId: rule("quotation", "always").id, isActive: false });
const laterClosed = await docsOf(U.view, EO);
check("K05 later rule changes (threshold 5,000 ILS, quotation rule off) do NOT change the closed expense",
  JSON.stringify(laterClosed.requirements.items) === JSON.stringify(atClose.requirements.items) && laterClosed.requirements.invoiceRequired === true);
check("K06 ... while an open expense of the same amount is evaluated live under the new rules",
  (await docsOf(U.view, E_P2)).requirements.invoiceRequired === false && !req(await docsOf(U.view, E_P2), "quotation")?.required);
check("K07 a closed expense's documents are locked", is(await bw(U.exp, "document_upload_start", { purpose: "expense", expenseId: EO, documentTypeId: TYPE.photo, fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 10 }), 409, "EXPENSE_LOCKED") &&
  is(await bw(U.sub, "order_form_generate", { expenseId: EO }), 409, "EXPENSE_LOCKED"));
err = "";
try { q1(`delete from public.budget_expense_requirement_snapshots where expense_id = '${EO}';`); } catch (e) { err = String(e.stderr); }
check("K08 snapshots are append-only", err.includes("BUDGET_APPEND_ONLY"));
const reopened = await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: closed.data.version, toStatus: "incurred", reason: "תיקון" });
check("K09 a reopened expense is evaluated live again", ok(reopened) && (await docsOf(U.view, EO)).requirements.mode === "live");
const reclosed = await bw(U.exp, "transition_expense", { expenseId: EO, expectedVersion: reopened.data.version, toStatus: "closed" });
check("K10 re-closing takes a NEW snapshot (the old one stays)", ok(reclosed) &&
  q1(`select count(*) from public.budget_expense_requirement_snapshots where expense_id = '${EO}';`) === "2", d(reclosed));
await bw(U.set, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 150000 });
await bw(U.set, "update_document_rule", { ruleId: rule("quotation", "always").id, isActive: true });

// ---------------------------------------------------------------------------
section("ACL / ENTITLEMENT / AUDIT");
const priv = q1(`select bool_or(has_table_privilege(r, 'public.' || t, 'select') or has_table_privilege(r, 'public.' || t, 'insert')
  or has_table_privilege(r, 'public.' || t, 'update') or has_table_privilege(r, 'public.' || t, 'delete'))
  from unnest(array['anon','authenticated','service_role']) r,
  (select tablename t from pg_tables where schemaname = 'public' and tablename like 'budget\\_%') x;`);
check("A01 no table privilege on any budget_* table (Stage 4 tables included)", priv === "f", priv);
const rls = q1(`select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('budget_documents','budget_document_versions','budget_order_form_versions',
  'budget_document_uploads','budget_expense_document_flags','budget_expense_requirement_snapshots');`);
check("A02 RLS on every Stage 4 table", rls === "t", rls);
const grants = q1(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and (has_function_privilege('service_role', p.oid, 'execute')
  or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
check("A03 still ONLY the two dispatchers + the worker step-up mint are executable (service_role)",
  grants === "budget_dispatch_owner,budget_dispatch_worker,budget_stepup_mint_worker", grants);
const docAudit = q1(`select count(distinct entity_type) from public.budget_audit_events where workspace_id = '${WA}'
  and entity_type in ('budget_documents','budget_document_versions','budget_order_form_versions','budget_document_uploads',
  'budget_expense_document_flags','budget_expense_requirement_snapshots');`);
check("A04 uploads, versions, archive, order forms, flags and snapshots are all audited", docAudit === "6", docAudit);
q1(`delete from public.election_workspace_modules where workspace_id = '${WA}' and module_key = 'budget';`);
check("A05 entitlement removed -> document ops refused (download, upload, generate)",
  is(await bw(U.full, "document_download", { versionId: qv1.id }), 403, "MODULE_NOT_ENABLED") &&
  is(await bw(U.full, "document_upload_start", startArgs({})), 403, "MODULE_NOT_ENABLED") &&
  is(await bw(U.full, "order_form_generate", { expenseId: E_P2 }), 403, "MODULE_NOT_ENABLED"));
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}', 'budget');`);
check("A06 no cookie -> 401 on document ops", is(await bw("", "document_download", { versionId: qv1.id }), 401, "UNAUTHORIZED"));
check("A07 unknown argument on a document op -> 400", is(await bw(U.full, "document_download", { versionId: qv1.id, storagePath: "x" }), 400, "INVALID_REQUEST"));

// ---------------------------------------------------------------------------
section("CLEANUP");
q1(`update public.platform_modules set available = false where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check("Z01 budget.available restored to false on the scratch stack", q1(`select available from public.platform_modules where key = 'budget';`) === "f");

process.exit(tally("BUDGET STAGE 4 DOCUMENTS") ? 1 : 0);
