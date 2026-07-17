// M4 verification driver - activists: podium, drawer, add flow.
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

  await page.locator('a[href="/activists"]:visible').first().click();
  await page.waitForSelector("text=פעילי שטח בקמפיין", { timeout: 15000 });
  await page
    .waitForSelector("text=התקדמות לדרגה הבאה", { timeout: 15000 })
    .catch(() => {});
  console.log(`[${name}] activists page loaded`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `scripts/shots/${name}-activists.png`, fullPage: true });

  // open drawer for the #1 activist (podium card)
  await page.locator("button", { hasText: "סיווגים" }).first().click();
  await page.waitForSelector("text=פעילות · 8 שבועות", { timeout: 10000 });
  await page.waitForSelector(".recharts-surface", { timeout: 10000 });
  console.log(`[${name}] activist drawer with activity chart`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `scripts/shots/${name}-activist-drawer.png` });
  await page.keyboard.press("Escape");

  // add activist flow
  await page.locator('button:has-text("הוספת פעיל")').first().click();
  await page.waitForSelector("text=אזור פעילות", { timeout: 10000 });
  await page.fill('input[dir="ltr"]', "052-9998877");
  const inputs = page.locator("form input");
  await inputs.nth(0).fill("נטע");
  await inputs.nth(1).fill("ברק");
  await inputs.nth(3).fill("אשקלון");
  await page.click('button:has-text("הוספה לצוות")');
  await page.waitForSelector('div[role="status"]:has-text("הצטרף לצוות")', {
    timeout: 10000,
  });
  console.log(`[${name}] add activist works (toast shown)`);

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
