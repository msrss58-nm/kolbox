// M2 verification driver - dashboard KPIs + charts.
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
  await page.fill("#name", "דנה כהן");
  await page.click('button:has-text("כניסה למערכת")');

  await page.waitForSelector("text=יעד הקמפיין", { timeout: 15000 });
  await page.waitForSelector("text=מובילי הסיווגים", { timeout: 15000 });
  await page.waitForSelector("text=תומכים לפי עיר", { timeout: 15000 });
  // charts are SVG - wait for recharts surfaces
  await page.waitForSelector(".recharts-surface", { timeout: 15000 });
  const chartCount = await page.locator(".recharts-surface").count();
  console.log(`[${name}] dashboard loaded with ${chartCount} chart surfaces`);
  await page.waitForTimeout(1200); // let count-up + chart animations settle
  await page.screenshot({ path: `scripts/shots/${name}-dash.png`, fullPage: true });
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
