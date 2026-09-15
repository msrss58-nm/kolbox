// Budget Stage 6 - REAL-LOCAL suite for the dashboard, the reports and the
// controls: KPI semantics, queues, attention alerts, charts, recent
// expenses, seven reports, filters, pagination, the Budget-only workspace,
// authorization / isolation, performance - and the CONSISTENCY GATE: one
// deterministic mixed-finance fixture where dashboard totals = report totals
// = drill-down totals = expense facts.
//
// Real Postgres + real GoTrue + real Storage (the isolated kolboxs5 scratch
// stack started with S5_STORAGE=1), the REAL bundled handlers, real
// PermissionUser sessions and a real Election Owner. Synthetic data only.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/api-budget-reports.mjs
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
const PFX = `S6R-${RUN}`;
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const code = () => Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const DOMAIN = `budget-s6-${RUN}.invalid`;
const CODES = { A: code(), B: code(), C: code() };
const PW = "S6-Reports-Pw-9!";
const uuid = () => crypto.randomUUID();
const q1 = (sql) => psql(sql);
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const isoDay = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

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
const pad = (head, n) => Buffer.concat([head, crypto.randomBytes(Math.max(0, n - head.length))]);
const PDF = () => pad(Buffer.from("%PDF-1.7\n%synthetic\n"), 2048);
async function upload(cookie, target, bytes = PDF(), { mime = "application/pdf", name = "document.pdf" } = {}) {
  const start = await bw(cookie, "document_upload_start", { ...target, fileName: name, mimeType: mime, sizeBytes: bytes.length });
  if (!ok(start)) return { start };
  const res = await fetch(start.data.uploadUrl, { method: "PUT", headers: { "content-type": mime, "x-upsert": "false" }, body: bytes });
  if (!res.ok) return { start, put: res.status };
  return { start, complete: await bw(cookie, "document_upload_complete", { uploadId: start.data.uploadId }) };
}

// ---------------------------------------------------------------------------
section("SETUP (scratch stack only)");
q1(`update public.platform_modules set available = true where key = 'budget';`);
check("S00 storage bucket present (stack started with S5_STORAGE=1)", q1(`select count(*) from storage.buckets where id = 'budget-documents';`) === "1");
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];
const ws = (label, c) => q1(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} ${label}', now() + interval '10 days', '${c}') returning id;`);
const WA = ws("A", CODES.A);
const WB = ws("B budget-only", CODES.B);
const WC = ws("C no budget", CODES.C);
q1(`insert into public.election_workspace_modules (workspace_id, module_key)
  values ('${WA}','election_day'),('${WA}','budget'),('${WB}','budget'),('${WC}','election_day');`);
const role = (w, name, perms) => q1(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${w}', false) returning id;`);
const user = (w, name, r) => q1(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${w}') returning id;`);
const ROLES = { full: ALL, view: ["budget.view"], rep: ["budget.view", "budget.viewReports"] };
for (const [k, perms] of Object.entries(ROLES)) user(WA, `u-${k}`, role(WA, k, perms));
user(WB, "u-bfull", role(WB, "b full", ALL));
user(WC, "u-cfull", role(WC, "c full", ALL));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
q1(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner S6', '${ownerEmail}');`);
const OWNER = (await signIn(ownerEmail, PW)).token;
const U = {};
for (const k of Object.keys(ROLES)) U[k] = await login(CODES.A, `u-${k}`);
const UB = await login(CODES.B, "u-bfull");
const UC = await login(CODES.C, "u-cfull");
check("S01 fixtures + sessions (A: Election Day + Budget, B: Budget only, C: no Budget)", Object.values(U).every(Boolean) && Boolean(UB && UC && OWNER));

// ---------------------------------------------------------------------------
section("BUDGET-ONLY WORKSPACE: zero state");
const z = await bw(UB, "get_dashboard");
const zk = z.data?.kpis ?? {};
check("B01 Budget-only workspace (no Election Day entitlement) opens the dashboard", ok(z), d(z));
check("B02 zero state: every KPI is the number 0 (never null)", ["totalBudget", "partyBudget", "donationBudget", "personalBudget",
  "totalExpenses", "committed", "actual", "available"].every((k) => zk[k] === 0), JSON.stringify(zk));
check("B03 zero state: no queue item, no alert, no recent expense, empty charts, counts 0",
  Object.values(z.data.queues).every((v) => v === 0) && z.data.alerts.length === 0 && z.data.recent.length === 0 &&
  z.data.charts.bySource.length === 0 && z.data.charts.byCategory.length === 0 && z.data.charts.overTime.length === 0 &&
  z.data.counts.sources === 0 && z.data.counts.expenses === 0);
const zr = await Promise.all(["report_expenses", "report_categories", "report_sources", "report_suppliers", "report_party", "report_plan", "report_payments"]
  .map((op) => bw(UB, op, {})));
check("B04 every report answers an empty workspace with empty rows and zero totals", zr.every(ok) &&
  zr.every((r) => Array.isArray(r.data.rows) && r.data.rows.length === 0), zr.map(d).join(","));

// ---------------------------------------------------------------------------
section("MIXED-FINANCE FIXTURE (workspace A)");
const cat = async (name) => (await bw(U.full, "create_category", { name: `${PFX} ${name}` })).data.id;
const C1 = await cat("שילוט");
const C2 = await cat("אירועים");
const C3 = await cat("ללא תכנון");
const C4 = await cat("דיגיטל");
const src = async (name, kind, amount) => (await bw(U.full, "create_source", { name: `${PFX} ${name}`, kind, originalAmount: amount })).data.id;
const SP = await src("מפלגה", "party", 10000000);
const SD = await src("תרומות", "donation", 5000000);
const SPE = await src("עצמי", "personal", 2000000);
for (const [c, p] of [[C1, 3000000], [C2, 1000000], [C4, 500000]]) await bw(U.full, "set_category_plan", { categoryId: c, originalPlan: p });
const SUP = (await bw(U.full, "create_supplier", { businessName: `${PFX} דפוס הצפון`, taxId: "515000111" })).data.id;
const SUP2 = (await bw(U.full, "create_supplier", { businessName: `${PFX} סטודיו מדיה` })).data.id;
const SUP3 = (await bw(U.full, "create_supplier", { businessName: `${PFX} ספק לא פעיל` })).data.id;
await bw(U.full, "update_supplier", { supplierId: SUP3, isActive: false });
const settings = (await bw(U.view, "get_settings")).data;
const TYPE = Object.fromEntries(settings.documentTypes.map((t) => [t.key, t.id]));
await upload(U.full, { purpose: "supplier", supplierId: SUP, documentTypeId: TYPE.bank_confirmation, validUntil: "2099-12-31" });
await upload(U.full, { purpose: "supplier", supplierId: SUP2, documentTypeId: TYPE.bank_confirmation, validUntil: isoDay(10) });
q1(`select set_config('kolbox.budget_actor', '{"type":"worker","id":"${uuid()}","name":"fixture","workspace_id":"${WA}"}', false);
  insert into public.budget_supplier_bank_details (workspace_id, supplier_id, bank_code, branch_code, account_number, account_holder)
  values ('${WA}', '${SUP}', '12', '345', '987654321', 'Holder');`);

const get = async (id) => (await bw(U.view, "get_expense", { expenseId: id })).data;
const allocOf = (e, source) => e.allocations.find((x) => x.sourceId === source)?.id;
async function transition(expenseId, toStatus) {
  const e = await get(expenseId);
  return bw(U.full, "transition_expense", { expenseId, expectedVersion: e.version, toStatus });
}
const pay = (allocationId, amount) => bw(U.full, "record_payment", { allocationId, amount, paymentDate: "2026-09-13",
  confirmationSource: "funder_notice", idempotencyKey: uuid() });
const docs = {
  form: async (id) => (await bw(U.full, "order_form_generate", { expenseId: id })).data.orderForm.versions[0].id,
  sign: (formVersionId) => upload(U.full, { purpose: "order_form_return", orderFormVersionId: formVersionId }),
  add: (id, key) => upload(U.full, { purpose: "expense", expenseId: id, documentTypeId: TYPE[key] }),
};
/** The fixture. Every expected figure below is computed from THIS table. */
const FIX = [
  { k: "X1", total: 200000, cat: C1, allocs: [[SP, 200000]], status: "committed", flow: "partialPaid" },
  { k: "X2", total: 1000000, cat: C1, allocs: [[SP, 600000], [SPE, 400000]], status: "committed", flow: "ready" },
  { k: "X3", total: 500000, cat: C2, allocs: [[SD, 300000]], status: "committed", flow: "gap" },
  { k: "X4", total: 100000, cat: C2, allocs: [[SP, 100000]], status: "committed", flow: "missingDocs" },
  { k: "X5", total: 300000, cat: C3, allocs: [[SP, 300000]], status: "committed", flow: "waitingForm" },
  { k: "X6", total: 150000, cat: C1, allocs: [[SP, 150000]], status: "committed", flow: "noPreapproval" },
  { k: "X7", total: 800000, cat: C2, allocs: [[SD, 800000]], status: "incurred", flow: "paidInFull", date: "2026-08-05" },
  { k: "X8", total: 70000, cat: C1, allocs: [[SPE, 70000]], status: "draft", flow: "draft" },
  { k: "X9", total: 50000, cat: C1, allocs: [], status: "cancelled", flow: "cancelled" },
  { k: "X10", total: 100000, cat: C1, allocs: [[SP, 100000]], status: "committed", flow: "authorizedUnpaid" },
  { k: "X11", total: 100000, cat: C1, allocs: [[SP, 100000]], status: "committed", flow: "sent" },
  { k: "X12", total: 460000, cat: C4, allocs: [[SPE, 460000]], status: "committed", flow: "warning", sup: SUP2 },
];
const X = {};
for (const f of FIX) {
  const e = (await bw(U.full, "create_expense", { description: `${PFX} ${f.k}`, supplierId: f.sup ?? SUP, categoryId: f.cat,
    total: f.total, expenseDate: f.date ?? "2026-09-10" })).data;
  X[f.k] = e.id;
  for (const [s, amount] of f.allocs) await bw(U.full, "set_allocation", { expenseId: e.id, sourceId: s, amount });
}
const P = {};
for (const f of FIX) {
  const id = X[f.k];
  if (f.status === "cancelled") { await transition(id, "cancelled"); continue; }
  if (f.status === "draft") continue;
  await transition(id, f.status);
  const party = allocOf(await get(id), SP);
  P[f.k] = party;
  if (party && f.flow !== "noPreapproval") {
    await bw(U.full, "record_preapproval", { allocationId: party, approvalCode: `AP-${f.k}`, approverName: "גזבר", approvalDate: "2026-09-08",
      preapprovedAmount: f.allocs.find((x) => x[0] === SP)[1] });
  }
  if (["partialPaid", "ready", "authorizedUnpaid", "sent", "missingDocs", "waitingForm"].includes(f.flow)) {
    const fv = await docs.form(id);
    if (f.flow !== "missingDocs") {
      if (f.total > 150000 && f.flow !== "waitingForm") await docs.sign(fv);
      await docs.add(id, "quotation");
      if (f.total > 150000) await docs.add(id, "invoice");
    }
  }
  if (["partialPaid", "ready", "authorizedUnpaid", "sent"].includes(f.flow)) await bw(U.full, "mark_submission_ready", { allocationId: party });
  if (["partialPaid", "authorizedUnpaid", "sent"].includes(f.flow)) await bw(U.full, "mark_submission_sent", { allocationId: party, idempotencyKey: uuid() });
  if (["partialPaid", "authorizedUnpaid"].includes(f.flow)) {
    await bw(U.full, "record_payment_reference", { allocationId: party, referenceNumber: `R-${f.k}`, authorizedAmount: f.total, receivedDate: "2026-09-12" });
  }
  if (f.flow === "partialPaid") {
    await pay(party, 80000);
    const p2 = await pay(party, 50000);
    const voidId = p2.data.payments.find((pm) => pm.amount === 50000).id;
    await bw(U.full, "void_payment", { paymentId: voidId, reason: "נרשם בטעות" });
  }
  if (f.flow === "paidInFull") await pay(allocOf(await get(id), SD), 800000);
}
const facts = {};
for (const f of FIX) facts[f.k] = await get(X[f.k]);
check("S02 fixture built: party / donations / personal, split, gap, partial + reversed payment, missing docs, ready, sent, plans",
  facts.X1.party[0].paymentStatus === "partial" && facts.X2.party[0].workflowState === "ready" && facts.X3.funding.uncovered === 200000 &&
  facts.X11.party[0].workflowState === "sent" && facts.X10.party[0].workflowState === "reference_received" &&
  facts.X1.payments.filter((p) => p.voidedAt).length === 1 && facts.X9.status === "cancelled",
  `${facts.X1.party[0]?.paymentStatus} ${facts.X2.party[0]?.workflowState} ${facts.X11.party[0]?.workflowState}`);

// Expected figures, straight from the fixture table.
const byStatus = (st) => sum(FIX.filter((f) => st.includes(f.status)).map((f) => f.total));
const EXP = {
  totalBudget: 17000000, partyBudget: 10000000, donationBudget: 5000000, personalBudget: 2000000,
  committed: byStatus(["committed"]), actual: byStatus(["incurred", "closed"]),
};
EXP.totalExpenses = EXP.committed + EXP.actual;
EXP.available = EXP.totalBudget - EXP.totalExpenses;
EXP.paid = 80000 + 800000;
EXP.unfunded = 200000;

// ---------------------------------------------------------------------------
section("DASHBOARD KPIs (authoritative, workspace-scoped)");
const D = (await bw(U.view, "get_dashboard")).data;
const K = D.kpis;
check("K01 total budget = sum of the ACTIVE sources (17,000 ILS)", K.totalBudget === EXP.totalBudget, String(K.totalBudget));
check("K02 party / donations / personal budgets per source kind", K.partyBudget === EXP.partyBudget &&
  K.donationBudget === EXP.donationBudget && K.personalBudget === EXP.personalBudget);
check("K03 committed = totals of committed expenses (draft + cancelled excluded)", K.committed === EXP.committed, `${K.committed} vs ${EXP.committed}`);
check("K04 actual = totals of incurred / closed expenses", K.actual === EXP.actual, `${K.actual}`);
check("K05 total expenses = committed + actual (the commitments subline is committed)", K.totalExpenses === EXP.totalExpenses);
check("K06 available = total budget - committed - actual", K.available === EXP.available, `${K.available} vs ${EXP.available}`);
check("K07 paid to suppliers excludes the reversed payment", K.paid === EXP.paid, String(K.paid));
check("K08 unfunded gap is the committed / incurred uncovered balance", K.unfundedTotal === EXP.unfunded);
check("K09 the dashboard needs only budget.view", ok(await bw(U.view, "get_dashboard")));

section("QUEUES (count = drill-down list)");
const EQ = { awaiting_preapproval: 1, missing_documents: 2, waiting_supplier_form: 1, ready_to_submit: 1, sent_waiting_reference: 1,
  authorized_not_fully_paid: 2, authorized_unpaid: 1, authorized_partial: 1, unfunded: 1 };
for (const [q, n] of Object.entries(EQ)) {
  const list = (await bw(U.view, "list_expenses", { queue: q })).data;
  check(`Q-${q}: dashboard ${D.queues[q]} = expected ${n} = list ${list.total}`, D.queues[q] === n && list.total === n,
    `${D.queues[q]} / ${list.total}`);
}
check("Q10 the authorized-not-fully-paid queue is exactly unpaid + partial", D.queues.authorized_not_fully_paid ===
  D.queues.authorized_unpaid + D.queues.authorized_partial);
const unpaidList = (await bw(U.view, "list_expenses", { queue: "unpaid" })).data.total;
check("Q11 the Stage 3 'unpaid' queue is unchanged (every committed / incurred expense with an outstanding amount)",
  unpaidList === FIX.filter((f) => f.status === "committed").length, String(unpaidList));
check("Q12 overruns: 2 categories (one of them with a zero plan), 0 sources, the total budget is not exceeded",
  D.overruns.categories === 2 && D.overruns.sources === 0 && D.overruns.total === false);
const planOver = (await bw(U.rep, "report_plan", { attention: "overrun" })).data.rows;
check("Q13 overrun count = the plan report's overrun rows", planOver.length === D.overruns.categories &&
  planOver.every((r) => [C2, C3].includes(r.categoryId)));

section("ATTENTION ALERTS (only what is counted, each with its drill-down)");
const alert = (k) => D.alerts.find((x) => x.key === k);
check("A01 alerts: category overrun 2, funding gap 1 (2,000 ILS), awaiting prior approval 1, category warning 1, expiring supplier document 1",
  alert("category_overrun")?.count === 2 && alert("unfunded")?.count === 1 && alert("unfunded")?.amount === EXP.unfunded &&
  alert("awaiting_preapproval")?.count === 1 && alert("category_warning")?.count === 1 && alert("supplier_docs_expiring")?.count === 1,
  JSON.stringify(D.alerts));
check("A02 nothing is stale yet (default thresholds) and the budget is not exceeded", !alert("missing_documents_overdue") &&
  !alert("no_reference_overdue") && !alert("unpaid_overdue") && !alert("supplier_form_overdue") && !alert("total_overrun"));
check("A03 alert drill-downs: warning categories / expiring-document suppliers match their reports",
  (await bw(U.rep, "report_plan", { attention: "warning" })).data.rows.length === alert("category_warning").count &&
  (await bw(U.rep, "report_suppliers", { docsExpiring: true })).data.total === alert("supplier_docs_expiring").count);
await bo(OWNER, "update_settings", { alertMissingDocsDays: 0, alertSupplierFormDays: 0, alertNoReferenceDays: 0, alertUnpaidDays: 0 });
const D0 = (await bw(U.view, "get_dashboard")).data;
const overdue = { missing_documents_overdue: 2, supplier_form_overdue: 1, no_reference_overdue: 1, unpaid_overdue: 2 };
let overdueOk = true;
for (const [q, n] of Object.entries(overdue)) {
  const l = (await bw(U.view, "list_expenses", { queue: q })).data.total;
  if (D0.queues[q] !== n || l !== n || D0.alerts.find((x) => x.key === q)?.count !== n) overdueOk = false;
}
check("A04 time-aware alerts follow the workspace thresholds (0 days -> overdue; counts = alert = list)", overdueOk, JSON.stringify(D0.queues));
await bo(OWNER, "update_settings", { alertMissingDocsDays: 7, alertSupplierFormDays: 7, alertNoReferenceDays: 14, alertUnpaidDays: 14 });

section("CHARTS / RECENT (one aggregation source)");
const CAT = (await bw(U.rep, "report_categories", {})).data;
const catRow = (id) => CAT.rows.find((r) => r.categoryId === id);
check("C01 chart by category = the category report (committed / actual per category)", D.charts.byCategory.every((ch) =>
  catRow(ch.id)?.committed === ch.committed && catRow(ch.id)?.actual === ch.actual));
const SRC = (await bw(U.rep, "report_sources", {})).data;
check("C02 chart by source = the funding-source report", D.charts.bySource.length === SRC.rows.length && D.charts.bySource.every((ch) => {
  const r = SRC.rows.find((x) => x.sourceId === ch.id);
  return r && r.committed === ch.committed && r.actual === ch.actual && r.currentAmount === ch.budget;
}));
check("C03 expenses over time: two months, and the months add up to total expenses", D.charts.overTime.length === 2 &&
  sum(D.charts.overTime.map((m) => m.committed + m.actual)) === K.totalExpenses, JSON.stringify(D.charts.overTime));
await bo(OWNER, "update_settings", { periodStart: "2026-09-01", periodEnd: "2026-12-31" });
const Dp = (await bw(U.view, "get_dashboard")).data;
check("C04 the budget period bounds the time series (August left out) - the KPIs stay whole-budget figures",
  Dp.charts.overTime.length === 1 && Dp.charts.overTime[0].month === "2026-09" && Dp.kpis.totalExpenses === K.totalExpenses &&
  Dp.period.start === "2026-09-01");
await bo(OWNER, "update_settings", { periodStart: null, periodEnd: null });
check("C05 recent expenses: bounded (8), newest first, cancelled excluded, with category / supplier / party state",
  D.recent.length === 8 && D.recent[0].id === X.X12 && !D.recent.some((r) => r.id === X.X9) &&
  D.recent.every((r) => r.categoryName && r.supplierName) && D.recent.find((r) => r.id === X.X11)?.partyState === "sent");

// ---------------------------------------------------------------------------
section("REPORTS + CONSISTENCY GATE (dashboard = reports = drill-down = expense facts)");
const allRows = async (op, args, limit) => {
  const out = [];
  let first = null;
  for (let off = 0; ; off += limit) {
    const r = (await bw(U.rep, op, { ...args, limit, offset: off })).data;
    first ??= r;
    out.push(...r.rows);
    if (off + limit >= r.total) return { rows: out, first };
  }
};
const REX = await allRows("report_expenses", {}, 5);
check("R01 expense report: every expense of the workspace (12), paged 5 + 5 + 2", REX.rows.length === FIX.length &&
  REX.first.total === FIX.length && new Set(REX.rows.map((r) => r.id)).size === FIX.length);
const T = REX.first.totals;
check("R02 expense report totals = dashboard KPIs (committed / actual / paid)", T.committed === K.committed && T.actual === K.actual &&
  T.paid === K.paid, JSON.stringify(T));
check("R03 ... = the sum of its detail rows (amount / allocated / paid / outstanding)",
  T.amount === sum(REX.rows.map((r) => r.total)) && T.allocated === sum(REX.rows.map((r) => r.allocated)) &&
  T.paid === sum(REX.rows.map((r) => r.paid)) && T.outstanding === sum(REX.rows.map((r) => r.outstanding)));
check("R04 ... every row = that expense's own facts (get_expense)", REX.rows.every((r) => {
  const f = Object.values(facts).find((e) => e.id === r.id);
  return f && r.total === f.total && r.allocated === f.facts.allocated && r.paid === f.facts.paid &&
    r.outstanding === f.facts.outstanding && r.unfunded === f.facts.unfunded && r.paymentStatus === f.facts.paymentStatus;
}));
check("R05 unfunded total over committed / incurred = the dashboard's funding gap",
  (await bw(U.rep, "report_expenses", { statusGroup: "live" })).data.totals.unfunded === K.unfundedTotal);
const listOblig = (await bw(U.view, "list_expenses", { statusGroup: "obligations" })).data;
const listCommitted = (await bw(U.view, "list_expenses", { status: "committed" })).data;
check("R06 KPI drill-downs: 'total expenses' and 'commitments' lists sum to the KPIs",
  listOblig.totalAmount === K.totalExpenses && listCommitted.totalAmount === K.committed);
check("R07 category report: committed / actual totals = KPIs; C2 = 600,000 + 800,000 agorot; the draft is separate",
  CAT.totals.committed === K.committed && CAT.totals.actual === K.actual && catRow(C2).committed === 600000 &&
  catRow(C2).actual === 800000 && catRow(C1).draft === 70000);
const PLAN = (await bw(U.rep, "report_plan", {})).data;
const planRow = (id) => PLAN.rows.find((r) => r.categoryId === id);
check("R08 plan vs actual: C1 ok 51% (floor), C2 overrun, C3 overrun with NO percentage (zero plan), C4 warning 92%",
  planRow(C1).state === "ok" && planRow(C1).pctUsed === 51 && planRow(C2).state === "overrun" && planRow(C3).state === "overrun" &&
  planRow(C3).pctUsed === null && planRow(C4).state === "warning" && planRow(C4).pctUsed === 92, JSON.stringify(PLAN.rows.map((r) => [r.state, r.pctUsed])));
check("R09 plan report: remaining = plan - committed - actual, variance = used - plan, budget strip = KPIs",
  PLAN.rows.every((r) => r.remaining === r.plan - r.committed - r.actual && r.variance === r.used - r.plan) &&
  PLAN.budget.available === K.available && PLAN.totals.used === K.totalExpenses);
check("R10 funding-source report: sources + the uncovered gap reconcile to total expenses (no split-funding double count)",
  sum(SRC.rows.map((r) => r.committed + r.actual)) + EXP.unfunded === K.totalExpenses &&
  SRC.rows.find((r) => r.sourceId === SPE).committed === 860000);
const PAYR = await allRows("report_payments", {}, 2);
check("R11 payment report: 3 rows (reversal kept), active 880,000 = KPI paid, reversed 50,000 excluded",
  PAYR.rows.length === 3 && PAYR.first.totals.activeAmount === K.paid && PAYR.first.totals.voidedAmount === 50000 &&
  PAYR.rows.some((p) => p.state === "voided" && p.voidReason === "נרשם בטעות"));
check("R12 payment report: sources pay the same total; party remaining shown for a party payment",
  sum(SRC.rows.map((r) => r.paid)) === K.paid && PAYR.rows.find((p) => p.state === "active" && p.payer === "party")?.partyRemaining === 120000);
const SUPR = await allRows("report_suppliers", {}, 1);
check("R13 supplier report: 3 suppliers (incl. the inactive one), amounts reconcile to total expenses and party outstanding",
  SUPR.rows.length === 3 && SUPR.first.totals.amount === K.totalExpenses && SUPR.first.totals.partyOutstanding === K.partyOutstanding &&
  SUPR.rows.find((r) => r.supplierId === SUP3).isActive === false);
const supJson = JSON.stringify(SUPR.rows) + JSON.stringify(D);
check("R14 supplier report / dashboard carry no bank-account data (only 'on file'); the expiring confirmation is flagged",
  !supJson.includes("987654321") && !/account_?number/i.test(supJson) && SUPR.rows.find((r) => r.supplierId === SUP).bankOnFile === true &&
  SUPR.rows.find((r) => r.supplierId === SUP2).docsExpiring === true);
const PAR = await allRows("report_party", {}, 3);
check("R15 party report: one row per party allocation (7), amounts = the Stage 5 facts of each expense",
  PAR.rows.length === 7 && PAR.rows.every((r) => {
    const w = Object.values(facts).find((e) => e.id === r.expenseId)?.party.find((x) => x.allocationId === r.allocationId);
    return w && w.amount === r.amount && w.paid === r.paid && w.remaining === r.remaining && w.workflowState === r.workflowState &&
      w.paymentStatus === r.paymentStatus && w.attempts === r.attempts;
  }));
const partyFactsSum = q1(`select coalesce(sum(amount), 0) || '|' || coalesce(sum(paid), 0) from public.budget_party_facts('${WA}');`);
check("R16 party totals = budget_party_facts (the Stage 6 source)", `${PAR.first.totals.amount}|${PAR.first.totals.paid}` === partyFactsSum, partyFactsSum);

section("FILTERS (server-validated)");
const count = async (op, args) => (await bw(U.rep, op, args)).data.total;
check("F01 date range", await count("report_expenses", { from: "2026-08-01", to: "2026-08-31" }) === 1);
check("F02 category", await count("report_expenses", { categoryId: C2 }) === 3);
check("F03 funding source (split funding counted once per expense)", await count("report_expenses", { sourceId: SPE }) === 3);
check("F04 supplier", await count("report_expenses", { supplierId: SUP2 }) === 1);
check("F05 expense status", await count("report_expenses", { status: "committed" }) === FIX.filter((f) => f.status === "committed").length);
check("F06 party workflow state", await count("report_expenses", { workflowState: "ready" }) === 1 &&
  await count("report_party", { workflowState: "collecting_documents" }) === 2 && await count("report_party", { workflowState: "reference_received" }) === 2);
check("F07 payment status", await count("report_expenses", { paymentStatus: "partial" }) === 1 &&
  await count("report_party", { paymentStatus: "partial" }) === 1);
check("F08 document readiness (non-cancelled expenses: 3 missing, 8 complete)", await count("report_expenses", { docReadiness: "missing" }) === 3 &&
  await count("report_expenses", { docReadiness: "ready" }) === 8 && await count("report_party", { docReadiness: "missing" }) === 3);
check("F09 payment filters: payer / state", await count("report_payments", { payer: "campaign" }) === 1 &&
  await count("report_payments", { state: "voided" }) === 1);
check("F10 source kind / supplier activity", (await bw(U.rep, "report_sources", { kind: "party" })).data.rows.length === 1 &&
  (await bw(U.rep, "report_sources", { kind: "party" })).data.totals.currentAmount === K.partyBudget &&
  await count("report_suppliers", { active: "inactive" }) === 1);
check("F11 invalid values -> 400 (status / queue / workflow / payer / kind / attention / date order)",
  is(await bw(U.rep, "report_expenses", { status: "bogus" }), 400, "INVALID_INPUT") &&
  is(await bw(U.view, "list_expenses", { queue: "bogus" }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_party", { workflowState: "bogus" }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_payments", { payer: "bogus" }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_sources", { kind: "bogus" }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_sources", { attention: "warning" }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_expenses", { from: "2026-09-10", to: "2026-09-01" }), 400, "INVALID_INPUT"));

section("PAGINATION (bounded, deterministic)");
check("G01 limits are bounded: 0 / 201 / negative offset -> 400", is(await bw(U.rep, "report_expenses", { limit: 0 }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_expenses", { limit: 201 }), 400, "INVALID_INPUT") &&
  is(await bw(U.rep, "report_payments", { offset: -1 }), 400, "INVALID_INPUT"));
const again = await allRows("report_expenses", {}, 5);
check("G02 stable order: the same pages twice give the same sequence", JSON.stringify(again.rows.map((r) => r.id)) === JSON.stringify(REX.rows.map((r) => r.id)));
check("G03 page boundaries: no duplicate and no missing row across pages (expenses 5, suppliers 1, party 3, payments 2)",
  new Set(REX.rows.map((r) => r.id)).size === REX.first.total && new Set(SUPR.rows.map((r) => r.supplierId)).size === SUPR.first.total &&
  new Set(PAR.rows.map((r) => r.allocationId)).size === PAR.first.total && new Set(PAYR.rows.map((r) => r.paymentId)).size === PAYR.first.total);
check("G04 totals are over the whole filtered set on every page", (await bw(U.rep, "report_expenses", { limit: 5, offset: 10 })).data.totals.amount === T.amount);

// ---------------------------------------------------------------------------
section("PERMISSIONS / ISOLATION / SECURITY");
const REPORT_OPS = ["report_expenses", "report_categories", "report_sources", "report_suppliers", "report_party", "report_plan", "report_payments"];
const viewRes = await Promise.all(REPORT_OPS.map((op) => bw(U.view, op, {})));
check("X01 budget.view without budget.viewReports: all 7 reports -> 403", viewRes.every((r) => is(r, 403, "FORBIDDEN")), viewRes.map(d).join(","));
check("X02 budget.viewReports alone reads every report", (await Promise.all(REPORT_OPS.map((op) => bw(U.rep, op, {})))).every(ok));
check("X03 no Budget entitlement -> 403 for the dashboard and the reports", is(await bw(UC, "get_dashboard"), 403, "MODULE_NOT_ENABLED") &&
  is(await bw(UC, "report_expenses", {}), 403, "MODULE_NOT_ENABLED"));
check("X04 no session -> 401", is(await bw("", "get_dashboard"), 401, "UNAUTHORIZED") && is(await bw("", "report_payments", {}), 401, "UNAUTHORIZED"));
// Workspace B gets its own small budget (the Budget-only controls).
const bSrc = (await bw(UB, "create_source", { name: "B party", kind: "party", originalAmount: 100000 })).data?.id;
const bCat = (await bw(UB, "create_category", { name: "B cat" })).data?.id;
const bPlan = await bw(UB, "set_category_plan", { categoryId: bCat, originalPlan: 50000 });
const bSet = await bw(UB, "update_settings", { periodStart: "2026-01-01", periodEnd: "2026-12-31" });
const bSup = (await bw(UB, "create_supplier", { businessName: "B supplier" })).data?.id;
const bExp = (await bw(UB, "create_expense", { description: "B expense", supplierId: bSup, categoryId: bCat, total: 30000, expenseDate: "2026-09-01" })).data;
await bw(UB, "set_allocation", { expenseId: bExp.id, sourceId: bSrc, amount: 30000 });
await bw(UB, "transition_expense", { expenseId: bExp.id, expectedVersion: (await bw(UB, "get_expense", { expenseId: bExp.id })).data.version, toStatus: "committed" });
const DB = (await bw(UB, "get_dashboard")).data;
check("X05 Budget-only controls work (source, category plan, budget period, expense)", ok(bPlan) && ok(bSet) && DB.kpis.totalBudget === 100000 &&
  DB.kpis.committed === 30000 && DB.period.start === "2026-01-01");
check("X06 no cross-workspace aggregate leakage: B's dashboard counts only B", DB.kpis.totalExpenses === 30000 && DB.counts.expenses === 1 &&
  DB.recent.length === 1 && K.totalExpenses === EXP.totalExpenses);
const bReports = await Promise.all(REPORT_OPS.map((op) => bw(UB, op, {})));
const bJson = JSON.stringify(bReports.map((r) => r.data));
check("X07 no cross-workspace report leakage: none of A's ids / names appear in B's reports", bReports.every(ok) &&
  !Object.values(X).some((id) => bJson.includes(id)) && !bJson.includes(PFX) && !bJson.includes(SUP));
check("X08 report filters with another workspace's ids -> 404 (no enumeration)",
  is(await bw(UB, "report_expenses", { categoryId: C1 }), 404, "NOT_FOUND") && is(await bw(UB, "report_expenses", { supplierId: SUP }), 404, "NOT_FOUND") &&
  is(await bw(UB, "report_payments", { expenseId: X.X1 }), 404, "NOT_FOUND") && is(await bw(UB, "list_expenses", { sourceId: SP }), 404, "NOT_FOUND"));
check("X09 workspace spoofing: a workspaceId argument is ignored; a workspaceId body key is refused",
  (await bw(UB, "report_expenses", { workspaceId: WA })).data.total === 1 &&
  is(await bw(UB, "", undefined, { body: { op: "get_dashboard", args: {}, workspaceId: WA } }), 400, "INVALID_REQUEST"));
const an = anon();
const r1 = await an.rpc("budget_op_get_dashboard", { p_ws: WA, p_actor: {}, p_args: {} });
const r2 = await an.rpc("budget_requirement_items", { p_ws: WA, p_expense_ids: null });
const r3 = await an.rpc("budget_op_report_payments", { p_ws: WA, p_actor: {}, p_args: {} });
check("X10 no raw reporting endpoint: the anon key cannot call any Stage 6 function", Boolean(r1.error && r2.error && r3.error));
const grants = q1(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'budget\\_%' and (has_function_privilege('service_role', p.oid, 'execute')
  or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));`);
// Stage 7A added exactly the two Storage cleanup functions (service_role).
check("X11 still ONLY the two dispatchers + the worker step-up mint (+ the Stage 7A Storage cleanup pair) are executable (service_role)",
  grants === "budget_dispatch_owner,budget_dispatch_worker,budget_stepup_mint_worker,budget_storage_cleanup_record,budget_storage_orphans", grants);
check("X12 the Owner reads the dashboard and reports", ok(await bo(OWNER, "get_dashboard")) && ok(await bo(OWNER, "report_plan", {})));

// ---------------------------------------------------------------------------
section("PERFORMANCE (1,000-expense scratch workspace)");
const perfSeed = `
begin;
insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} perf', now() + interval '10 days', '${code()}') returning id as ws \\gset
insert into public.election_workspace_modules (workspace_id, module_key) values (:'ws', 'budget');
select set_config('kolbox.budget_actor', jsonb_build_object('type','worker','id',gen_random_uuid(),'name','perf','workspace_id',:'ws')::text, true);
select public.budget_ensure_initialized(:'ws');
insert into public.budget_funding_sources (workspace_id, name, kind, original_amount_agorot, sort_order) values
  (:'ws', 'party', 'party', 900000000000, 1), (:'ws', 'donations', 'donation', 50000000000, 2), (:'ws', 'personal', 'personal', 50000000000, 3);
insert into public.budget_categories (workspace_id, name, sort_order) select :'ws', 'cat ' || g, g from generate_series(1, 10) g;
insert into public.budget_category_plans (workspace_id, category_id, original_plan_agorot)
  select :'ws', c.id, 5000000000 from public.budget_categories c where c.workspace_id = :'ws';
insert into public.budget_suppliers (workspace_id, business_name) select :'ws', 'supplier ' || g from generate_series(1, 50) g;
create temp table perf_x as select g,
  (select id from public.budget_suppliers s where s.workspace_id = :'ws' order by business_name offset (g % 50) limit 1) as sup,
  (select id from public.budget_categories c where c.workspace_id = :'ws' order by sort_order offset (g % 10) limit 1) as cat,
  case when g % 10 = 0 then 'draft' when g % 10 between 1 and 5 then 'committed' when g % 10 between 6 and 8 then 'incurred' else 'cancelled' end as st
  from generate_series(1, 1000) g;
insert into public.budget_expenses (workspace_id, reference_no, description, supplier_id, category_id, total_agorot, expense_date, status, status_reason)
  select :'ws', g, 'expense ' || g, sup, cat, 100000 + g * 7, date '2026-01-01' + (g % 250), st, case when st = 'cancelled' then 'perf' end from perf_x;
insert into public.budget_expense_allocations (workspace_id, expense_id, funding_source_id, amount_agorot)
  select :'ws', e.id, (select id from public.budget_funding_sources where workspace_id = :'ws' and kind = case when e.reference_no % 2 = 1 then 'party' else 'donation' end),
    case when e.reference_no % 2 = 1 then e.total_agorot else e.total_agorot / 2 end
  from public.budget_expenses e where e.workspace_id = :'ws';
insert into public.budget_expense_allocations (workspace_id, expense_id, funding_source_id, amount_agorot)
  select :'ws', e.id, (select id from public.budget_funding_sources where workspace_id = :'ws' and kind = 'personal'), e.total_agorot / 4
  from public.budget_expenses e where e.workspace_id = :'ws' and e.reference_no % 2 = 0;
insert into public.budget_party_preapprovals (workspace_id, allocation_id, approval_code, approver_name, approval_date, preapproved_amount_agorot)
  select :'ws', a.id, 'AP', 'perf', date '2026-01-10', a.amount_agorot
  from public.budget_expense_allocations a join public.budget_expenses e on e.id = a.expense_id
  where a.workspace_id = :'ws' and e.reference_no % 2 = 1 and e.reference_no % 3 = 0;
insert into public.budget_party_submissions (workspace_id, allocation_id) select :'ws', allocation_id from public.budget_party_preapprovals where workspace_id = :'ws';
insert into public.budget_documents (workspace_id, expense_id, document_type_id)
  select :'ws', e.id, (select id from public.budget_document_types where workspace_id = :'ws' and key = 'quotation')
  from public.budget_expenses e where e.workspace_id = :'ws' and e.reference_no % 2 = 1 and e.reference_no % 5 <> 0;
insert into public.budget_document_versions (workspace_id, document_id, version_no, storage_path, file_name, mime_type, size_bytes, sha256, origin,
  created_by_type, created_by_id, created_by_name)
  select :'ws', d.id, 1, :'ws' || '/' || gen_random_uuid(), 'q.pdf', 'application/pdf', 1000, repeat('a', 64), 'upload', 'worker', gen_random_uuid(), 'perf'
  from public.budget_documents d where d.workspace_id = :'ws';
insert into public.budget_supplier_payments (workspace_id, expense_id, allocation_id, amount_agorot, payment_date, payer, confirmation_source,
  idempotency_key, recorded_by_type, recorded_by_id, recorded_by_name)
  select :'ws', e.id, a.id, a.amount_agorot / 2, e.expense_date + 5, 'campaign', 'bank_transfer', gen_random_uuid(), 'worker', gen_random_uuid(), 'perf'
  from public.budget_expenses e join public.budget_expense_allocations a on a.expense_id = e.id and a.workspace_id = e.workspace_id
  join public.budget_funding_sources s on s.id = a.funding_source_id and s.kind = 'donation'
  where e.workspace_id = :'ws' and e.status = 'incurred';
commit;
select :'ws';`;
const WP = psql(perfSeed).split("\n").pop().trim();
// Steady state: statistics exist (autovacuum analyzes a live database). Right
// after a bulk seed they do not, and plans / timings would describe a table
// the planner still believes is empty.
psql(`analyze public.budget_expenses, public.budget_expense_allocations, public.budget_documents, public.budget_document_versions,
  public.budget_supplier_payments, public.budget_party_preapprovals, public.budget_party_submissions, public.budget_suppliers,
  public.budget_categories, public.budget_category_plans, public.budget_funding_sources;`);
check("P00 1,000-expense fixture seeded (mixed statuses, split funding, gaps, party approvals, documents, payments)",
  q1(`select count(*) from public.budget_expenses where workspace_id = '${WP}';`) === "1000");
const timing = q1(`create temp table pt (k text, ms numeric);
do $$ declare ws uuid := '${WP}'; t0 timestamptz; begin
  perform public.budget_op_get_dashboard(ws, '{}', '{}');
  t0 := clock_timestamp(); perform public.budget_op_get_dashboard(ws, '{}', '{}'); insert into pg_temp.pt values ('dashboard', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_expenses(ws, '{}', '{}'); insert into pg_temp.pt values ('expenses', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_expenses(ws, '{}', '{"docReadiness":"missing"}'); insert into pg_temp.pt values ('expenses_docs', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_categories(ws, '{}', '{}'); insert into pg_temp.pt values ('categories', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_sources(ws, '{}', '{}'); insert into pg_temp.pt values ('sources', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_suppliers(ws, '{}', '{}'); insert into pg_temp.pt values ('suppliers', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_party(ws, '{}', '{"docReadiness":"missing"}'); insert into pg_temp.pt values ('party_docs', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_plan(ws, '{}', '{}'); insert into pg_temp.pt values ('plan', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_report_payments(ws, '{}', '{}'); insert into pg_temp.pt values ('payments', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp(); perform public.budget_op_list_expenses(ws, '{}', '{"queue":"missing_documents"}'); insert into pg_temp.pt values ('list_queue', extract(epoch from clock_timestamp() - t0) * 1000);
end $$;
select string_agg(k || '=' || round(ms), ' ' order by k) || '|' || max(ms) filter (where k = 'dashboard') || '|' || max(ms) filter (where k <> 'dashboard') from pt;`)
  .split("\n").pop();
const [timings, dashMs, maxReportMs] = timing.split("|");
console.log(`  [perf] warm timings on 1,000 expenses (ms): ${timings}`);
check("P01 dashboard on 1,000 expenses stays under 2.5 s (warm)", Number(dashMs) < 2500, `${Math.round(Number(dashMs))} ms`);
check("P02 every report / filtered list on 1,000 expenses stays under 2 s (warm)", Number(maxReportMs) < 2000, `${Math.round(Number(maxReportMs))} ms`);
const idx = q1(`select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public'
  and indexname in ('budget_supplier_payments_date_idx', 'budget_expenses_created_idx', 'budget_expenses_status_idx',
  'budget_expenses_category_idx', 'budget_expenses_supplier_idx', 'budget_expenses_date_idx', 'budget_supplier_payments_expense_idx');`);
check("P03 report-filter indexes present (status / category / supplier / date / payments by date / recent)", idx.split(",").length === 7, idx);
const plan1 = q1(`set enable_seqscan = off; explain select id from public.budget_supplier_payments where workspace_id = '${WP}'
  order by payment_date desc, recorded_at desc, id desc limit 50;`);
const plan2 = q1(`set enable_seqscan = off; explain select id from public.budget_expenses where workspace_id = '${WP}' and status <> 'cancelled'
  order by created_at desc, id desc limit 8;`);
// enable_seqscan=off asks the planner whether an index can serve the ordered
// LIMIT at all (on small tables it may still prefer a scan + sort).
check("P04 explain: the new indexes serve the paged payment report and the recent list as ordered LIMIT scans (no sort)",
  plan1.includes("budget_supplier_payments_date_idx") && plan1.includes("Limit") && plan2.includes("budget_expenses_created_idx"), `${plan1.split("\n")[1]} | ${plan2.split("\n")[1]}`);
const pr = (op, args) => JSON.parse(q1(`select public.budget_op_${op}('${WP}', '{}', '${JSON.stringify(args)}')::text;`));
const pd = pr("get_dashboard", {});
const pcat = pr("report_categories", {});
const pexp = pr("report_expenses", {});
const ppay = pr("report_payments", {});
check("P05 at scale the layers still agree: KPI committed/actual = category report; expense-report paid = payment report",
  pcat.totals.committed === pd.kpis.committed && pcat.totals.actual === pd.kpis.actual && pexp.totals.paid === ppay.totals.activeAmount &&
  pexp.rows.length === 50 && ppay.rows.length === 50);
check("P06 one set-based engine pass: per-expense document facts cover every non-cancelled expense",
  q1(`select count(*) from public.budget_expense_document_facts('${WP}', null);`) === "900");

// ---------------------------------------------------------------------------
section("CLEANUP");
q1(`update public.platform_modules set available = false where key = 'budget';`);
for (const u of (await a.auth.admin.listUsers({ perPage: 1000 })).data.users) {
  if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
check("Z01 budget.available restored to false on the scratch stack", q1(`select available from public.platform_modules where key = 'budget';`) === "f");

process.exit(tally("BUDGET STAGE 6 REPORTS") ? 1 : 0);
