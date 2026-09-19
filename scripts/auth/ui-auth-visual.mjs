// VISUAL CONTRACT for the dedicated KOLBOX Auth / IdP origin's entry screen.
//
// WHY THIS SUITE EXISTS. The Auth origin shipped once with a bare centred
// white card instead of the approved KOLBOX sign-in design. Every security
// gate passed, every end-to-end flow passed, and the regression still reached
// Production - because nothing asserted the DESIGN. This suite is that
// assertion, and it is the reason the same regression cannot recur silently.
//
// It proves three things at once:
//   1. the entry screen renders the approved branded split-screen layout;
//   2. the NEW unified-auth behaviour is what lives inside it (one identifier,
//      one password, a worker system-code path) - and the retired e-mail OTP
//      flow is absent from the screen AND from the shipped bundle;
//   3. the strict Auth CSP is intact and the page needs no inline script,
//      inline style, webfont or remote asset to look right.
//
// Deliberately needs NO database and NO Supabase stack: it serves the built
// auth bundle as static files and never submits the form, so it is cheap
// enough to run on every change to the entry screen.
//
// Run: node scripts/auth/ui-auth-visual.mjs <outDir> [--reuse]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = process.env.VM_REPO_ROOT ?? path.resolve(import.meta.dirname, "..", "..");
const repoRequire = createRequire(pathToFileURL(path.join(repoRoot, "package.json")).href);
const { chromium } = repoRequire("playwright");

const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-auth-visual"));
const reuse = process.argv.includes("--reuse");
const screens = path.join(outDir, "screens");
fs.mkdirSync(screens, { recursive: true });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  -> ${String(detail).slice(0, 300)}` : ""}`);
  }
};
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------- build ----
section("BUILD the auth surface");
const dist = path.join(outDir, "dist-auth");
if (reuse && fs.existsSync(path.join(dist, "index.html"))) {
  check("B1 auth bundle reused", true);
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
        VITE_APP_SURFACE: "auth",
        VITE_SUPABASE_URL: "http://127.0.0.1:1/",
        VITE_SUPABASE_PUBLISHABLE_KEY: "visual-suite-not-a-real-key",
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  check("B1 auth bundle built", fs.existsSync(path.join(dist, "index.html")));
}

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const bundleJs = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => fs.readFileSync(path.join(dist, "assets", f), "utf8"))
  .join("");
const bundleCss = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => fs.readFileSync(path.join(dist, "assets", f), "utf8"))
  .join("");

// --------------------------------------------------------------- server ----
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, rel);
  // The SPA rewrite, exactly as vercel.json serves it. A directory (notably
  // "/" itself) is a miss, not a hit - it must fall through to index.html.
  const isFile = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!rel.startsWith("/assets/") && !isFile) file = path.join(dist, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const pageErrors = [];

try {
  // ------------------------------------------------------- desktop ----
  section("DESKTOP - the approved branded split-screen design");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  p.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  await p.goto(`${BASE}/`);
  await p.getByRole("heading", { name: "כניסה לקולבוקס" }).waitFor({ timeout: 20000 });

  // The brand panel is identified structurally - by the gradient utility the
  // approved design uses - not by a test id, so it cannot pass while looking
  // like something else.
  const panel = p.locator("div.bg-gradient-to-bl.from-primary-950").first();
  check("V1 the branded gradient panel is rendered", await panel.isVisible());

  const box = await panel.boundingBox();
  check(
    "V2 the panel occupies a full-height half of the split screen",
    box !== null && box.height >= 700 && box.width >= 500 && box.width <= 700,
    box && `${Math.round(box.width)}x${Math.round(box.height)}`,
  );

  // RTL: the brand panel is the FIRST flex child, so in a right-to-left
  // document it lands on the RIGHT and the login area on the LEFT - the
  // approved arrangement. Asserted by geometry, not by class order, so a
  // direction regression (e.g. a physical `left-*` creeping in) is caught.
  const formBox = await p.locator("form").first().boundingBox();
  check(
    "V3 RTL puts the login area on the LEFT and the brand panel on the RIGHT",
    box !== null && formBox !== null && formBox.x < box.x,
    `form.x=${formBox && Math.round(formBox.x)} panel.x=${box && Math.round(box.x)}`,
  );

  check(
    "V4 the KOLBOX wordmark is in the brand panel",
    (await panel.getByText("קול", { exact: false }).count()) > 0,
  );
  check("V5 the approved headline is present", await p.getByText("כל קול נספר.").isVisible());
  check(
    "V6 the approved sub-headline is present",
    await p.getByText("כל תומך מגיע לקלפי.").isVisible(),
  );
  check(
    "V7 both brand highlights are present",
    (await p.getByText("ניהול אלפי בוחרים בחיפוש מיידי").isVisible()) &&
      (await p.getByText("פעילי שטח עם דירוגים ותחרות").isVisible()),
  );
  check(
    "V8 the form area is on a white/surface ground, not on the gradient",
    (await p.locator("div.bg-surface").count()) > 0,
  );
  await p.screenshot({ path: path.join(screens, "auth-desktop.png"), fullPage: false });

  // ------------------------------------------- the new auth behaviour ----
  section("THE NEW UNIFIED AUTH BEHAVIOUR LIVES INSIDE THAT DESIGN");
  check("F1 one identifier field", (await p.locator('input[name="kb-identifier"]').count()) === 1);
  check(
    "F2 one password field, masked by default",
    (await p.locator('input[name="kb-current-password"]').getAttribute("type")) === "password",
  );

  const toggle = p.getByRole("button", { name: "הצג סיסמה" });
  check("F3 a password visibility toggle exists", await toggle.isVisible());
  await p.locator('input[name="kb-current-password"]').fill("visual-suite-probe");
  await toggle.click();
  check(
    "F4 the toggle reveals the password",
    (await p.locator('input[name="kb-current-password"]').getAttribute("type")) === "text",
  );
  await p.getByRole("button", { name: "הסתר סיסמה" }).click();
  check(
    "F5 the toggle hides it again",
    (await p.locator('input[name="kb-current-password"]').getAttribute("type")) === "password",
  );

  check(
    "F6 the worker / system-code path is offered",
    await p.getByRole("button", { name: "כניסת צוות עם קוד מערכת" }).isVisible(),
  );
  await p.getByRole("button", { name: "כניסת צוות עם קוד מערכת" }).click();
  check(
    "F7 the worker path reveals the system-code field",
    await p.locator('input[name="kb-workspace-code"]').isVisible(),
  );
  await p.getByRole("button", { name: "כניסה עם אימייל" }).click();
  check(
    "F8 leaving the worker path hides the system-code field again",
    (await p.locator('input[name="kb-workspace-code"]').count()) === 0,
  );

  const submit = p.locator('form button[type="submit"]');
  check("F9 a single primary submit button", (await submit.count()) === 1);
  check("F10 the submit button reads the login action", (await submit.innerText()).includes("התחברות"));

  // --------------------------------------------- the OTP flow is gone ----
  section("THE RETIRED E-MAIL OTP FLOW IS ABSENT");
  const bodyText = await p.locator("body").innerText();
  for (const [id, phrase] of [
    ["N1", "שליחת קוד"],
    ["N2", "הזינו את הקוד"],
    ["N3", "אימות והתחברות"],
    ["N4", "שליחת קוד חדש"],
  ]) {
    check(`${id} the screen does not offer "${phrase}"`, !bodyText.includes(phrase));
  }
  check(
    "N5 the shipped auth bundle contains no OTP step copy at all",
    !bundleJs.includes("שלחנו קוד בן 6 ספרות") && !bundleJs.includes("כתובת אימייל אחרת"),
  );
  check(
    "N6 the shipped auth bundle contains no one-time-code input",
    !bundleJs.includes("one-time-code"),
  );
  check(
    "N7 the dev OTP bypass address is not in the auth bundle",
    !bundleJs.includes("111@gmail.com"),
  );

  // ---------------------------------------------------------- mobile ----
  section("MOBILE 390 - professional layout, RTL, no overflow");
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => pageErrors.push(String(e)));
  await m.goto(`${BASE}/`);
  await m.getByRole("heading", { name: "כניסה לקולבוקס" }).waitFor({ timeout: 20000 });

  check(
    "M1 the brand panel is dropped on a phone (not squeezed or clipped)",
    !(await m.locator("div.bg-gradient-to-bl.from-primary-950").first().isVisible()),
  );
  // Scoped to the form panel's own mobile-only logo wrapper - `svg` alone
  // would match the hidden brand panel's wordmark, which is still in the DOM.
  const mobileLogo = m.locator("div.lg\\:hidden").filter({ has: m.locator("svg") }).first();
  check(
    "M2 the logo mark stands in for it",
    (await mobileLogo.isVisible()) &&
      (await m.locator('input[name="kb-identifier"]').isVisible()),
  );

  const overflow = await m.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  check(
    "M3 no horizontal overflow at 390px",
    overflow.doc <= overflow.win + 1,
    `scrollWidth=${overflow.doc} innerWidth=${overflow.win}`,
  );

  const mSubmit = await m.locator('form button[type="submit"]').boundingBox();
  check(
    "M4 the submit button is a full-width, >=44px touch target",
    mSubmit !== null && mSubmit.height >= 44 && mSubmit.width >= 260,
    mSubmit && `${Math.round(mSubmit.width)}x${Math.round(mSubmit.height)}`,
  );

  const mId = await m.locator('input[name="kb-identifier"]').boundingBox();
  check(
    "M5 the identifier field is not clipped and keeps a side gutter",
    mId !== null && mId.x >= 8 && mId.x + mId.width <= 390 - 8,
    mId && `x=${Math.round(mId.x)} w=${Math.round(mId.width)}`,
  );

  const dir = await m.evaluate(() => ({
    html: document.documentElement.getAttribute("dir"),
    computed: getComputedStyle(document.body).direction,
  }));
  check("M6 RTL is preserved on mobile", dir.html === "rtl" && dir.computed === "rtl", JSON.stringify(dir));
  await m.screenshot({ path: path.join(screens, "auth-mobile.png"), fullPage: false });

  // ------------------------------------------------------------- CSP ----
  section("CSP - the design needs no weakening");
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  check("C1 the strict CSP meta is emitted for the auth surface", meta !== null);
  const csp = meta ? meta[1] : "";
  check("C2 no unsafe-inline", !csp.includes("unsafe-inline"), csp);
  check("C3 no unsafe-eval", !csp.includes("unsafe-eval"), csp);
  check("C4 default-src 'none'", csp.includes("default-src 'none'"), csp);
  check("C5 base-uri 'none'", csp.includes("base-uri 'none'"), csp);
  check("C6 connect-src is self only", /connect-src 'self'(;|$)/.test(csp), csp);
  check(
    "C7 form-action names only the three application origins",
    /form-action ([^;]+)/.test(csp) &&
      /form-action ([^;]+)/
        .exec(csp)[1]
        .trim()
        .split(/\s+/)
        .every((o) => /^https:\/\/kolbox-(gamma|platform|multi-entity)\.vercel\.app$/.test(o)),
    csp,
  );
  check("C8 no Google Fonts preconnect survives on the auth surface", !html.includes("fonts.googleapis.com"));
  check("C9 no webfont is referenced by the auth stylesheet", !bundleCss.includes("fonts.gstatic.com"));
  check("C10 the page carries no inline <script>", !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(html));
  check(
    "C11 the branded panel uses no inline style attribute",
    (await p.locator("div.bg-gradient-to-bl.from-primary-950").first().getAttribute("style")) === null,
  );
  // Only fetched references count. The CSP meta legitimately NAMES the three
  // target origins in `form-action`; those are policy values, not assets, so
  // the meta is excluded before scanning src=/href= for anything remote.
  const htmlNoCsp = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/g, "");
  const remoteRefs = [...htmlNoCsp.matchAll(/\b(?:src|href)\s*=\s*"(https?:\/\/[^"]+)"/g)].map(
    (mm) => mm[1],
  );
  check("C12 no remote asset is referenced by the document", remoteRefs.length === 0, remoteRefs.join(" "));

  check("Z1 no page errors in any viewport", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
} catch (e) {
  check("UNEXPECTED", false, String(e));
} finally {
  await browser.close();
  server.close();
}

console.log(`\nAUTH ENTRY VISUAL CONTRACT: ${pass} ok / ${fail} FAIL`);
console.log(`screenshots: ${screens}`);
process.exit(fail === 0 ? 0 : 1);
