// Platform Owner sign-in WITHOUT the MFA prompt - real-browser contract.
//
// Mandatory Platform Owner MFA was removed from the ACTIVE login flow
// (PLATFORM_OWNER_MFA_REQUIRED = false, in api/election-day/_platformAuth.ts
// and src/features/platform-owner/platform-owner.constants.ts). This suite is
// the assertion that it stays removed, and - just as importantly - that the
// MFA implementation is still present and still works.
//
// The account under test HOLDS A VERIFIED TOTP FACTOR before the tested
// sign-in happens. That is Production's exact state and the precise condition
// that used to render the TOTP challenge screen, so a regression that
// re-enables the gate fails here rather than in front of the owner.
//
// Builds the `platform` surface against the isolated kolboxs5 scratch stack,
// serves it with scripts/stage5/localServer.mjs (vercel.json rewrites -> the
// REAL bundled handlers) and drives headless Chromium.
//
// Run: S5_STACK_DIR=<stack> [S5_PORT_OFFSET=1000] node scripts/platform/ui-platform-owner-login.mjs <outDir>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildHandlers } from "../stage5/buildHandlers.mjs";
import { startLocalServer } from "../stage5/localServer.mjs";
import {
  admin,
  check,
  enrollTotp,
  installLocalnetGuard,
  loadStack,
  psql,
  section,
  signIn,
  tally,
} from "../stage5/lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-po-login-nomfa"));
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

const stackEnv = loadStack();
installLocalnetGuard();
const PORT = 5211;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.PLATFORM_ALLOWED_ORIGIN = BASE;
// api/_surfaceGate.ts fails closed on an unset KOLBOX_SURFACE and validates the
// request Host against KOLBOX_SELF_ORIGIN exactly - without both, every /api/*
// call answers 404 by design.
process.env.KOLBOX_SURFACE = "platform";
process.env.KOLBOX_SELF_ORIGIN = BASE;
const H = await buildHandlers();
const A = admin();

const stamp = Date.now();
const PO_EMAIL = `po-nomfa-${stamp}@kolbox.test`;
const PW = "Po-NoMfa-Login-9!";

// Hebrew copy the MFA screens own. If either appears, the prompt is back.
const MFA_ENROLL_TITLE = "הגדרת אימות דו-שלבי";
const MFA_CHALLENGE_TITLE = "אימות דו-שלבי";
// Anchor on a string ONLY the console renders. The console <h1> is a
// substring risk against login copy, so use the signed-in-as line.
const CONSOLE_MARK = `מחובר כ-${PO_EMAIL}`;

// ------------------------------------------------------------------ build --
section("BUILD the platform surface against the scratch stack");
const dist = path.join(outDir, "dist-platform");
execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "node_modules", "vite", "bin", "vite.js"),
    "build",
    "--outDir",
    dist,
    "--emptyOutDir",
    "--logLevel",
    "error",
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      VITE_APP_SURFACE: "platform",
      VITE_SUPABASE_URL: stackEnv.API_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: stackEnv.ANON_KEY,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
check("B1 platform bundle built", fs.existsSync(path.join(dist, "index.html")));

// The MFA implementation must still SHIP - "removed from the flow", not
// "deleted from the codebase".
const bundleJs = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(dist, "assets", f), "utf8"))
  .join("");
check("B2 the MFA enrollment screen is still in the shipped bundle", bundleJs.includes(MFA_ENROLL_TITLE));
check("B3 the MFA challenge screen is still in the shipped bundle", bundleJs.includes(MFA_CHALLENGE_TITLE));

// ----------------------------------------------------------------- fixture --
section("FIXTURE: a Platform Owner who ALREADY holds a verified TOTP factor");
const { data: created, error: createErr } = await A.auth.admin.createUser({
  email: PO_EMAIL,
  password: PW,
  email_confirm: true,
});
if (createErr) throw new Error(`createUser: ${createErr.message}`);
psql(`delete from public.platform_owners;`);
psql(
  `insert into public.platform_owners (auth_user_id, name, email) values ('${created.user.id}', 'PO NoMfa', '${PO_EMAIL}');`,
);

const seed = await signIn(PO_EMAIL, PW);
await enrollTotp(seed.client, `po-nomfa-${stamp}`);
const factors = await seed.client.auth.mfa.listFactors();
check(
  "F1 the account holds a VERIFIED TOTP factor before the tested sign-in",
  (factors.data?.totp ?? []).some((f) => f.status === "verified"),
);

// ------------------------------------------------------------------ serve --
// localServer routes by PATH (after applying vercel.json rewrites), not by
// handler name.
const server = await startLocalServer({
  distDir: dist,
  port: PORT,
  handlers: { "/api/platform/session": H.platformSession, "/api/health": H.health },
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const apiLog = [];
page.on("response", async (r) => {
  if (r.url().includes("/api/") || r.url().includes("/auth/v1/")) {
    let b = "";
    try { b = (await r.text()).slice(0, 200); } catch { b = "<no body>"; }
    apiLog.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "")} :: ${b}`);
  }
});
page.on("console", (m) => pageErrors.push(`console.${m.type()}: ${m.text().slice(0, 200)}`));

// Record every distinct heading the app renders during the transition, so an
// MFA screen that merely FLASHES is still caught.
const seenTitles = new Set();
const sample = async () => {
  try {
    const t = await page.locator("h1, h2").allTextContents();
    for (const x of t) seenTitles.add(x.trim());
  } catch {
    /* mid-navigation */
  }
};

try {
  section("SIGN IN WITH PASSWORD ONLY");
  await page.goto(`${BASE}/platform/login`, { waitUntil: "networkidle" });
  await sample();
  const body0 = await page.locator("body").innerText();
  check(
    "L1 the login screen shows no TOTP field and no two-factor promise",
    !body0.includes(MFA_CHALLENGE_TITLE),
    body0.slice(0, 160).replace(/\n/g, " | "),
  );
  await page.screenshot({ path: path.join(screens, "01-login.png") });

  await page.locator('input[type="email"]').fill(PO_EMAIL);
  await page.locator('input[type="password"]').fill(PW);
  const sampler = setInterval(() => void sample(), 60);
  await page.locator('button[type="submit"]').click();
  try {
    await page.waitForSelector(`text=${CONSOLE_MARK}`, { timeout: 30000 });
  } catch (e) {
    console.log("--- DIAGNOSTIC: page after submit ---");
    console.log((await page.locator("body").innerText()).slice(0, 600));
    console.log("--- API/auth traffic ---");
    for (const l of apiLog) console.log("  " + l);
    console.log("--- console/page errors ---");
    for (const l of pageErrors) console.log("  " + l);
    throw e;
  }
  clearInterval(sampler);
  await sample();
  await page.screenshot({ path: path.join(screens, "02-console.png") });

  check("L2 the console rendered after password-only sign-in", true);
  check("L3 the MFA CHALLENGE screen never rendered", !seenTitles.has(MFA_CHALLENGE_TITLE), [...seenTitles].join(" / "));
  check("L4 the MFA ENROLLMENT screen never rendered", !seenTitles.has(MFA_ENROLL_TITLE), [...seenTitles].join(" / "));
  const body1 = await page.locator("body").innerText();
  check("L5 the console is really the console (owner email shown)", body1.includes(PO_EMAIL), body1.slice(0, 200).replace(/\n/g, " | "));

  section("THE SESSION SURVIVES A RELOAD WITHOUT AN MFA PROMPT");
  await page.goto(`${BASE}/platform`, { waitUntil: "networkidle" });
  await sample();
  await page.waitForSelector(`text=${CONSOLE_MARK}`, { timeout: 30000 });
  const body2 = await page.locator("body").innerText();
  check("R1 a reload lands straight on the console", body2.includes(CONSOLE_MARK));
  // Heading-exact, not substring: the console legitimately RENDERS the words
  // "אימות דו-שלבי" inside its "two-factor is not required" status row, so a
  // body.includes() check here reports a screen that is not there.
  const reloadHeadings = (await page.locator("h1, h2").allTextContents()).map((x) => x.trim());
  check(
    "R2 no MFA screen on reload either",
    !reloadHeadings.includes(MFA_ENROLL_TITLE) && !reloadHeadings.includes(MFA_CHALLENGE_TITLE),
    reloadHeadings.join(" / "),
  );

  section("THE BROWSER SESSION IS aal1 - it really never did a second factor");
  const aal = await page.evaluate(() => {
    const raw = localStorage.getItem("kb-platform-owner-auth-token");
    if (!raw) return null;
    const tok = JSON.parse(raw).access_token;
    return JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).aal;
  });
  check("A1 the authorized console session is aal1 (password only)", aal === "aal1", `aal=${aal}`);

  // A signed-in account that is NOT the Platform Owner used to land on TOTP
  // ENROLLMENT (aal1, no factor). With MFA out of the flow it is admitted to
  // aal1, the server refuses it, and the guard shows the no-access screen -
  // which must still offer a working sign-out so the account is not stranded.
  section("A NON-OWNER IS REFUSED - AND IS NOT STRANDED");
  const STRANGER_EMAIL = `stranger-${stamp}@kolbox.test`;
  await A.auth.admin.createUser({ email: STRANGER_EMAIL, password: PW, email_confirm: true });
  const sCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "he-IL" });
  const sPage = await sCtx.newPage();
  await sPage.goto(`${BASE}/platform/login`, { waitUntil: "networkidle" });
  await sPage.locator('input[type="email"]').fill(STRANGER_EMAIL);
  await sPage.locator('input[type="password"]').fill(PW);
  await sPage.locator('button[type="submit"]').click();
  const sawForbidden = await sPage
    .getByRole("heading", { name: "אין הרשאת גישה" })
    .waitFor({ timeout: 20000 })
    .then(() => true, () => false);
  check("N1 a non-owner gets the no-access screen, NOT the TOTP enrollment screen", sawForbidden);
  const sHeadings = (await sPage.locator("h1, h2").allTextContents()).map((x) => x.trim());
  check("N2 the TOTP enrollment screen did not render for the non-owner",
    !sHeadings.includes(MFA_ENROLL_TITLE), sHeadings.join(" / "));
  await sPage.getByRole("button", { name: "התנתקות" }).click();
  await sPage.getByRole("heading", { name: "כניסת בעל הפלטפורמה" }).waitFor({ timeout: 15000 });
  const sKeys = await sPage.evaluate(() => Object.keys(localStorage));
  check("N3 sign-out from the no-access screen clears the platform session",
    !sKeys.includes("kb-platform-owner-auth-token"), sKeys.join(","));
  await sCtx.close();

  // WHY the Production factor was unenrolled. GoTrue refuses
  // updateUser({password}) from an aal1 session while a VERIFIED factor
  // exists. With MFA out of the login flow there is no in-app way to reach
  // aal2 any more, so a leftover factor would permanently strand the Owner's
  // password change. Removing the factor - not weakening any gate - is the
  // fix, and this proves both halves of that statement.
  section("PASSWORD CHANGE: a stale factor is what blocks it");
  const PW_EMAIL = `pwcheck-${stamp}@kolbox.test`;
  await A.auth.admin.createUser({ email: PW_EMAIL, password: PW, email_confirm: true });

  const p1 = await signIn(PW_EMAIL, PW);
  const r1 = await p1.client.auth.updateUser({ password: `${PW}-v2` });
  check("P1 no factor, aal1 -> the password CAN be changed", !r1.error, r1.error?.message);

  const p2 = await signIn(PW_EMAIL, `${PW}-v2`);
  const enrolled = await enrollTotp(p2.client, `pwcheck-${stamp}`);
  const p3 = await signIn(PW_EMAIL, `${PW}-v2`);
  const r2 = await p3.client.auth.updateUser({ password: `${PW}-v3` });
  check("P2 verified factor, aal1 -> the password change is REFUSED (insufficient_aal)",
    !!r2.error && String(r2.error.code ?? r2.error.message).includes("insufficient_aal"),
    r2.error ? `${r2.error.code ?? ""} ${r2.error.message}` : "no error");

  const factorList = await A.auth.admin.mfa.listFactors({ userId: p3.client ? (await p3.client.auth.getUser()).data.user.id : "" });
  for (const f of factorList.data?.factors ?? []) {
    await A.auth.admin.mfa.deleteFactor({ id: f.id, userId: (await p3.client.auth.getUser()).data.user.id });
  }
  const p4 = await signIn(PW_EMAIL, `${PW}-v2`);
  const r3 = await p4.client.auth.updateUser({ password: `${PW}-v4` });
  check("P3 factor removed, aal1 -> the password CAN be changed again", !r3.error,
    r3.error ? `${r3.error.code ?? ""} ${r3.error.message}` : "");
  const p5 = await signIn(PW_EMAIL, `${PW}-v4`);
  check("P4 ... and the account still signs in with password only",
    !!p5.token && !!enrolled);

  check("E1 no page errors anywhere in the flow", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
  await browser.close();
  await new Promise((r) => server.close(() => r()));
}

tally("PLATFORM OWNER PASSWORD-ONLY LOGIN");
