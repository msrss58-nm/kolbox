// M1 verification driver - login flow + shell, desktop & mobile screenshots.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

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
  await page.waitForSelector("text=ברוכים הבאים לקולבוקס", { timeout: 15000 });
  const dir = await page.evaluate(() => document.documentElement.dir);
  console.log(`[${name}] login rendered, dir=${dir}`);
  await page.screenshot({ path: `scripts/shots/${name}-login.png`, fullPage: false });

  await page.fill("#name", "דנה כהן");
  await page.click('button:has-text("מנהל קמפיין")');
  await page.click('button:has-text("כניסה למערכת")');
  await page.waitForSelector("text=תמונת מצב הקמפיין", { timeout: 15000 });
  console.log(`[${name}] logged in → dashboard placeholder visible`);
  await page.screenshot({ path: `scripts/shots/${name}-dashboard.png` });

  // nav to voters via the visible nav (bottom nav on mobile, sidebar on desktop)
  await page.locator('a[href="/voters"]:visible').first().click();
  await page.waitForSelector("text=פנקס הבוחרים", { timeout: 10000 });
  console.log(`[${name}] nav → voters works`);
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
