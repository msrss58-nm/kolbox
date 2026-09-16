// Budget Stage 5 - REAL-LOCAL UI suite for the party funding workflow.
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack
// (started with S5_STORAGE=1), serves it with scripts/stage5/localServer.mjs
// (vercel.json rewrites -> the REAL bundled handlers) and drives headless
// Chromium through the four separate party panels: prior budget approval,
// submission (ready / sent / returned / resend), payment reference and the
// party's payments to the supplier - plus the funding summary, permissions and
// mobile. Synthetic *.invalid identities; nothing secret is printed.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/ui-budget-party.mjs <outDir>
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { startLocalServer } from "../stage5/localServer.mjs";
import { admin, callHandler, check, installLocalnetGuard, loadStack, psql, section, tally } from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-budget-party-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const PORT = 5197;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = BASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S5UI-${RUN}`;
const DOMAIN = `budget-party-ui-${RUN}.invalid`;
const PW = "S5-Ui-Pw-7!";
const ALPH = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE = Array.from(crypto.randomBytes(8), (b) => ALPH[b % ALPH.length]).join("");
const arr = (xs) => `array[${xs.map((x) => `'${x}'`).join(",")}]::text[]`;
const ALL = ["budget.view", "budget.manageExpenses", "budget.manageFunderSubmissions", "budget.manageSuppliers",
  "budget.managePlan", "budget.viewReports", "budget.manageSettings"];

section("BUILD the election surface against the scratch stack");
const dist = path.join(outDir, "dist-election");
execFileSync(process.execPath, [path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist,
  "--emptyOutDir", "--logLevel", "error"], {
  cwd: repoRoot,
  env: { ...process.env, VITE_APP_SURFACE: "election", VITE_SUPABASE_URL: stackEnv.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY },
  stdio: ["ignore", "ignore", "inherit"],
});
check("B1 election bundle built", fs.existsSync(path.join(dist, "index.html")));

section("SETUP (scratch stack only)");
psql(`update public.platform_modules set available = true where key = 'budget'; delete from public.election_day_login_attempts;`);
const WA = psql(`insert into public.election_workspaces (name, election_end_at, login_code)
  values ('${PFX} A', now() + interval '5 days', '${CODE}') returning id;`);
psql(`insert into public.election_workspace_modules (workspace_id, module_key) values ('${WA}','election_day'), ('${WA}','budget');`);
const role = (name, perms) => psql(`insert into public.election_day_roles (name, description, permissions, scope_type, workspace_id, is_manager)
  values ('${name}', '', ${arr(perms)}, 'all', '${WA}', false) returning id;`);
const user = (name, r) => psql(`insert into public.election_day_permission_users (name, password_hash, role_id, workspace_id)
  values ('${name}', extensions.crypt('${PW}', extensions.gen_salt('bf')), '${r}', '${WA}') returning id;`);
user("p-full", role("full", [...ALL, "voter.viewName"]));
user("p-view", role("view", ["budget.view"]));
user("p-sub", role("sub", ["budget.view", "budget.manageFunderSubmissions"]));

// Fixture data through the REAL handlers (a worker session), not SQL.
psql("delete from public.election_day_login_attempts;");
const lr = await callHandler(H.electionSession, { method: "POST", url: "/api/election-day/session", headers: { origin: BASE },
  body: { workspaceCode: CODE, name: "p-full", password: PW } });
const cookie = String(lr.headers?.["set-cookie"] ?? "").split(";")[0].split("=").slice(1).join("=");
const api = async (op, args) => (await callHandler(H.budget, { method: "POST", url: "/api/budget/actions", headers: { origin: BASE },
  body: { op, args }, cookies: { "__Host-kb_ed_session": cookie } })).body?.data;
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n%ui\n"), crypto.randomBytes(2048)]);
async function seedUpload(target, name) {
  const bytes = pdf();
  const start = await api("document_upload_start", { ...target, fileName: name, mimeType: "application/pdf", sizeBytes: bytes.length });
  await fetch(start.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: bytes });
  return api("document_upload_complete", { uploadId: start.uploadId });
}
const catId = (await api("create_category", { name: "שילוט UI" })).id;
const srcP = (await api("create_source", { name: "מפלגה UI", kind: "party", originalAmount: 50000000 })).id;
const srcD = (await api("create_source", { name: "תרומות UI", kind: "donation", originalAmount: 50000000 })).id;
const srcS = (await api("create_source", { name: "עצמי UI", kind: "personal", originalAmount: 50000000 })).id;
const supId = (await api("create_supplier", { businessName: "דפוס UI בע\"מ", phone: "050-7654321", taxId: "514000333" })).id;
const settings = await api("get_settings", {});
const TYPE = Object.fromEntries(settings.documentTypes.map((t) => [t.key, t.id]));
await api("update_settings", { branchName: "סניף UI", branchNumber: "9", defaultOrderer: "מזמין UI", funderHeaderLines: ["מפלגה UI"] });
await seedUpload({ purpose: "supplier", supplierId: supId, documentTypeId: TYPE.bank_confirmation, validUntil: "2099-12-31" }, "bank.pdf");
const mk = async (desc, total, allocs) => {
  const e = await api("create_expense", { description: desc, supplierId: supId, categoryId: catId, total, expenseDate: "2026-09-10" });
  let last = e;
  for (const [sourceId, amount] of allocs) last = await api("set_allocation", { expenseId: e.id, sourceId, amount });
  return last;
};
const EX = await mk("שלטי חוצות UI", 200000, [[srcP, 200000]]);
await api("transition_expense", { expenseId: EX.id, expectedVersion: (await api("get_expense", { expenseId: EX.id })).version, toStatus: "committed" });
const EG = await mk("הוצאה עם פער UI", 1000000, [[srcP, 600000]]);
const ES = await mk("שלושה מקורות UI", 1000000, [[srcP, 500000], [srcD, 300000], [srcS, 200000]]);
check("S1 fixtures created through the real handlers", Boolean(WA && cookie && EX?.id && EG?.id && ES?.id));

const server = await startLocalServer({
  distDir: dist, port: PORT,
  handlers: {
    "/api/health": H.health, "/api/platform/session": H.platformSession, "/api/election-day/session": H.electionSession,
    "/api/election-day/actions": H.actions, "/api/election-day/roles": H.roles, "/api/election-day/reauth": H.reauth,
    "/api/election-day/permission-users": H.permissionUsers, "/api/election-day/owner-actions": H.ownerActions,
    "/api/election-day/owner-roles": H.ownerRoles, "/api/election-day/owner-reauth": H.ownerReauth, "/api/budget/actions": H.budget,
  },
});

const browser = await chromium.launch();
const pageErrors = [];
const newPage = async (viewport = { width: 1280, height: 900 }) => {
  const ctx = await browser.newContext({ viewport, locale: "he-IL" });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  return p;
};
const shot = (p, name) => p.screenshot({ path: path.join(screens, `${name}.png`), fullPage: true });
const seen = (loc, timeout = 15000) => loc.first().waitFor({ timeout }).then(() => true, () => false);
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function workerLogin(p, name) {
  psql("delete from public.election_day_login_attempts;");
  await p.goto(`${BASE}/election-day/login?w=${CODE}`);
  await p.locator('input[name="election-day-username"]').fill(name);
  await p.locator('input[name="election-day-current-password"]').fill(PW);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }).catch(() => {});
}
async function openExpense(p, id) {
  await p.goto(`${BASE}/budget/expenses/${id}`);
  await p.getByTestId("expense-file").waitFor({ timeout: 20000 });
}
const state = (p) => p.getByTestId("party-submission").getByTestId("submission-state");
const hasState = (p, s, timeout = 15000) => seen(p.getByTestId("party-submission").locator(`[data-state="${s}"]`), timeout);
const pdfFile = (name) => ({ name, mimeType: "application/pdf", buffer: pdf() });
/** Uploads through the document dialog, from whichever trigger opens it. */
async function uploadVia(p, trigger, file) {
  await trigger.click();
  const dlg = p.getByTestId("document-upload");
  await dlg.waitFor({ timeout: 10000 });
  await dlg.getByLabel("קובץ").setInputFiles(file);
  await dlg.getByRole("button", { name: "העלאת מסמך" }).click();
  await dlg.waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
}

try {
  section("FUNDING SUMMARY (server-computed; the gap is shown, never filled)");
  const pa = await newPage();
  await workerLogin(pa, "p-full");
  await openExpense(pa, EG.id);
  const gap = pa.getByTestId("funding-uncovered");
  check("U01 a 10,000 expense with party 6,000: 'יתרה ללא מקור מימון' 4,000 + an explicit warning",
    await seen(gap.getByText("4,000")) && await seen(pa.getByTestId("funding-summary").getByRole("alert")));
  await shot(pa, "01-funding-gap");
  await openExpense(pa, ES.id);
  const fs3 = pa.getByTestId("funding-summary");
  check("U02 party / donations / personal on ONE expense, nothing uncovered",
    await seen(fs3.getByTestId("funding-party").getByText("5,000")) && await seen(fs3.getByTestId("funding-donation").getByText("3,000")) &&
    await seen(fs3.getByTestId("funding-personal").getByText("2,000")) && (await fs3.getByRole("alert").count()) === 0);

  section("PRIOR BUDGET APPROVAL");
  await openExpense(pa, EX.id);
  check("U03 four separate panels: prior approval / submission / payment reference / party payments",
    (await pa.getByTestId("party-preapproval").count()) === 1 && (await pa.getByTestId("party-submission").count()) === 1 &&
    (await pa.getByTestId("party-reference").count()) === 1 && (await pa.getByTestId("party-payments").count()) === 1);
  check("U04 initial state 'ממתין לאישור תקציבי מוקדם' with the missing approval listed",
    await hasState(pa, "awaiting_preapproval") && await seen(pa.getByTestId("party-readiness").getByText("חסר אישור תקציבי מוקדם")));
  await pa.getByTestId("record-preapproval").click();
  const dlg = pa.getByRole("dialog");
  await dlg.getByLabel("קוד אישור").fill("AP-UI");
  await dlg.getByLabel("שם המאשר").fill("מאשר UI");
  await dlg.getByLabel("תאריך אישור").fill("2026-09-08");
  await dlg.getByLabel("סכום שאושר מראש (₪)").fill("2000");
  await dlg.getByLabel("הערות").fill("אושר בטלפון");
  await dlg.getByRole("button", { name: "שמירה" }).click();
  check("U05 approval recorded from the dialog -> 'אושר תקציבית מראש', details shown in its own panel",
    await hasState(pa, "preapproved") && await seen(pa.getByTestId("party-preapproval").getByText("AP-UI")) &&
    await seen(pa.getByTestId("party-preapproval").getByText("אושר בטלפון")));
  check("U06 'מוכן להגשה' is disabled while the package is incomplete (no final form yet)",
    await pa.getByTestId("mark-ready").isDisabled() && await seen(pa.getByTestId("party-readiness").getByText("טרם הופק טופס הזמנה סופי")));

  // Regression guard: the party readiness / blockers are read from the EXPENSE,
  // while an upload only returns the DOCUMENTS view. A document mutation used
  // to leave the readiness stale until the page was reloaded. Everything below
  // happens on the SAME page - no navigation, or the bug would be masked.
  const readiness = pa.getByTestId("party-readiness");
  const urlBefore = pa.url();
  const beforeText = await readiness.innerText();
  // Prove the premise first: if the quotation is NOT listed here, the check
  // below would pass for the wrong reason, so fail loudly instead.
  check("U06a the quotation is missing AND listed in the party readiness (premise of U06b)",
    await seen(pa.getByTestId("requirement-quotation").locator('[data-state="missing"]')) && beforeText.includes("הצעת מחיר"),
    beforeText.replace(/\s+/g, " ").slice(0, 140));
  await uploadVia(pa, pa.getByTestId("requirement-quotation").getByRole("button", { name: "העלאה" }), pdfFile("הצעת מחיר UI.pdf"));
  const becamePresent = await seen(pa.getByTestId("requirement-quotation").locator('[data-state="present"]'), 20000);
  // The upload returns only the DOCUMENTS view; the expense is re-read on its
  // own round trip that finishes later. Poll for it - a single immediate read
  // is itself a race and would report a stale panel as a failure.
  let afterText = beforeText;
  for (let i = 0; i < 40 && afterText === beforeText; i++) {
    await pa.waitForTimeout(250);
    afterText = await readiness.innerText();
  }
  check("U06b a document upload refreshes the party readiness WITHOUT reloading the page",
    becamePresent && afterText !== beforeText && !afterText.includes("הצעת מחיר") && pa.url() === urlBefore,
    `present=${becamePresent} changed=${afterText !== beforeText} same-url=${pa.url() === urlBefore} :: ${afterText.replace(/\s+/g, " ").slice(0, 140)}`);
  await shot(pa, "02-preapproved");

  // The package (tested in depth by api-budget-party.mjs): final form, signed return, quotation, invoice.
  const g = await api("order_form_generate", { expenseId: EX.id });
  await seedUpload({ purpose: "order_form_return", orderFormVersionId: g.orderForm.versions[0].id }, "signed.pdf");
  await seedUpload({ purpose: "expense", expenseId: EX.id, documentTypeId: TYPE.quotation }, "quote.pdf");
  await seedUpload({ purpose: "expense", expenseId: EX.id, documentTypeId: TYPE.invoice }, "invoice.pdf");

  section("SUBMISSION (ready -> sent -> returned -> ready -> sent)");
  await openExpense(pa, EX.id);
  check("U07 complete package -> 'כל התנאים להגשה מתקיימים' and the ready action is enabled",
    await seen(pa.getByTestId("party-readiness").getByText("כל התנאים להגשה מתקיימים")) && !(await pa.getByTestId("mark-ready").isDisabled()));
  await pa.getByTestId("mark-ready").click();
  check("U08 marked 'מוכן להגשה'", await hasState(pa, "ready"));
  await pa.getByTestId("mark-sent").click();
  await pa.getByRole("dialog").getByRole("button", { name: "סימון כנשלח למממן" }).click();
  check("U09 confirmed sent -> 'נשלח למממן', attempt 1 in the history",
    await hasState(pa, "sent") && await seen(pa.getByTestId("party-attempts").getByText("(1)")));
  await pa.getByTestId("mark-returned").click();
  await pa.getByRole("dialog").getByLabel("מה נדרש לתקן").fill("חסר צילום השלט");
  await pa.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  check("U10 returned for correction -> 'הוחזר לתיקון' with the funder's note and the resend path",
    await hasState(pa, "returned") && await seen(pa.getByTestId("party-submission").getByText("חסר צילום השלט")) &&
    await seen(pa.getByTestId("party-submission").getByText("סמנו שוב כמוכן להגשה", { exact: false })));
  await shot(pa, "03-returned");
  await pa.getByTestId("mark-ready").click();
  await hasState(pa, "ready");
  await pa.getByTestId("mark-sent").click();
  await pa.getByRole("dialog").getByRole("button", { name: "סימון כנשלח למממן" }).click();
  await hasState(pa, "sent");
  await pa.getByTestId("party-attempts").locator("summary").click();
  check("U11 resent -> attempt 2; attempt 1 and the return stay in the history",
    await seen(pa.getByTestId("party-attempts").getByText("(2)")) && await seen(pa.getByTestId("party-attempts").getByText("ניסיון 2")) &&
    await seen(pa.getByTestId("party-attempts").getByText("ניסיון 1 · הוחזר לתיקון")));

  section("PAYMENT REFERENCE (separate from the prior approval and from payment)");
  await pa.getByTestId("record-reference").click();
  await pa.getByRole("dialog").getByLabel("מספר אסמכתא").fill("REF-UI");
  await pa.getByRole("dialog").getByLabel("תאריך קבלה").fill("2026-09-12");
  await pa.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  check("U12 reference recorded -> 'התקבל אישור/אסמכתת תשלום', while the party payments still read 'לא שולם'",
    await hasState(pa, "reference_received") && await seen(pa.getByTestId("party-reference").getByText("REF-UI")) &&
    await seen(pa.getByTestId("party-payments").getByText("לא שולם")));
  check("U13 the prior approval panel is unchanged (AP-UI) - two different business events",
    await seen(pa.getByTestId("party-preapproval").getByText("AP-UI")));

  section("PARTY PAYMENTS TO THE SUPPLIER");
  const addPay = async (amount) => {
    await pa.getByTestId("party-add-payment").click();
    const d = pa.getByRole("dialog");
    await d.getByLabel("סכום (₪)").fill(amount);
    await d.getByLabel("תאריך תשלום").fill("2026-09-14");
    await d.getByRole("button", { name: "שמירה" }).click();
    await d.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  };
  await addPay("800");
  const pp = pa.getByTestId("party-payments");
  check("U14 installment of 800 -> 'שולם חלקית', remaining 1,200",
    await seen(pp.getByText("שולם חלקית")) && await seen(pp.getByText("1,200")) && await seen(pp.getByTestId("party-payment-list").getByText("800")));
  await shot(pa, "04-partial");

  section("PERMISSIONS");
  const ps = await newPage();
  await workerLogin(ps, "p-sub");
  await openExpense(ps, EX.id);
  check("U15 manageFunderSubmissions sees the party process but cannot record or reverse payments",
    await seen(ps.getByTestId("party-payments")) && (await ps.getByTestId("party-add-payment").count()) === 0 &&
    (await ps.getByTestId("party-payments").getByRole("button", { name: "ביטול תשלום" }).count()) === 0);
  const pv = await newPage();
  await workerLogin(pv, "p-view");
  await openExpense(pv, EG.id);
  check("U16 budget.view sees the panels but no party action at all",
    await seen(pv.getByTestId("party-submission")) && (await pv.getByTestId("record-preapproval").count()) === 0 &&
    (await pv.getByTestId("mark-ready").count()) === 0 && (await pv.getByTestId("record-reference").count()) === 0);

  section("REVERSAL + FULL PAYMENT");
  await pp.getByRole("button", { name: "ביטול תשלום" }).first().click();
  await pa.getByRole("dialog").getByLabel("סיבה").fill("נרשם בטעות");
  await pa.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  check("U17 reversed -> excluded from paid ('לא שולם' again) but kept in the list with the reason",
    await seen(pp.getByText("לא שולם")) && await seen(pp.getByTestId("party-payment-list").getByText("נרשם בטעות")));
  await addPay("2000");
  check("U18 the full party allocation paid -> 'שולם במלואו'", await seen(pp.getByText("שולם במלואו")));
  check("U19 submission state and payment status stay separate (reference received + paid in full)",
    await hasState(pa, "reference_received") && (await state(pa).count()) === 1);
  await shot(pa, "05-paid");

  section("MOBILE");
  const pm = await newPage({ width: 390, height: 844 });
  await workerLogin(pm, "p-full");
  await openExpense(pm, EX.id);
  await pm.getByTestId("party-payments").waitFor({ timeout: 20000 });
  const mobileOk = await noOverflow(pm);
  await shot(pm, "06-mobile-party");
  await openExpense(pm, EG.id);
  const mobileGapOk = await noOverflow(pm);
  await shot(pm, "07-mobile-gap");
  check("U20 no horizontal overflow at 390 (party panels, funding summary)", mobileOk && mobileGapOk);
  check("U21 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e).slice(0, 300));
  let i = 0;
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      i += 1;
      const text = await p.locator("body").innerText().catch(() => "");
      console.log(`  [diag] page ${i} url=${new URL(p.url()).pathname} text=${text.replace(/\s+/g, " ").slice(0, 200)}`);
      await shot(p, `zz-failure-${i}`).catch(() => undefined);
    }
  }
} finally {
  await browser.close();
  server.close();
  psql(`update public.platform_modules set available = false where key = 'budget';`);
  const { data } = await a.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if ((u.email ?? "").endsWith(`@${DOMAIN}`)) await a.auth.admin.deleteUser(u.id);
}
process.exit(tally("BUDGET PARTY UI") ? 1 : 0);
