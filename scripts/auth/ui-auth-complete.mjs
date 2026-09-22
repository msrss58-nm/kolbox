// KOLBOX - leg 2 of the handoff completes AUTOMATICALLY.
//
// WHY THIS SUITE EXISTS. Nothing asserted leg 2's behaviour, which is exactly
// why a user-visible confirmation step could sit in the normal login flow
// unnoticed. This is the guard for the property that replaced it: after a
// successful shared login the browser is carried into the target application
// with no click, no confirmation and no second credential prompt - and, just
// as importantly, that a handoff which does NOT succeed still fails closed.
//
// NO DATABASE AND NO SUPABASE STACK. It serves the built election bundle
// statically and stubs the two leg-2 endpoints, so it tests precisely the
// piece that changed - the screen's own behaviour - and is cheap enough to
// run on every change to the auth entry.
//
// Run:  node scripts/auth/ui-auth-complete.mjs [outDir] [--reuse]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-auth-complete"));
const reuse = process.argv.includes("--reuse");
fs.mkdirSync(outDir, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};
const section = (t) => console.log(`\n== ${t} ==`);

section("BUILD the election surface (the target origin that mints the session)");
const dist = path.join(outDir, "dist-election");
if (reuse && fs.existsSync(path.join(dist, "index.html"))) {
  check("B1 election bundle reused", true);
} else {
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
        VITE_APP_SURFACE: "election",
        VITE_SUPABASE_URL: "http://127.0.0.1:1/",
        VITE_SUPABASE_PUBLISHABLE_KEY: "auth-complete-suite-not-a-real-key",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  check("B1 election bundle built", fs.existsSync(path.join(dist, "index.html")));
}

const bundleJs = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(dist, "assets", f), "utf8"))
  .join("");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, rel);
  const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!rel.startsWith("/assets/") && !isFile) file = path.join(dist, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
  });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const pageErrors = [];

/** One run of leg 2 against a stubbed server, with NOTHING clicked. */
async function runLeg2(completeResponse) {
  const ctx = await browser.newContext({ locale: "he-IL" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const posts = [];
  const headings = [];

  await page.route("**/api/auth/complete", async (route) => {
    posts.push({
      method: route.request().method(),
      body: route.request().postData(),
    });
    await route.fulfill({
      status: completeResponse.status,
      contentType: "application/json",
      body: JSON.stringify(completeResponse.body),
    });
  });
  // If the screen ever asks for the identity again, this records it.
  const txnReads = [];
  await page.route("**/api/auth/txn", async (route) => {
    txnReads.push(1);
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  // The landing page is out of scope here - keep it inert so the assertion is
  // about WHERE the browser was sent, not about what that page renders.
  await page.route("**/election-day**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>landed</body></html>" });
  });

  // Sample the DOM continuously, so a confirmation that flashed up for even a
  // moment before auto-submitting would still be caught.
  const sampler = setInterval(() => {
    void page
      .evaluate(() => document.body?.innerText ?? "")
      .then((t) => headings.push(t))
      .catch(() => {});
  }, 60);

  await page.goto(`${BASE}/auth/complete`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  clearInterval(sampler);

  const finalUrl = page.url();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const buttons = await page
    .locator("button")
    .evaluateAll((els) => els.map((e) => e.innerText.trim()))
    .catch(() => []);
  await ctx.close();
  return { posts, txnReads, headings, finalUrl, bodyText, buttons };
}

try {
  section("A. A WORKER HANDOFF COMPLETES WITH NO USER ACTION");
  const worker = await runLeg2({
    status: 200,
    body: { ok: true, redirect: "/election-day" },
  });
  check("A1 leg 2 was posted WITHOUT anything being clicked", worker.posts.length === 1,
    JSON.stringify(worker.posts));
  check("A2 it posted the continue action, as a POST", worker.posts[0]?.method === "POST" &&
    String(worker.posts[0]?.body ?? "").includes("continue"), String(worker.posts[0]?.body));
  check("A3 the browser was carried to the destination the SERVER returned",
    new URL(worker.finalUrl).pathname === "/election-day", worker.finalUrl);

  section("B. NO CONFIRMATION IS EVER SHOWN - not even for a moment");
  const seen = worker.headings.join(" | ");
  check("B1 the confirmation title never appeared", !seen.includes("אישור כניסה"), seen.slice(0, 120));
  check("B2 no המשך button ever appeared", !worker.buttons.includes("המשך") && !seen.includes("המשך"));
  check("B3 no ביטול button ever appeared", !worker.buttons.includes("ביטול") && !seen.includes("ביטול"));
  check("B4 no identity-confirmation panel was rendered", !seen.includes("מזוהים בתור"));
  check("B5 the screen never re-read the transaction to show it",
    worker.txnReads.length === 0, String(worker.txnReads.length));
  check("B6 no credential field is ever on this screen", !seen.includes("סיסמה"));

  section("C. THE CONFIRMATION IS GONE FROM THE SHIPPED BUNDLE");
  for (const [id, s] of [
    ["C1", "אישור כניסה"],
    ["C2", "ודאו שאלו הפרטים שלכם לפני הכניסה למערכת"],
    ["C3", "מזוהים בתור"],
    ["C4", "סוג משתמש"],
  ]) {
    check(`${id} "${s}" is absent from the bundle`, !bundleJs.includes(s));
  }

  section("D. FAIL-CLOSED - a handoff that does not succeed mints nothing");
  const denied = await runLeg2({ status: 401, body: { ok: false } });
  check("D1 a refused leg 2 does NOT navigate into the application",
    new URL(denied.finalUrl).pathname === "/auth/complete", denied.finalUrl);
  check("D2 it shows the fail-closed state and a way back to the entry",
    denied.bodyText.includes("פג תוקף הבקשה") && denied.bodyText.includes("חזרה למסך הכניסה"),
    denied.bodyText.replace(/\s+/g, " ").slice(0, 120));
  check("D3 ... and still offers no confirmation controls",
    !denied.buttons.includes("המשך") && !denied.buttons.includes("ביטול"));

  const expired = await runLeg2({ status: 200, body: { ok: false } });
  check("D4 an ok:false body is treated as failure too, not as a session",
    new URL(expired.finalUrl).pathname === "/auth/complete", expired.finalUrl);

  section("E. NO SECRETS IN URLS");
  check("E1 the handoff never put a code, token or txn in the address bar",
    !/code=|token|txn=/i.test(worker.finalUrl) && !/code=|token|txn=/i.test(denied.finalUrl),
    `${worker.finalUrl} | ${denied.finalUrl}`);

  check("Z1 no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  server.close();
}

console.log(`\nAUTH COMPLETE (LEG 2) CONTRACT: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;
