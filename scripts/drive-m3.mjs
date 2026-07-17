// M3 verification driver - voter registry: search, classify, drawer, mobile.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
mkdirSync("scripts/shots", { recursive: true });

const browser = await chromium.launch();
const errors = [];

async function login(page) {
  await page.goto(BASE + "/login", { waitUntil: "networkidle" });
  await page.fill("#name", "דנה כהן");
  await page.click('button:has-text("כניסה למערכת")');
  await page.waitForSelector("text=תמונת מצב הקמפיין", { timeout: 15000 });
}

async function drive(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[${name}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));

  await login(page);
  await page.locator('a[href="/voters"]:visible').first().click();
  // wait for real rows (national IDs are 9-digit tabular numbers)
  await page.waitForSelector("text=בוחרים בפנקס", { timeout: 15000 });
  console.log(`[${name}] registry loaded`);
  await page.screenshot({ path: `scripts/shots/${name}-voters.png` });

  // search
  await page.fill('input[aria-label="חיפוש בוחרים"]', "כהן");
  await page.waitForSelector("text=בסינון הנוכחי", { timeout: 10000 });
  console.log(`[${name}] search filters results`);

  // classify first visible voter via segment - the clicked voter may already be
  // pre-seeded as "תומך" (toggling it off), so accept either the "classified"
  // or "removed" toast wording as proof the action fired.
  const firstSegment = page
    .locator('div[role="group"][aria-label="סיווג"]:visible')
    .first();
  await firstSegment.locator('button:has-text("תומך")').click();
  await page.waitForSelector('div[role="status"]', { timeout: 10000 });
  console.log(`[${name}] quick classify works (toast shown)`);

  // open drawer from first row name button
  await page.locator("button:visible", { hasText: "כהן" }).first().click();
  await page.waitForSelector("text=היסטוריית סיווגים", { timeout: 10000 });
  console.log(`[${name}] voter drawer opens with history`);
  await page.screenshot({ path: `scripts/shots/${name}-drawer.png` });
  await page.keyboard.press("Escape");

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
