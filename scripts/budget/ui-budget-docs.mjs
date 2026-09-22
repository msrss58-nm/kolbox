// Budget Stage 4 - REAL-LOCAL UI suite for documents, the order form and the
// supplier file.
//
// Builds the `election` surface against the isolated kolboxs5 scratch stack
// (started with S5_STORAGE=1), serves it with scripts/stage5/localServer.mjs
// (vercel.json rewrites -> the REAL bundled handlers) and drives headless
// Chromium. Files travel exactly as in production: the browser PUTs straight
// to the signed Storage URL. Synthetic *.invalid identities; nothing secret is
// printed.
//
// Run:  S5_STACK_DIR=<scratch>/s4stack [S5_PORT_OFFSET=1000] node scripts/budget/ui-budget-docs.mjs <outDir>
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
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-budget-docs-ui"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const PORT = 5196;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SESSION_ALLOWED_ORIGIN = BASE;
const H = await buildHandlers();
const a = admin();

const RUN = crypto.randomBytes(3).toString("hex");
const PFX = `S4UI-${RUN}`;
const DOMAIN = `budget-docs-ui-${RUN}.invalid`;
const PW = "S4-Ui-Pw-3!";
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
user("d-full", role("full", [...ALL, "voter.viewName"]));
user("d-view", role("view", ["budget.view"]));
const ownerEmail = `owner@${DOMAIN}`;
const { data: ou, error: oe } = await a.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true });
if (oe) throw oe;
psql(`insert into public.election_owners (workspace_id, auth_user_id, name, email) values ('${WA}', '${ou.user.id}', 'Owner Docs', '${ownerEmail}');`);

// Fixture data through the REAL handlers (a worker session), not SQL.
psql("delete from public.election_day_login_attempts;");
const lr = await callHandler(H.electionSession, { method: "POST", url: "/api/election-day/session", headers: { origin: BASE },
  body: { workspaceCode: CODE, name: "d-full", password: PW } });
const cookie = String(lr.headers?.["set-cookie"] ?? "").split(";")[0].split("=").slice(1).join("=");
const api = async (op, args) => (await callHandler(H.budget, { method: "POST", url: "/api/budget/actions", headers: { origin: BASE },
  body: { op, args }, cookies: { "__Host-kb_ed_session": cookie } })).body?.data;
const catId = (await api("create_category", { name: "שילוט UI" })).id;
const photoCat = (await api("create_category", { name: "אירועים UI" })).id;
const srcId = (await api("create_source", { name: "מימון מפלגתי UI", kind: "party", originalAmount: 50000000 })).id;
const supId = (await api("create_supplier", { businessName: "דפוס UI בע\"מ", phone: "050-7654321", taxId: "514000222" })).id;
await api("update_settings", { branchName: "סניף UI", branchNumber: "9", defaultOrderer: "מזמין UI", funderHeaderLines: ["מפלגה UI"] });
const exp = await api("create_expense", { description: "שלטי חוצות UI", supplierId: supId, categoryId: catId, total: 200000, expenseDate: "2026-09-10" });
const withAlloc = await api("set_allocation", { expenseId: exp.id, sourceId: srcId, amount: 200000 });
await api("record_preapproval", { allocationId: withAlloc.allocations[0].id, orderNumber: "UI-1", approvalCode: "AP-UI", approverName: "מאשר UI", approvalDate: "2026-09-08" });
check("S1 fixtures created through the real handlers", Boolean(WA && cookie && exp?.id));

const pdfFile = (name, n = 4096) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.7\n%ui\n"), crypto.randomBytes(n)]) });
const jpgFile = (name) => ({ name, mimeType: "image/jpeg", buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]) });

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
  const ctx = await browser.newContext({ viewport, locale: "he-IL", acceptDownloads: true });
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
  // Wait until the login page is LEFT (the login page itself is under
  // /election-day, so a path pattern would match before the session exists).
  await p.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }).catch(() => {});
}
/** Opens a file dialog from `trigger`, chooses the file and submits. */
async function uploadVia(p, trigger, file, fill = {}) {
  await trigger.click();
  const dlg = p.getByTestId("document-upload");
  await dlg.waitFor({ timeout: 10000 });
  if (fill.type) await dlg.getByLabel("סוג מסמך").selectOption({ label: fill.type });
  await dlg.getByLabel("קובץ").setInputFiles(file);
  if (fill.validUntil) await dlg.getByLabel("בתוקף עד (רשות)").fill(fill.validUntil);
  await dlg.getByRole("button", { name: "העלאת מסמך" }).click();
  await dlg.waitFor({ state: "detached", timeout: 20000 }).catch(() => {});
}

try {
  section("EXPENSE DOCUMENTS (checklist, upload, new version, history, download)");
  const pa = await newPage();
  await workerLogin(pa, "d-full");
  await pa.goto(`${BASE}/budget/expenses/${exp.id}`);
  await pa.getByTestId("expense-file").waitFor({ timeout: 20000 });
  const checklist = pa.getByTestId("document-checklist");
  check("D01 the checklist shows the party requirements (quotation missing)",
    await seen(pa.getByTestId("requirement-quotation").locator('[data-state="missing"]')));
  check("D02 2,000 ILS: invoice required (threshold explained)", await seen(pa.getByTestId("requirement-invoice").getByText("הסכום מעל")));
  await uploadVia(pa, pa.getByTestId("requirement-quotation").getByRole("button", { name: "העלאה" }), pdfFile("הצעת מחיר.pdf"));
  check("D03 upload from the checklist -> quotation present (version 1)",
    await seen(pa.getByTestId("requirement-quotation").locator('[data-state="present"]', { hasText: "גרסה 1" }), 20000));
  await uploadVia(pa, pa.getByTestId("requirement-quotation").getByRole("button", { name: "גרסה חדשה" }), pdfFile("הצעת מחיר 2.pdf"));
  check("D04 a new version -> version 2 satisfies the requirement",
    await seen(pa.getByTestId("requirement-quotation").locator('[data-state="present"]', { hasText: "גרסה 2" }), 20000));
  const card = pa.getByTestId("expense-documents").getByTestId("document-card").filter({ hasText: "הצעת מחיר" }).first();
  await card.getByRole("button", { name: /הצגת גרסאות קודמות/ }).click();
  check("D05 version history shows version 1 (kept, never overwritten)", await seen(card.getByTestId("document-versions").getByText("גרסה 1")));
  const [download] = await Promise.all([pa.waitForEvent("download", { timeout: 20000 }), card.getByTestId("document-versions").getByRole("button", { name: "הורדה" }).click()]);
  check("D06 an old version downloads through a signed link", Boolean(download) && (await download.path()) !== null);
  await pa.getByTestId("upload-document").click();
  await pa.getByTestId("document-upload").getByLabel("סוג מסמך").selectOption({ label: "צילום" });
  await pa.getByTestId("document-upload").getByLabel("קובץ").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  check("D07 an unsupported file type is refused in the dialog before upload", await seen(pa.getByTestId("document-upload").getByRole("alert")));
  await pa.getByTestId("document-upload").getByLabel("קובץ").setInputFiles(jpgFile("photo.jpg"));
  await pa.getByTestId("document-upload").getByRole("button", { name: "העלאת מסמך" }).click();
  check("D08 an optional photo can be attached", await seen(pa.getByTestId("expense-documents").getByText("photo.jpg"), 20000));
  await pa.getByText("צילום נדרש להוצאה זו").click();
  check("D09 per-expense override: photo becomes required (and is already present)",
    await seen(pa.getByTestId("requirement-photo").getByText("נדרש", { exact: true }), 15000));
  await shot(pa, "01-expense-documents");

  section("ORDER FORM (generate, send, supplier return)");
  const of = pa.getByTestId("order-form");
  check("O01 order form ready to generate after the prior approval", await seen(of.locator('[data-state="ready"]')));
  check("O02 supplier signature required above 1,500 ILS", await seen(of.getByText("נדרשת חתימת ספק")));
  await of.getByTestId("order-form-generate").click();
  check("O03 final PDF generated -> version 1 listed, state 'generated'",
    await seen(of.getByTestId("order-form-version").getByText("גרסה 1"), 30000) && await seen(of.locator('[data-state="generated"]')));
  const [pdfDl] = await Promise.all([pa.waitForEvent("download", { timeout: 20000 }), of.getByTestId("order-form-version").first().getByRole("button", { name: "הורדה" }).click()]);
  const pdfPath = await pdfDl.path();
  const pdfHead = pdfPath ? fs.readFileSync(pdfPath).subarray(0, 5).toString() : "";
  check("O04 the generated order form downloads as a PDF", pdfHead === "%PDF-" && pdfDl.suggestedFilename().endsWith(".pdf"), pdfDl.suggestedFilename());
  await of.getByRole("button", { name: "שליחה לספק" }).click();
  const send = pa.getByTestId("order-form-send");
  const wa = await send.getByRole("link", { name: "פתיחת WhatsApp" }).getAttribute("href");
  check("O05 WhatsApp link prepared for the supplier's number (972...) with text", (wa ?? "").startsWith("https://wa.me/972507654321?text="), wa ?? "");
  await send.getByRole("button", { name: "אישור: הטופס נשלח לספק" }).click();
  check("O06 'sent' is the user's confirmation", await seen(of.getByTestId("order-form-sent"), 15000) && await seen(of.locator('[data-state="sent"]')));
  await uploadVia(pa, of.getByRole("button", { name: "העלאת טופס חתום" }).first(), pdfFile("טופס חתום.pdf"));
  check("O07 supplier-signed return linked to version 1 -> 'returned', signature requirement satisfied",
    await seen(of.locator('[data-state="returned"]'), 20000) && await seen(pa.getByTestId("requirement-order_form_signed").locator('[data-state="present"]')));
  await shot(pa, "02-order-form");

  section("SUPPLIER FILE (supplier documents, linked expenses)");
  await pa.goto(`${BASE}/budget/suppliers`);
  const supCard = pa.getByTestId("supplier-list").locator("li").filter({ hasText: "דפוס UI" });
  await supCard.getByTestId("supplier-file-open").click();
  const sf = pa.getByTestId("supplier-file");
  await sf.waitFor({ timeout: 15000 });
  check("F01 supplier file lists the supplier's expense with its document state", await seen(sf.getByTestId("supplier-expenses").getByText("שלטי חוצות UI")));
  await uploadVia(pa, sf.getByTestId("supplier-upload"), pdfFile("אישור ניהול חשבון.pdf"), { validUntil: "2099-12-31" });
  check("F02 a bank-account confirmation (valid until) is filed on the supplier", await seen(sf.getByTestId("supplier-documents").getByText("2099-12-31"), 20000));
  check("F03 bank details stay masked in the supplier area", !(await pa.locator("body").innerText()).includes("accountNumber"));
  await shot(pa, "03-supplier-file");
  await pa.goto(`${BASE}/budget/expenses/${exp.id}`);
  check("F04 the supplier's confirmation now satisfies the expense's bank requirement",
    await seen(pa.getByTestId("requirement-bank_confirmation").getByText("מתיק הספק"), 20000));

  section("SETTINGS (thresholds, photo by category, custom types) - both consumers");
  await pa.goto(`${BASE}/budget/settings`);
  check("G01 threshold semantics explained ('מעל'; exactly 1,500 not required)", await seen(pa.getByText("בדיוק 1,500")));
  const photoRule = pa.getByTestId("document-rules").locator("li").filter({ hasText: "בקטגוריות נבחרות" });
  await photoRule.getByRole("button", { name: "בחירת קטגוריות" }).click();
  await pa.getByRole("dialog").getByLabel("אירועים UI").check();
  await pa.getByRole("dialog").getByRole("button", { name: "שמירה" }).click();
  check("G02 photo-by-category rule set from the settings page", await seen(photoRule.getByTestId("rule-categories").getByText("אירועים UI"), 15000));
  await pa.getByPlaceholder("סוג מסמך חדש").fill("אישור עירייה UI");
  await pa.getByTestId("document-types").locator("..").getByRole("button", { name: "הוספה" }).click();
  check("G03 a custom document type is created", await seen(pa.getByTestId("document-types").getByText("אישור עירייה UI")));
  const po = await newPage();
  await po.goto(`${BASE}/election-day/owner-login`);
  await po.getByRole("heading", { name: "כניסת בעלים" }).waitFor({ timeout: 15000 });
  await po.locator('input[type="email"]').fill(ownerEmail);
  await po.locator('input[autocomplete="current-password"]').fill(PW);
  await po.getByRole("button", { name: "התחברות" }).click();
  // Owner sidebar accordion: the Budget module section starts collapsed.
  // The Owner-only Budget settings section lives in the ADMINISTRATION
  // group of the full application shell now - the "ניהול תקציב" group holds
  // the Budget module own screens.
  await po.getByRole("button", { name: "ניהול המערכת" }).first().waitFor({ timeout: 25000 });
  await po.getByRole("button", { name: "ניהול המערכת" }).first().click();
  await po.getByRole("link", { name: "הגדרות תקציב" }).first().click();
  check("G04 Owner settings (the second consumer of the shared panel) show the same types + category rule",
    await seen(po.getByTestId("document-types").getByText("אישור עירייה UI"), 20000) && await seen(po.getByTestId("rule-categories").getByText("אירועים UI")));
  await shot(po, "04-owner-settings");

  section("PERMISSIONS + MOBILE");
  const pv = await newPage();
  await workerLogin(pv, "d-view");
  await pv.goto(`${BASE}/budget/expenses/${exp.id}`);
  await pv.getByTestId("document-checklist").waitFor({ timeout: 20000 });
  check("P01 budget.view sees the checklist and documents but no upload / generate controls",
    (await pv.getByTestId("upload-document").count()) === 0 && (await pv.getByTestId("order-form-generate").count()) === 0 &&
    (await pv.getByRole("button", { name: "גרסה חדשה" }).count()) === 0);
  const pm = await newPage({ width: 390, height: 844 });
  await workerLogin(pm, "d-full");
  await pm.goto(`${BASE}/budget/expenses/${exp.id}`);
  await pm.getByTestId("document-checklist").waitFor({ timeout: 20000 });
  const noOverflowExpense = await noOverflow(pm);
  await shot(pm, "05-mobile-expense");
  await pm.goto(`${BASE}/budget/suppliers`);
  await pm.getByTestId("supplier-file-open").first().click();
  await pm.getByTestId("supplier-file").waitFor({ timeout: 15000 });
  const noOverflowSupplier = await noOverflow(pm);
  await shot(pm, "06-mobile-supplier-file");
  check("M01 no horizontal overflow at 390 (expense documents, supplier file)", noOverflowExpense && noOverflowSupplier);
  check("M02 no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e).slice(0, 300));
  // Diagnostics: where every open page stood when the step failed.
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
process.exit(tally("BUDGET DOCUMENTS UI") ? 1 : 0);
