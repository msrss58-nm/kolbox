// Platform Stage 5 - builds all FOUR surfaces and proves route/credential-form
// isolation against the ACTUAL built JavaScript (not the source).
//
// Run: node scripts/stage5/bundle-isolation.mjs [outRoot]
//
// Markers are user-visible login-form titles. Each is referenced only by its
// own principal's screen components, which the router's build-time surface
// ternary keeps or drops. Auth-client MODULES are side-effectful and are
// present on every surface (pre-existing, documented) - the storage keys are
// reported for information, not asserted absent.
//
// `meLogin` is the one marker asserted absent from EVERY surface, its own
// included. The per-origin Multi-Entity login was RETIRED (2026-09-24): a
// Multi-Entity Owner signs in with a username, only the shared login resolves
// one, `MultiEntityOwnerLoginScreen` was deleted and /multi-entity/login now
// renders `PlatformOriginRedirect target="sharedLogin"` with no credential
// field. The title survives only as dead copy in
// multi-entity-owner.constants.ts, which nothing references, so it is
// tree-shaken out of the bundle. Its ABSENCE is the shipped, verified
// behaviour - do not "restore" this expectation.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outRoot = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "kolbox-stage5-bundles"));

const MARK = {
  meLogin: "כניסת בעל רב-מערכות",
  meHome: "המערכות שלי",
  platformLogin: "כניסת בעל הפלטפורמה",
  electionDayLogin: "כניסה למערכת הבחירות",
  electionOwnerLogin: "כניסת בעלים",
};

// surface -> markers that MUST be present / MUST be absent
const EXPECT = {
  election: {
    present: ["electionDayLogin", "electionOwnerLogin"],
    absent: ["meLogin", "meHome", "platformLogin"],
  },
  platform: { present: ["platformLogin"], absent: ["meLogin", "meHome"] },
  both: {
    present: ["electionDayLogin", "electionOwnerLogin", "platformLogin"],
    absent: ["meLogin", "meHome"],
  },
  multi_entity: {
    // `meHome` - the dashboard heading - is what proves this IS the
    // Multi-Entity surface. `meLogin` joins the absent list: the retired login
    // screen must not reappear here either, which is a stricter assertion than
    // requiring it, not a looser one.
    present: ["meHome"],
    absent: ["meLogin", "platformLogin", "electionDayLogin", "electionOwnerLogin"],
  },
};

const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
let pass = 0;
let fail = 0;
const results = {};

for (const surface of Object.keys(EXPECT)) {
  const outDir = path.join(outRoot, surface);
  execFileSync(process.execPath, [viteBin, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
    cwd: repoRoot,
    env: { ...process.env, VITE_APP_SURFACE: surface },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const assets = path.join(outDir, "assets");
  const js = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(assets, f), "utf8"))
    .join("\n");
  results[surface] = js;
  console.log(`\n=== ${surface} (${(js.length / 1024).toFixed(0)} KiB JS) ===`);
  for (const key of EXPECT[surface].present) {
    const ok = js.includes(MARK[key]);
    ok ? pass++ : fail++;
    console.log(`  [${ok ? "PASS" : "**FAIL**"}] contains ${key}`);
  }
  for (const key of EXPECT[surface].absent) {
    const ok = !js.includes(MARK[key]);
    ok ? pass++ : fail++;
    console.log(`  [${ok ? "PASS" : "**FAIL**"}] does NOT contain ${key}`);
  }
  const keysPresent = ["kb-multi-entity-owner-auth-token", "kb-platform-owner-auth-token", "kb-owner-auth-token"]
    .filter((k) => js.includes(k))
    .join(", ");
  console.log(`  [info] auth-client storage keys present (plumbing, pre-existing pattern): ${keysPresent}`);
}

console.log(`\nBUNDLE-ISOLATION SUMMARY: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;
