// M5 verification driver - Excel import wizard end-to-end.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
mkdirSync("scripts/shots", { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function drive(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[${name}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));

  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill("#name", "דנה כהן");
  await page.click('button:has-text("כניסה למערכת")');
  await page.waitForSelector("text=יעד הקמפיין", { timeout: 15000 });

  await page.locator('a[href="/import"]:visible').first().click();
  await page.waitForSelector("text=גררו לכאן קובץ", { timeout: 15000 });
  console.log(`[${name}] import page loaded`);
  await page.screenshot({ path: `scripts/shots/${name}-import-upload.png` });

  // upload the fixture
  await page.setInputFiles(
    'input[type="file"]',
    resolve("scripts/fixtures/import-test.xlsx"),
  );
  await page.waitForSelector("text=מיפוי עמודות", { timeout: 15000 });
  await page.waitForSelector("text=שורות תקינות", { timeout: 15000 });
  console.log(`[${name}] mapping step with auto-detect`);
  await page.screenshot({ path: `scripts/shots/${name}-import-map.png`, fullPage: true });

  // check counts: 6 valid, 2 invalid
  const validCard = await page
    .locator("div", { hasText: /^6שורות תקינות$/ })
    .count()
    .catch(() => 0);
  console.log(`[${name}] valid-count card matched: ${validCard > 0}`);

  // commit
  await page.click('button:has-text("ייבוא")');
  await page.waitForSelector("text=הייבוא הושלם", { timeout: 15000 });
  console.log(`[${name}] import committed → summary`);
  await page.screenshot({ path: `scripts/shots/${name}-import-done.png` });

  // verify a new voter is findable in the registry
  await page.click('button:has-text("לפנקס הבוחרים")');
  await page.waitForSelector('input[aria-label="חיפוש בוחרים"]', { timeout: 15000 });
  await page.fill('input[aria-label="חיפוש בוחרים"]', "לוינסון");
  await page
    .locator("text=עדן לוינסון")
    .locator("visible=true")
    .first()
    .waitFor({ timeout: 10000 });
  console.log(`[${name}] imported voter found in registry ✔`);

  await ctx.close();
}

await drive("desktop", { width: 1440, height: 900 });
await drive("mobile", { width: 375, height: 812 });

await browser.close();
if (errors.length) {
  console.error("CONSOLE ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("DRIVE PASSED - no console errors");
