// Budget Stage 5 - REAL-LOCAL suite for the party funding workflow: prior
// budget approval, funding allocations (split / gap / cap), the submission
// lifecycle and its gates (the Stage 4 requirement engine), returned for
// correction + resend, the payment reference, party payments to the supplier
// (installments, reversal), concurrency / idempotency, authorization and audit.
//
// Real Postgres + real GoTrue + real Storage (the isolated kolboxs5 scratch
// stack started with S5_STORAGE=1), the REAL bundled handlers, real
// PermissionUser sessions and a real Election Owner. Synthetic data only; no
// password, cookie, proof, token or signed URL is ever printed.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/api-budget-party.mjs
// DESTRUCTIVE ON THE SCRATCH STACK ONLY (loadStack() refuses anything else).
import crypto from "node:crypto";
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
const PFX = `S5P-${RUN}`;
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const DOMAIN = `budget-s5-${RUN}.invalid`;
const CODES = { A: code(), B: code(), C: code() };
const PW = "S5-Party-Pw-5!";
const uuid = () => crypto.randomUUID();
const q1 = (sql) => psql(sql);
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
async function bw(cookie, op, args, extra = {}) {
  const r = await callHandler(H.budget, {
    method: "POST", url: extra.url ?? "/api/budget/actions", headers: { origin: ORIGIN },
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
const d = (r) => `${r.status} ${r.error ?? ""}${r.body?.blockers ? " " + r.body.blockers.join(",") : ""}`;

const pad = (head, n) => Buffer.concat([head, crypto.randomBytes(Math.max(0, n - head.length))]);
const FILES = {
  pdf: (n = 2048) => pad(Buffer.from("%PDF-1.7\n%synthetic\n"), n),
  jpg: (n = 2048) => pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), n),
};
/** The browser flow: start -> PUT to the signed URL -> complete. */
async function upload(cookie, target, bytes, { mime = "application/pdf", name = "document.pdf" } = {}) {
  const start = await bw(cookie, "document_upload_start", { ...target, fileName: name, mimeType: mime, sizeBytes: bytes.length });
  if (!ok(start)) return { start, stage: "start" };
  const res = await fetch(start.data.uploadUrl, { method: "PUT", headers: { "content-type": mime, "x-upsert": "false" }, body: bytes });
  if (!res.ok) return { start, put: res.status, stage: "put" };
  const complete = await bw(cookie, "document_upload_complete", { uploadId: start.data.uploadId });
  return { start, complete, stage: "complete" };
}

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
q1(`update public.platform_modules set available = true where key = 'budget';`);
const bucket = q1(`select count(*) from storage.buckets where id = 'budget-documents';`);
check("S00 storage is running and the bucket exists (stack started with S5_STORAGE=1)", bucket === "1", bucket);
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const ws = (label, c) => q1(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() + interval '10 days', '${c}') returning id;`);
const WA = ws("A", CODES.A);
const WB = ws("B", CODES.B);
const WC = ws("C no budget", CODES.C);
q1(`insert into public.election_workspace_modules (workspace_id, module_key)
  values ('${WA}','election_day'),('${WA}','budget'),('${WB}','budget'),('${WC}','election_day');`);
const role = (w, name, perms) => q1(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => q1(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
const ROLES = {
  full: ALL, view: ["budget.view"], exp: ["budget.view", "budget.manageExpenses"],
  sub: ["budget.view", "budget.manageFunderSubmissions"], sup: ["budget.view", "budget.manageSuppliers"],
  mgr: ["electionDay.manageUsers", "voter.markVoted"],
};
for (const [k, perms] of Object.entries(ROLES)) user(WA, `u-${k}`, role(WA, k, perms));
user(WB, "u-bfull", role(WB, "b full", ALL));
user(WC, "u-cfull", role(WC, "c full", ALL));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
q1(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner S5', '${ownerEmail}');`);
const OWNER = (await signIn(ownerEmail, PW)).token;
const U = {};
for (const k of Object.keys(ROLES)) U[k] = await login(CODES.A, `u-${k}`);
const UB = await login(CODES.B, "u-bfull");
const UC = await login(CODES.C, "u-cfull");
check("S01 fixtures + sessions (3 workspaces, 6 roles, Owner)", Object.values(U).every(Boolean) && Boolean(UB && UC && OWNER));

const CS = (await bw(U.full, "create_category", { name: `${PFX} שילוט` })).data.id;
const src = async (name, kind) => (await bw(U.full, "create_source", { name: `${PFX} ${name}`, kind, originalAmount: 100000000 })).data.id;
const SP = await src("מפלגה", "party");
const SP2 = await src("מפלגה ב", "party");
const SD = await src("תרומות", "donation");
const SPE = await src("עצמי", "personal");
const SUP = (await bw(U.full, "create_supplier", { businessName: `${PFX} דפוס הצפון`, taxId: "514000111", phone: "050-1234567" })).data.id;
const SUP2 = (await bw(U.full, "create_supplier", { businessName: `${PFX} ספק בלי אישור בנק` })).data.id;
await bo(OWNER, "update_settings", { branchName: "סניף בדיקה", branchNumber: "17", defaultOrderer: "ישראל ישראלי",
  electionYearLabel: "בחירות 2026", funderHeaderLines: ["מפלגה לדוגמה"] });
const settings = (await bw(U.view, "get_settings")).data;
const TYPE = Object.fromEntries(settings.documentTypes.map((t) => [t.key, t.id]));
const rule = (key, cond) => settings.documentRules.find((r) => r.documentTypeKey === key && r.condition === cond);
const bank = await upload(U.sup, { purpose: "supplier", supplierId: SUP, documentTypeId: TYPE.bank_confirmation, validUntil: "2099-12-31" }, FILES.pdf(), { name: "bank.pdf" });
check("S02 supplier bank-account confirmation on file (satisfies every party expense of SUP)", ok(bank.complete), d(bank.complete ?? bank.start));

// ---------------------------------------------------------------------------
// Helpers (every figure asserted below comes from the SERVER)
// ---------------------------------------------------------------------------
const get = async (id) => (await bw(U.view, "get_expense", { expenseId: id })).data;
const wf = (e, alloc) => e.party.find((x) => x.allocationId === alloc);
const partyAlloc = (e, source = SP) => e.allocations.find((x) => x.sourceId === source)?.id;
async function mkExpense(total, { desc = "הוצאה", supplier = SUP } = {}) {
  return (await bw(U.full, "create_expense", { description: `${PFX} ${desc}`, supplierId: supplier, categoryId: CS, total, expenseDate: "2026-09-10" })).data.id;
}
const setAlloc = (expenseId, sourceId, amount) => bw(U.exp, "set_allocation", { expenseId, sourceId, amount });
async function transition(expenseId, toStatus, reason) {
  const e = await get(expenseId);
  return bw(U.exp, "transition_expense", { expenseId, expectedVersion: e.version, toStatus, ...(reason ? { reason } : {}) });
}
const preapprove = (allocationId, amount, extra = {}) => bw(U.sub, "record_preapproval", {
  allocationId, approvalCode: "AP-100", approverName: "מינהל הכספים", approvalDate: "2026-09-08",
  ...(amount === undefined ? {} : { preapprovedAmount: amount }), ...extra });
const generate = (expenseId) => bw(U.sub, "order_form_generate", { expenseId });
const latestForm = (docs) => docs.orderForm.versions[0];
const signReturn = (formVersionId) => upload(U.sub, { purpose: "order_form_return", orderFormVersionId: formVersionId }, FILES.pdf(), { name: "signed.pdf" });
const addDoc = (expenseId, key, file = FILES.pdf(), opts = {}) =>
  upload(U.exp, { purpose: "expense", expenseId, documentTypeId: TYPE[key] }, file, opts);
const ready = (allocationId) => bw(U.sub, "mark_submission_ready", { allocationId });
const sent = (allocationId, extra = {}) => bw(U.sub, "mark_submission_sent", { allocationId, ...extra });
const returned = (allocationId, note, extra = {}) => bw(U.sub, "mark_submission_returned", { allocationId, ...(note ? { note } : {}), ...extra });
const reference = (allocationId, authorizedAmount, extra = {}) => bw(U.sub, "record_payment_reference", {
  allocationId, referenceNumber: "REF-1", authorizedAmount, receivedDate: "2026-09-12", ...extra });
const pay = (allocationId, amount, key = uuid(), who = U.exp) =>
  bw(who, "record_payment", { allocationId, amount, paymentDate: "2026-09-14", confirmationSource: "funder_notice", idempotencyKey: key });
const auditCount = (entity, id, action) => q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}'
  and entity_type = '${entity}' and entity_id = '${id}'${action ? ` and action = '${action}'` : ""};`);
/** A committed party expense (party allocation = total), pre-approved, with
 * the final form and every required document, ready to be marked ready. */
async function preparedExpense(total, desc) {
  const id = await mkExpense(total, { desc });
  await setAlloc(id, SP, total);
  await transition(id, "committed");
  const al = partyAlloc(await get(id));
  await preapprove(al, total);
  const g = await generate(id);
  if (total > 150000) {
    await signReturn(latestForm(g.data).id);
    await addDoc(id, "invoice");
  }
  await addDoc(id, "quotation");
  return { id, al };
}

// ---------------------------------------------------------------------------
section("FUNDING ALLOCATIONS (one expense, several sources, explicit gap)");
const EF = await mkExpense(1000000, { desc: "10,000 split" });
let r = await setAlloc(EF, SP, 1000000);
const efA = partyAlloc(r.data);
check("F01 party allocation 10,000 on a 10,000 expense -> fully covered", ok(r) && r.data.funding.party === 1000000 && r.data.funding.uncovered === 0);
r = await preapprove(efA, 600000);
check("F02 prior approval of 6,000 leaves the party allocation at 10,000 (never auto-changed) + flags the excess",
  ok(r) && r.data.allocations.find((x) => x.id === efA).amount === 1000000 && wf(r.data, efA).exceedsPreapproval &&
  r.data.funding.partyPreapproved === 600000 && r.data.allocations.length === 1, d(r));
check("F03 ... and the excess is a gate: PARTY_EXCEEDS_PREAPPROVAL in the live blockers", wf(r.data, efA).readiness.blockers.includes("PARTY_EXCEEDS_PREAPPROVAL"));
check("F04 party allocation above the pre-approved cap (cap + 1 = 6,000.01) -> 409", is(await setAlloc(EF, SP, 600001), 409, "PARTY_EXCEEDS_PREAPPROVAL"));
check("F05 cap - 1 (5,999.99) accepted", ok(await setAlloc(EF, SP, 599999)));
r = await setAlloc(EF, SP, 600000);
check("F06 exactly the cap (6,000) accepted; the 4,000 gap is VISIBLE and nothing else was created",
  ok(r) && r.data.funding.party === 600000 && r.data.funding.uncovered === 400000 && r.data.facts.unfunded === 400000 &&
  r.data.allocations.length === 1 && !wf(r.data, efA).exceedsPreapproval, d(r));
check("F07 the gap is never auto-filled (no personal/donation allocation appeared)", r.data.funding.personal === 0 && r.data.funding.donation === 0);
check("F08 allocation sum above the total (personal 4,000.01) -> 409", is(await setAlloc(EF, SPE, 400001), 409, "ALLOCATIONS_EXCEED_TOTAL"));
r = await setAlloc(EF, SPE, 400000);
check("F09 user resolves the gap explicitly: party 6,000 + personal 4,000 = 10,000, ONE expense",
  ok(r) && r.data.funding.party === 600000 && r.data.funding.personal === 400000 && r.data.funding.uncovered === 0 &&
  r.data.id === EF && r.data.allocations.length === 2);
const E2 = await mkExpense(1000000, { desc: "party + donation" });
await setAlloc(E2, SP, 700000);
r = await setAlloc(E2, SD, 300000);
check("F10 split party / donation", r.data.funding.party === 700000 && r.data.funding.donation === 300000 && r.data.funding.uncovered === 0);
const E3 = await mkExpense(1000000, { desc: "three sources" });
await setAlloc(E3, SP, 500000);
await setAlloc(E3, SD, 300000);
r = await setAlloc(E3, SPE, 200000);
check("F11 all three sources on one expense (5,000 + 3,000 + 2,000)", r.data.funding.party === 500000 && r.data.funding.donation === 300000 &&
  r.data.funding.personal === 200000 && r.data.funding.allocated === 1000000 && r.data.funding.uncovered === 0);
const E4 = await mkExpense(1000000, { desc: "edge amounts" });
check("F12 zero allocation -> 400", is(await setAlloc(E4, SP, 0), 400, "INVALID_INPUT"));
check("F13 negative allocation -> 400", is(await setAlloc(E4, SP, -100), 400, "INVALID_INPUT"));
check("F14 fractional agorot (1.5) / numeric string -> 400", is(await setAlloc(E4, SP, 1.5), 400, "INVALID_INPUT") &&
  is(await bw(U.exp, "set_allocation", { expenseId: E4, sourceId: SP, amount: "100" }), 400, "INVALID_INPUT"));
r = await setAlloc(E4, SP, 1);
check("F15 the smallest amount (1 agora) is a valid allocation; the rest stays an explicit gap", ok(r) && r.data.funding.uncovered === 999999);
const E5 = await mkExpense(1000000, { desc: "race" });
const [al1, al2] = await Promise.all([setAlloc(E5, SP, 600000), setAlloc(E5, SPE, 600000)]);
check("F16 two concurrent allocations that jointly exceed the total: exactly one succeeds", [al1, al2].filter(ok).length === 1 &&
  [al1, al2].some((x) => is(x, 409, "ALLOCATIONS_EXCEED_TOTAL")), `${d(al1)} | ${d(al2)}`);
r = await bw(U.view, "get_expense", { expenseId: EF, funding: { uncovered: 0, party: 1 }, facts: { unfunded: 0 } });
check("F17 client-supplied figures are ignored (the server computes every balance)", ok(r) && r.data.funding.party === 600000 && r.data.funding.uncovered === 0);

// ---------------------------------------------------------------------------
section("PRIOR BUDGET APPROVAL (before the final order form; not the payment reference)");
const EX = await mkExpense(200000, { desc: "2,000 ILS main" });
r = await setAlloc(EX, SP, 200000);
const xA = partyAlloc(r.data);
check("PA01 initial state: waiting for the prior budget approval", wf(r.data, xA).workflowState === "awaiting_preapproval" &&
  r.data.allocations.find((x) => x.id === xA).submission.displayState === "awaiting_preapproval" && r.data.funding.partyPreapproved === null);
check("PA02 required fields: approval code / approver / date",
  is(await preapprove(xA, 200000, { approvalCode: "" }), 400, "INVALID_INPUT") &&
  is(await preapprove(xA, 200000, { approverName: " " }), 400, "INVALID_INPUT") &&
  is(await bw(U.sub, "record_preapproval", { allocationId: xA, approvalCode: "A", approverName: "B" }), 400, "INVALID_INPUT") &&
  is(await preapprove(xA, 200000, { approvalDate: "2026-02-30" }), 400, "INVALID_INPUT"));
check("PA03 pre-approved amount must be a positive integer (0 / -1 / 1.5 -> 400)",
  is(await preapprove(xA, 0), 400, "INVALID_INPUT") && is(await preapprove(xA, -1), 400, "INVALID_INPUT") && is(await preapprove(xA, 1.5), 400, "INVALID_INPUT"));
const prev = await bw(U.sub, "order_form_preview", { expenseId: EX });
check("PA04 the order-form PREVIEW is allowed before the prior approval", ok(prev) && Buffer.from(prev.data.pdfBase64, "base64").subarray(0, 5).toString() === "%PDF-");
check("PA05 FINAL order-form generation before the prior approval -> 409", is(await generate(EX), 409, "PREAPPROVAL_REQUIRED"));
await transition(EX, "committed");
check("PA06 ready / sent before the prior approval -> 409 PREAPPROVAL_REQUIRED",
  is(await ready(xA), 409, "PREAPPROVAL_REQUIRED") && is(await sent(xA), 409, "PREAPPROVAL_REQUIRED"));
check("PA07 manageExpenses / view cannot record a prior approval", is(await bw(U.exp, "record_preapproval", { allocationId: xA }), 403, "FORBIDDEN") &&
  is(await bw(U.view, "record_preapproval", { allocationId: xA }), 403, "FORBIDDEN"));
r = await preapprove(xA, 200000, { orderNumber: "77/2026", note: "אושר בטלפון" });
let x = r.data;
let pre = x.allocations.find((y) => y.id === xA).preapproval;
check("PA08 prior approval recorded (code, approver, date, order no., amount, note) -> 'אושר תקציבית מראש'",
  ok(r) && pre.approvalCode === "AP-100" && pre.approverName === "מינהל הכספים" && pre.approvalDate === "2026-09-08" &&
  pre.orderNumber === "77/2026" && pre.preapprovedAmount === 200000 && pre.note === "אושר בטלפון" && wf(x, xA).workflowState === "preapproved", d(r));
check("PA09 ... and it is NOT a payment reference (reference null, party unpaid)", x.allocations.find((y) => y.id === xA).reference === null &&
  wf(x, xA).paymentStatus === "unpaid" && !wf(x, xA).hasReference);
const auditBefore = auditCount("budget_party_preapprovals", xA);
r = await preapprove(xA, 200000, { orderNumber: "77/2026", note: "אושר בטלפון" });
check("PA10 an identical retry (double click, no version) is idempotent: 200, no second write",
  ok(r) && auditCount("budget_party_preapprovals", xA) === auditBefore, `${auditBefore} -> ${auditCount("budget_party_preapprovals", xA)}`);
check("PA11 a CHANGED approval without expectedVersion -> 400; with a stale version -> 409",
  is(await preapprove(xA, 200000, { approverName: "גזבר" }), 400, "INVALID_INPUT") &&
  is(await preapprove(xA, 200000, { approverName: "גזבר", expectedVersion: 999 }), 409, "STALE_VERSION"));
r = await preapprove(xA, 200000, { approverName: "גזבר", orderNumber: "77/2026", note: "תוקן", expectedVersion: pre.version });
const corr = q1(`select before_data ->> 'approver_name' || '|' || (after_data ->> 'approver_name') from public.budget_audit_events
  where workspace_id = '${WA}' and entity_type = 'budget_party_preapprovals' and entity_id = '${xA}' and action = 'update' order by id desc limit 1;`);
check("PA12 correction with the current version -> audited with before/after", ok(r) && corr === "מינהל הכספים|גזבר" &&
  wf(r.data, xA).preapprovalHistory.length >= 2, corr);
const g1 = await generate(EX);
check("PA13 after the prior approval: the FINAL order form v1 is generated; the process is collecting documents",
  ok(g1) && latestForm(g1.data).versionNo === 1 && wf(await get(EX), xA).workflowState === "collecting_documents", d(g1));

// ---------------------------------------------------------------------------
section("DOCUMENT GATING (Stage 4 requirement engine decides; Stage 5 enforces)");
let b = await ready(xA);
check("DG01 required documents missing -> ready refused with the blockers (2,000 ILS: signature, quotation, invoice)",
  is(b, 409, "SUBMISSION_BLOCKED") && b.body.blockers.includes("SUPPLIER_SIGNATURE_MISSING") && b.body.blockers.includes("REQUIRED_DOCUMENTS_MISSING") &&
  !b.body.blockers.includes("ORDER_FORM_MISSING") && !b.body.blockers.includes("PREAPPROVAL_REQUIRED"), d(b));
x = await get(EX);
const missingKeys = wf(x, xA).readiness.missingDocuments.map((m) => m.key).sort().join(",");
check("DG02 the readiness view lists exactly the missing documents (bank confirmation comes from the supplier file)",
  !wf(x, xA).readiness.ready && missingKeys === "invoice,order_form_signed,quotation", missingKeys);
await addDoc(EX, "quotation");
await addDoc(EX, "invoice");
b = await ready(xA);
check("DG03 quotation + invoice uploaded -> only the supplier signature still blocks", is(b, 409, "SUBMISSION_BLOCKED") &&
  b.body.blockers.join(",") === "SUPPLIER_SIGNATURE_MISSING", d(b));
const signed1 = await signReturn(latestForm(g1.data).id);
x = await get(EX);
check("DG04 the supplier-signed form for the LATEST version completes the package -> readiness OK", ok(signed1.complete) &&
  wf(x, xA).readiness.ready && wf(x, xA).readiness.blockers.length === 0, JSON.stringify(wf(x, xA).readiness));
const EM = await mkExpense(100000, { desc: "no form yet" });
await setAlloc(EM, SP, 100000);
await transition(EM, "committed");
const emA = partyAlloc(await get(EM));
await preapprove(emA, 100000);
b = await ready(emA);
check("DG05 no final order form yet -> ORDER_FORM_MISSING", is(b, 409, "SUBMISSION_BLOCKED") && b.body.blockers.includes("ORDER_FORM_MISSING"), d(b));
const EDR = await mkExpense(100000, { desc: "still draft" });
await setAlloc(EDR, SP, 100000);
const edrA = partyAlloc(await get(EDR));
await preapprove(edrA, 100000);
check("DG06 a draft expense cannot be marked ready -> EXPENSE_NOT_SUBMITTABLE", is(await ready(edrA), 409, "EXPENSE_NOT_SUBMITTABLE"));
// Money boundaries (strictly greater than 1,500 ILS).
const B1 = await preparedExpense(149999, "1,499.99");
const B2 = await preparedExpense(150000, "1,500.00");
const B3id = await mkExpense(150001, { desc: "1,500.01" });
await setAlloc(B3id, SP, 150001);
await transition(B3id, "committed");
const b3A = partyAlloc(await get(B3id));
await preapprove(b3A, 150001);
await generate(B3id);
await addDoc(B3id, "quotation");
const w1 = wf(await get(B1.id), B1.al);
const w2 = wf(await get(B2.id), B2.al);
const w3 = wf(await get(B3id), b3A);
check("DG07 1,499.99: form + quotation suffice (no invoice, no supplier signature) -> ready", w1.readiness.ready, JSON.stringify(w1.readiness));
check("DG08 exactly 1,500.00: still no invoice / signature required -> ready", w2.readiness.ready, JSON.stringify(w2.readiness));
check("DG09 1,500.01: invoice AND supplier signature required -> blocked",
  !w3.readiness.ready && w3.readiness.blockers.includes("SUPPLIER_SIGNATURE_MISSING") &&
  w3.readiness.missingDocuments.map((m) => m.key).sort().join(",") === "invoice,order_form_signed", JSON.stringify(w3.readiness));
r = await bw(U.exp, "set_expense_document_flag", { expenseId: B2.id, documentTypeId: TYPE.photo, required: true });
const w2p = wf(await get(B2.id), B2.al);
check("DG10 photo required for THIS expense (per-expense override) -> blocked until a photo is added", ok(r) && !w2p.readiness.ready &&
  w2p.readiness.missingDocuments.some((m) => m.key === "photo"));
await addDoc(B2.id, "photo", FILES.jpg(), { mime: "image/jpeg", name: "photo.jpg" });
check("DG11 ... photo added -> ready again", wf(await get(B2.id), B2.al).readiness.ready);
const ENB = await mkExpense(100000, { desc: "supplier without bank confirmation", supplier: SUP2 });
await setAlloc(ENB, SP, 100000);
await transition(ENB, "committed");
const enbA = partyAlloc(await get(ENB));
await preapprove(enbA, 100000);
await generate(ENB);
await addDoc(ENB, "quotation");
const wnb = wf(await get(ENB), enbA);
check("DG12 bank-account confirmation required: a supplier without one blocks the package",
  !wnb.readiness.ready && wnb.readiness.missingDocuments.some((m) => m.key === "bank_confirmation"), JSON.stringify(wnb.readiness));
r = await bw(U.sub, "record_preapproval", { allocationId: B1.al, approvalCode: "AP-100", approverName: "מינהל הכספים", approvalDate: "2026-09-08",
  preapprovedAmount: 149998, expectedVersion: (await get(B1.id)).allocations.find((y) => y.id === B1.al).preapproval.version });
b = await ready(B1.al);
check("DG14 prior approval corrected BELOW the party allocation -> ready refused (PARTY_EXCEEDS_PREAPPROVAL + form outdated)",
  is(b, 409, "SUBMISSION_BLOCKED") && b.body.blockers.includes("PARTY_EXCEEDS_PREAPPROVAL") && b.body.blockers.includes("ORDER_FORM_OUTDATED"), d(b));

// ---------------------------------------------------------------------------
section("SUBMISSION LIFECYCLE (ready -> sent -> returned -> ready -> sent)");
check("SB01 'sent' without 'ready' -> 409 SUBMISSION_NOT_READY", is(await sent(xA), 409, "SUBMISSION_NOT_READY"));
r = await ready(xA);
x = r.data;
check("SB02 marked ready -> 'מוכן להגשה'", ok(r) && wf(x, xA).workflowState === "ready" && wf(x, xA).storedState === "ready" && wf(x, xA).readyAt, d(r));
r = await ready(xA);
const readyEvents = () => q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${xA}' and event = 'ready';`);
check("SB03 marking ready again is idempotent (one 'ready' event)", ok(r) && readyEvents() === "1", readyEvents());
check("SB04 the payment reference cannot be recorded while only 'ready'", is(await reference(xA, 200000), 409, "SUBMISSION_NOT_SENT"));
const sendKey = uuid();
r = await sent(xA, { idempotencyKey: sendKey, recipientPhone: "0501111111", note: "נשלח ב-WhatsApp" });
x = r.data;
const ev1 = x.submissionEvents.filter((e) => e.allocationId === xA && e.event === "sent");
check("SB05 sent: attempt 1 records the order-form version, the requested amount and the package", ok(r) &&
  wf(x, xA).workflowState === "sent" && ev1.length === 1 && ev1[0].attemptNo === 1 && ev1[0].orderFormVersionNo === 1 &&
  ev1[0].requestedAmount === 200000 && wf(x, xA).attempts === 1, d(r));
const pkg = JSON.parse(q1(`select package::text from public.budget_party_submission_events where allocation_id = '${xA}' and event = 'sent';`));
check("SB06 the sent package names the satisfying document versions", pkg.orderFormVersionNo === 1 && pkg.requestedAmount === 200000 &&
  ["order_form", "order_form_signed", "quotation", "invoice", "bank_confirmation"].every((k) => pkg.documents.some((dd) => dd.key === k && dd.satisfiedBy)));
r = await sent(xA, { idempotencyKey: sendKey });
check("SB07 a retried 'sent' with the SAME key returns 200 and records nothing new", ok(r) &&
  q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${xA}' and event = 'sent';`) === "1");
check("SB08 a second 'sent' (new key) while sent -> 409", is(await sent(xA, { idempotencyKey: uuid() }), 409, "INVALID_TRANSITION"));
check("SB09 a key reused for a DIFFERENT transition -> 409", is(await returned(xA, "x", { idempotencyKey: sendKey }), 409, "IDEMPOTENCY_CONFLICT"));
check("SB10 invalid transitions: ready while sent -> 409; returned without a note -> 400",
  is(await ready(xA), 409, "INVALID_TRANSITION") && is(await returned(xA), 400, "INVALID_INPUT"));
check("SB11 the party allocation is frozen while sent", is(await setAlloc(EX, SP, 190000), 409, "ALLOCATION_FROZEN"));
const retKey = uuid();
r = await returned(xA, "חסר צילום של השלט המותקן", { idempotencyKey: retKey });
x = r.data;
check("SB12 returned for correction (note + attempt 1) -> 'הוחזר לתיקון'", ok(r) && wf(x, xA).workflowState === "returned" &&
  x.submissionEvents.some((e) => e.event === "returned" && e.attemptNo === 1 && e.note === "חסר צילום של השלט המותקן"), d(r));
check("SB13 retried 'returned' with its key -> 200, one event; a new 'returned' -> 409",
  ok(await returned(xA, "חסר צילום של השלט המותקן", { idempotencyKey: retKey })) &&
  q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${xA}' and event = 'returned';`) === "1" &&
  is(await returned(xA, "again", { idempotencyKey: uuid() }), 409, "INVALID_TRANSITION"));
check("SB14 resend without marking ready again -> 409 SUBMISSION_NOT_READY", is(await sent(xA), 409, "SUBMISSION_NOT_READY"));
// The correction changes order-form data -> the form is outdated -> version 2.
x = await get(EX);
r = await bw(U.exp, "update_expense", { expenseId: EX, expectedVersion: x.version, deliveryDate: "2026-09-25" });
b = await ready(xA);
check("SB15 after a correction the old form is OUTDATED -> ready refused until version N+1", ok(r) && is(b, 409, "SUBMISSION_BLOCKED") &&
  b.body.blockers.includes("ORDER_FORM_OUTDATED"), d(b));
const g2 = await generate(EX);
b = await ready(xA);
check("SB16 regenerated as version 2 (v1 kept) -> a NEW supplier signature is required", ok(g2) && latestForm(g2.data).versionNo === 2 &&
  g2.data.orderForm.versions.length === 2 && is(b, 409, "SUBMISSION_BLOCKED") && b.body.blockers.join(",") === "SUPPLIER_SIGNATURE_MISSING", d(b));
await signReturn(latestForm(g2.data).id);
check("SB17 signed v2 -> marked ready again", ok(await ready(xA)));
r = await sent(xA, { idempotencyKey: uuid() });
x = r.data;
const sentEvents = x.submissionEvents.filter((e) => e.allocationId === xA && e.event === "sent");
check("SB18 resent: attempt 2 with order-form version 2", ok(r) && sentEvents.length === 2 && sentEvents[1].attemptNo === 2 &&
  sentEvents[1].orderFormVersionNo === 2 && wf(x, xA).attempts === 2, d(r));
check("SB19 history keeps attempt 1 untouched (version 1) and the full sequence",
  sentEvents[0].attemptNo === 1 && sentEvents[0].orderFormVersionNo === 1 &&
  x.submissionEvents.filter((e) => e.allocationId === xA).map((e) => e.event).join(",") === "ready,sent,returned,ready,sent");
let err = "";
try { q1(`update public.budget_party_submission_events set note = 'x' where allocation_id = '${xA}';`); } catch (e) { err = String(e.stderr); }
let err2 = "";
try { q1(`delete from public.budget_party_submission_events where allocation_id = '${xA}';`); } catch (e) { err2 = String(e.stderr); }
check("SB20 submission attempts are append-only in the DB (update / delete refused)", err.includes("BUDGET_APPEND_ONLY") && err2.includes("BUDGET_APPEND_ONLY"));
// Concurrency on a second prepared expense.
const EY = await preparedExpense(100000, "concurrency");
const [ra, rb] = await Promise.all([ready(EY.al), ready(EY.al)]);
check("SB21 two concurrent 'ready' calls: both 200, ONE 'ready' event", ok(ra) && ok(rb) &&
  q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${EY.al}' and event = 'ready';`) === "1", `${d(ra)} | ${d(rb)}`);
const [sa, sb] = await Promise.all([sent(EY.al, { idempotencyKey: uuid() }), sent(EY.al, { idempotencyKey: uuid() })]);
check("SB22 two concurrent 'sent' calls (different keys): exactly one attempt", [sa, sb].filter(ok).length === 1 &&
  [sa, sb].some((y) => is(y, 409, "INVALID_TRANSITION")) &&
  q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${EY.al}' and event = 'sent';`) === "1", `${d(sa)} | ${d(sb)}`);
const sameKey = uuid();
const EQ = await preparedExpense(100000, "same-key race");
await ready(EQ.al);
const [s1, s2] = await Promise.all([sent(EQ.al, { idempotencyKey: sameKey }), sent(EQ.al, { idempotencyKey: sameKey })]);
check("SB23 a double-clicked 'sent' (same key, concurrent): both 200, ONE attempt", ok(s1) && ok(s2) &&
  q1(`select count(*) from public.budget_party_submission_events where allocation_id = '${EQ.al}' and event = 'sent';`) === "1", `${d(s1)} | ${d(s2)}`);

// ---------------------------------------------------------------------------
section("ORDER FORM GATING (Stage 4 lifecycle, not bypassed)");
const EO2 = await mkExpense(100000, { desc: "second party source" });
await setAlloc(EO2, SP, 50000);
await transition(EO2, "committed");
await preapprove(partyAlloc(await get(EO2)), 50000);
const go = await generate(EO2);
await setAlloc(EO2, SP2, 50000);
check("OG01 a party allocation WITHOUT a prior approval blocks 'sent to supplier' and the final form",
  is(await bw(U.sub, "order_form_mark_sent", { orderFormVersionId: latestForm(go.data).id }), 409, "PREAPPROVAL_REQUIRED") &&
  is(await generate(EO2), 409, "PREAPPROVAL_REQUIRED"));
check("OG02 ... while the preview stays available", ok(await bw(U.sub, "order_form_preview", { expenseId: EO2 })));

// ---------------------------------------------------------------------------
section("PAYMENT REFERENCE (the later authorization; not the prior approval; not a payment)");
check("PR01 a party payment before the payment reference -> 409", is(await pay(xA, 1000), 409, "PARTY_REFERENCE_REQUIRED"));
check("PR02 authorized above the requested amount (+1 agora) -> 409", is(await reference(xA, 200001), 409, "AUTHORIZED_EXCEEDS_REQUEST"));
r = await reference(xA, 200000, { referenceNumber: "REF-77", note: "אסמכתא 77" });
x = r.data;
const ref = x.allocations.find((y) => y.id === xA).reference;
check("PR03 reference recorded separately from the prior approval -> 'התקבל אישור/אסמכתת תשלום'", ok(r) &&
  ref.referenceNumber === "REF-77" && ref.authorizedAmount === 200000 && ref.note === "אסמכתא 77" &&
  wf(x, xA).workflowState === "reference_received" && x.allocations.find((y) => y.id === xA).preapproval.approvalCode === "AP-100", d(r));
check("PR04 ... it does NOT mean the supplier was paid (party unpaid, paid 0, remaining 2,000)",
  wf(x, xA).paymentStatus === "unpaid" && wf(x, xA).paid === 0 && wf(x, xA).remaining === 200000 && x.facts.paid === 0);
const refAudit = auditCount("budget_party_payment_references", xA);
check("PR05 an identical retry (no version) -> 200, no second write", ok(await reference(xA, 200000, { referenceNumber: "REF-77", note: "אסמכתא 77" })) &&
  auditCount("budget_party_payment_references", xA) === refAudit);
check("PR06 a changed reference without expectedVersion -> 400", is(await reference(xA, 200000, { referenceNumber: "REF-78" }), 400, "INVALID_INPUT"));
r = await reference(xA, 200000, { referenceNumber: "REF-78", note: "תוקן", expectedVersion: ref.version });
check("PR07 corrected with the current version (before any payment) -> audited, history shows both", ok(r) &&
  wf(r.data, xA).referenceHistory.length === 2 && auditCount("budget_party_payment_references", xA, "update") === "1", d(r));
check("PR08 after the reference: returned / ready refused", is(await returned(xA, "x"), 409, "INVALID_TRANSITION") && is(await ready(xA), 409, "INVALID_TRANSITION"));
r = await reference(EY.al, 60000, { referenceNumber: "REF-EY" });
check("PR09 partial authorization (600 of 1,000): party allocation = 600, gap 400 explicit, nothing auto-assigned", ok(r) &&
  r.data.funding.party === 60000 && r.data.funding.uncovered === 40000 && r.data.allocations.length === 1 &&
  r.data.funding.partyAuthorized === 60000, d(r));
r = await setAlloc(EY.id, SD, 40000);
check("PR10 the user funds the 400 gap from a source they choose (donation)", ok(r) && r.data.funding.uncovered === 0 && r.data.funding.donation === 40000);

// ---------------------------------------------------------------------------
section("PARTY PAYMENTS TO THE SUPPLIER (installments, reversal, ceiling)");
const k1 = uuid();
r = await pay(xA, 80000, k1);
x = r.data;
check("PP01 installment 1 (800 of 2,000) -> partially paid; the party is the payer", ok(r) && wf(x, xA).paymentStatus === "partial" &&
  wf(x, xA).paid === 80000 && wf(x, xA).remaining === 120000 && x.payments.at(-1).payer === "party", d(r));
check("PP02 submission and payment status stay independent (reference_received + partial)", wf(x, xA).workflowState === "reference_received");
check("PP03 a retried payment (same key) -> no duplicate", ok(await pay(xA, 80000, k1)) && (await get(EX)).payments.length === 1);
check("PP04 same key, different amount -> 409", is(await pay(xA, 1, k1), 409, "IDEMPOTENCY_CONFLICT"));
check("PP05 zero / negative payment -> 400", is(await pay(xA, 0), 400, "INVALID_INPUT") && is(await pay(xA, -5), 400, "INVALID_INPUT"));
check("PP06 remaining + 1 agora -> 409 (never above the party allocation)", is(await pay(xA, 120001), 409, "PAYMENT_EXCEEDS_ALLOCATION"));
r = await pay(xA, 119999);
check("PP07 installment 2 = remaining - 1 -> still partial, remaining exactly 1 agora", ok(r) && wf(r.data, xA).remaining === 1 &&
  wf(r.data, xA).paymentStatus === "partial");
const inst2 = r.data.payments.find((pm) => pm.amount === 119999);
check("PP08 reversal needs a reason", is(await bw(U.exp, "void_payment", { paymentId: inst2.id }), 400, "INVALID_INPUT"));
r = await bw(U.exp, "void_payment", { paymentId: inst2.id, reason: "נרשם בטעות" });
x = r.data;
const voided = x.payments.find((pm) => pm.id === inst2.id);
check("PP09 reversed payment is excluded from paid (800 again) and kept with who/when/why", ok(r) && wf(x, xA).paid === 80000 &&
  wf(x, xA).remaining === 120000 && voided.voidedAt && voided.voidedByName && voided.voidReason === "נרשם בטעות" && x.payments.length === 2);
check("PP10 reversing twice -> 409", is(await bw(U.exp, "void_payment", { paymentId: inst2.id, reason: "x" }), 409, "PAYMENT_ALREADY_VOIDED"));
err = "";
try { q1(`delete from public.budget_supplier_payments where allocation_id = '${xA}';`); } catch (e) { err = String(e.stderr); }
err2 = "";
try { q1(`update public.budget_supplier_payments set amount_agorot = 1 where id = '${inst2.id}';`); } catch (e) { err2 = String(e.stderr); }
check("PP11 payment history is not destructively editable in the DB (delete / amount edit refused)", err.includes("BUDGET_APPEND_ONLY") &&
  (err2.includes("BUDGET_APPEND_ONLY") || err2.includes("PAYMENT_ALREADY_VOIDED")));
const [c1, c2] = await Promise.all([pay(xA, 70000), pay(xA, 70000)]);
check("PP12 two concurrent 700 payments against 1,200 remaining: exactly one succeeds", [c1, c2].filter(ok).length === 1 &&
  [c1, c2].some((y) => is(y, 409, "PAYMENT_EXCEEDS_ALLOCATION")), `${d(c1)} | ${d(c2)}`);
check("PP13 the reference is locked once a valid party payment exists", is(await reference(xA, 200000, {
  referenceNumber: "REF-79", expectedVersion: (await get(EX)).allocations.find((y) => y.id === xA).reference.version }), 409, "REFERENCE_LOCKED"));
r = await pay(xA, 50000);
x = r.data;
check("PP14 the exact remaining pays in full -> 'שולם במלואו', remaining 0", ok(r) && wf(x, xA).paymentStatus === "paid" && wf(x, xA).remaining === 0 &&
  wf(x, xA).paid === 200000, d(r));
check("PP15 any further agora -> 409", is(await pay(xA, 1), 409, "PAYMENT_EXCEEDS_ALLOCATION"));
const payers = q1(`select string_agg(distinct payer, ',') from public.budget_supplier_payments where allocation_id = '${xA}';`);
check("PP16 the party pays the supplier directly: every row is payer 'party'; nothing counted as campaign cash",
  payers === "party" && x.facts.campaignOutstanding === 0 && x.funding.partyPaid === 200000, payers);
check("PP17 a payment on a nonexistent allocation -> 404", is(await pay(uuid(), 100), 404, "NOT_FOUND"));

// ---------------------------------------------------------------------------
section("CLOSE + CLOSED REQUIREMENT SNAPSHOT");
await transition(EX, "incurred");
r = await transition(EX, "closed");
check("CL01 the fully-processed party expense closes", ok(r) && r.data.status === "closed", d(r));
check("CL02 party operations on a closed expense -> 409 EXPENSE_LOCKED", is(await ready(xA), 409, "EXPENSE_LOCKED") &&
  is(await preapprove(xA, 200000), 409, "EXPENSE_LOCKED") && is(await pay(xA, 1), 409, "EXPENSE_NOT_PAYABLE"));
await bw(U.full, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 500000 });
const closedDocs = (await bw(U.view, "get_expense_documents", { expenseId: EX })).data;
x = await get(EX);
check("CL03 a later rule change does not change the closed expense (snapshot; nothing reported missing)",
  closedDocs.requirements.mode === "snapshot" && closedDocs.requirements.invoiceRequired === true && wf(x, xA).readiness.missingDocuments.length === 0);
await bw(U.full, "update_document_rule", { ruleId: rule("invoice", "amount_gt").id, threshold: 150000 });

// ---------------------------------------------------------------------------
section("AUTHORIZATION / ISOLATION");
check("X01 no entitlement: a workspace without the budget module -> 403", is(await bw(UC, "mark_submission_ready", { allocationId: EY.al }), 403, "MODULE_NOT_ENABLED"));
check("X02 permissions: view / manageExpenses cannot mark ready or sent; Election Day manager permissions grant nothing",
  is(await bw(U.view, "mark_submission_ready", { allocationId: B2.al }), 403, "FORBIDDEN") &&
  is(await bw(U.exp, "mark_submission_ready", { allocationId: B2.al }), 403, "FORBIDDEN") &&
  is(await bw(U.exp, "mark_submission_sent", { allocationId: B2.al }), 403, "FORBIDDEN") &&
  is(await bw(U.mgr, "get_expense", { expenseId: EX }), 403, "FORBIDDEN"));
check("X03 manageFunderSubmissions cannot record / reverse payments or change allocations",
  is(await pay(EY.al, 100, uuid(), U.sub), 403, "FORBIDDEN") &&
  is(await bw(U.sub, "void_payment", { paymentId: inst2.id, reason: "x" }), 403, "FORBIDDEN") &&
  is(await bw(U.sub, "set_allocation", { expenseId: EY.id, sourceId: SP, amount: 1 }), 403, "FORBIDDEN"));
const pay1 = (await get(EX)).payments[0].id;
check("X04 cross-workspace IDOR: every party op on workspace A's objects from workspace B -> 404",
  is(await bw(UB, "get_expense", { expenseId: EX }), 404, "NOT_FOUND") &&
  is(await bw(UB, "mark_submission_ready", { allocationId: B2.al }), 404, "NOT_FOUND") &&
  is(await bw(UB, "mark_submission_sent", { allocationId: B2.al }), 404, "NOT_FOUND") &&
  is(await bw(UB, "mark_submission_returned", { allocationId: EY.al, note: "x" }), 404, "NOT_FOUND") &&
  is(await bw(UB, "record_preapproval", { allocationId: B2.al, approvalCode: "A", approverName: "B", approvalDate: "2026-09-01" }), 404, "NOT_FOUND") &&
  is(await bw(UB, "record_payment_reference", { allocationId: EY.al, referenceNumber: "R", authorizedAmount: 1, receivedDate: "2026-09-01" }), 404, "NOT_FOUND") &&
  is(await pay(EY.al, 1, uuid(), UB), 404, "NOT_FOUND") &&
  is(await bw(UB, "void_payment", { paymentId: pay1, reason: "x" }), 404, "NOT_FOUND") &&
  is(await bw(UB, "set_allocation", { expenseId: EY.id, sourceId: SP, amount: 1 }), 404, "NOT_FOUND"));
check("X05 cross-workspace supplier: workspace B cannot attach or read workspace A's supplier",
  !ok(await bw(UB, "create_expense", { description: "x", supplierId: SUP })) &&
  is(await bw(UB, "get_supplier_file", { supplierId: SUP }), 404, "NOT_FOUND"));
check("X06 client workspace spoofing: a workspaceId argument is ignored; a workspaceId body key is refused",
  is(await bw(UB, "mark_submission_ready", { allocationId: B2.al, workspaceId: WA }), 404, "NOT_FOUND") &&
  is(await bw(UB, "", undefined, { body: { op: "mark_submission_ready", args: { allocationId: B2.al }, workspaceId: WA } }), 400, "INVALID_REQUEST"));
check("X07 principal spoofing: '?principal=owner' with a worker cookie and no Owner token -> 401",
  is(await bw(U.full, "mark_submission_ready", { allocationId: B2.al }, { url: "/api/budget/actions?principal=owner" }), 401, "UNAUTHORIZED"));
check("X08 direct internal-op attempts from a client -> 400", is(await bw(U.full, "order_form_record", { expenseId: EX }), 400, "INVALID_REQUEST") &&
  is(await bw(U.full, "order_form_data", { expenseId: EX }), 400, "INVALID_REQUEST") &&
  is(await bw(U.full, "document_upload_finalize", { uploadId: uuid() }), 400, "INVALID_REQUEST"));
check("X09 no cookie -> 401", is(await bw("", "mark_submission_ready", { allocationId: B2.al }), 401, "UNAUTHORIZED"));
const an = anon();
const direct1 = await an.rpc("budget_op_mark_submission_ready", { p_ws: WA, p_actor: {}, p_args: { allocationId: B2.al } });
const direct2 = await an.rpc("budget_dispatch_worker", { p_session_hash: "\\x00", p_op: "mark_submission_ready", p_args: {} });
const direct3 = await an.rpc("budget_party_facts", { p_ws: WA });
check("X10 the anon key cannot call any Stage 5 function directly", Boolean(direct1.error && direct2.error && direct3.error),
  `${direct1.error?.code} ${direct2.error?.code} ${direct3.error?.code}`);
const grants = q1(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and (has_function_privilege('service_role', p.oid, 'execute')
  or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
// Stage 7A added exactly the two Storage cleanup functions (service_role).
check("X11 still ONLY the two dispatchers + the worker step-up mint (+ the Stage 7A Storage cleanup pair) are executable (service_role)",
  grants === "budget_dispatch_owner,budget_dispatch_worker,budget_stepup_mint_worker,budget_storage_cleanup_record,budget_storage_orphans", grants);
const priv = q1(`select bool_or(has_table_privilege(r, 'public.' || t, 'select') or has_table_privilege(r, 'public.' || t, 'insert')
  or has_table_privilege(r, 'public.' || t, 'update') or has_table_privilege(r, 'public.' || t, 'delete'))
  from unnest(array['anon','authenticated','service_role']) r,
  (select tablename t from pg_tables where schemaname = 'public' and tablename like 'budget\\_party%') x;`);
check("X12 no table privilege on any party table", priv === "f", priv);
q1(`delete from public.election_workspace_modules where workspace_id = '${WA}' and module_key = 'budget';`);
const noEnt = await bw(U.full, "mark_submission_ready", { allocationId: B2.al });
q1(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}', 'budget');`);
check("X13 entitlement removed -> party ops refused (and restored after)", is(noEnt, 403, "MODULE_NOT_ENABLED") && ok(await ready(B2.al)));
r = await bo(OWNER, "mark_submission_sent", { allocationId: B2.al, idempotencyKey: uuid() });
check("X14 the Owner holds every Budget permission (sends B2)", ok(r) && wf(r.data, B2.al).workflowState === "sent", d(r));

// ---------------------------------------------------------------------------
section("AUDIT (append-only, actor + before/after)");
const ae = (entity, extra = "") => q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_type = '${entity}' ${extra};`);
check("AU01 every ready / sent / returned event is audited with its actor", Number(ae("budget_party_submission_events",
  `and after_data ->> 'allocation_id' = '${xA}' and actor_name = 'u-sub'`)) === 5);
const stateAudit = q1(`select string_agg((before_data ->> 'state') || '>' || (after_data ->> 'state'), ',' order by id) from public.budget_audit_events
  where workspace_id = '${WA}' and entity_type = 'budget_party_submissions' and entity_id = '${xA}' and action = 'update'
  and before_data ->> 'state' is distinct from after_data ->> 'state';`);
check("AU02 submission state changes audited with before/after (not_sent>ready>sent>returned>ready>sent)",
  stateAudit === "not_sent>ready,ready>sent,sent>returned,returned>ready,ready>sent", stateAudit);
check("AU03 payment reference insert + correction audited", auditCount("budget_party_payment_references", xA, "insert") === "1" &&
  auditCount("budget_party_payment_references", xA, "update") === "1");
const voidAudit = q1(`select (before_data ->> 'voided_at' is null)::text || '|' || (after_data ->> 'void_reason') from public.budget_audit_events
  where workspace_id = '${WA}' and entity_type = 'budget_supplier_payments' and entity_id = '${inst2.id}' and action = 'update';`);
check("AU04 the reversal is audited (before: valid, after: voided with the reason)", voidAudit === "true|נרשם בטעות", voidAudit);
const allocAudit = q1(`select string_agg((before_data ->> 'amount_agorot') || '>' || (after_data ->> 'amount_agorot'), ',' order by id)
  from public.budget_audit_events where workspace_id = '${WA}' and entity_type = 'budget_expense_allocations' and entity_id = '${efA}' and action = 'update';`);
check("AU05 funding allocation changes audited with before/after amounts", allocAudit === "1000000>599999,599999>600000", allocAudit);
const preAmtAudit = q1(`select count(*) from public.budget_audit_events where workspace_id = '${WA}' and entity_type = 'budget_party_preapprovals'
  and entity_id = '${B1.al}' and action = 'update' and before_data ->> 'preapproved_amount_agorot' = '149999' and after_data ->> 'preapproved_amount_agorot' = '149998';`);
check("AU06 a pre-approved amount change audited", preAmtAudit === "1", preAmtAudit);
err = "";
try { q1(`delete from public.budget_audit_events where workspace_id = '${WA}';`); } catch (e) { err = String(e.stderr); }
check("AU07 audit is append-only", err.includes("BUDGET_APPEND_ONLY"));
const hist = (await bw(U.view, "list_history", { entityType: "expense", entityId: EX })).data;
check("AU08 the expense history includes the party rows (approval, submission, events, reference, payments)",
  ["budget_party_preapprovals", "budget_party_submissions", "budget_party_submission_events", "budget_party_payment_references", "budget_supplier_payments"]
    .every((t) => hist.some((h) => h.entityType === t)));

// ---------------------------------------------------------------------------
section("CALCULATION LAYER (one server-side definition)");
x = await get(EY.id);
const fact = q1(`select workflow_state || '|' || payment_status || '|' || paid || '|' || remaining || '|' || amount
  from public.budget_party_facts('${WA}') where allocation_id = '${EY.al}';`);
const w = wf(x, EY.al);
check("CA01 budget_party_facts (the Stage 6 source) equals what the expense view shows",
  fact === `${w.workflowState}|${w.paymentStatus}|${w.paid}|${w.remaining}|${w.amount}`, `${fact} vs ${JSON.stringify(w)}`);
const f = x.funding;
check("CA02 funding summary reconciles: allocated = party + donation + personal; uncovered = total - allocated = facts.unfunded",
  f.allocated === f.party + f.donation + f.personal && f.uncovered === f.total - f.allocated && f.uncovered === x.facts.unfunded);
x = await get(EF);
check("CA03 the Stage 3 expense facts agree (preapprovalExceeded = 0 once the allocation is within the cap)", x.facts.preapprovalExceeded === 0 &&
  !wf(x, efA).exceedsPreapproval);

// ---------------------------------------------------------------------------
section("CLEANUP");
q1(`update public.platform_modules set available = false where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check("Z01 budget.available restored to false on the scratch stack", q1(`select available from public.platform_modules where key = 'budget';`) === "f");

process.exit(tally("BUDGET STAGE 5 PARTY") ? 1 : 0);
