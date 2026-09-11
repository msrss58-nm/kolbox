// Platform Stage 7 - dashboard bundle isolation, asserted on the ACTUAL built
// JavaScript produced by scripts/stage5/bundle-isolation.mjs (run that first;
// this script reuses its output instead of building four surfaces again).
//
// Run: node scripts/stage7/bundle-stage7.mjs <outRoot passed to bundle-isolation.mjs>
//
// The dashboard's copy and its aggregate endpoints must ship ONLY in the
// multi_entity surface; the router's build-time surface ternary drops them
// everywhere else.
import fs from "node:fs";
import path from "node:path";

const outRoot = process.argv[2];
if (!outRoot) {
  console.error("usage: node scripts/stage7/bundle-stage7.mjs <bundle-isolation outRoot>");
  process.exit(2);
}

const MARKERS = [
  "סיכום המערכות המדווחות",
  "פעילה · נתונים מוסתרים",
  "/api/multi-entity/aggregates",
  "/api/multi-entity/workspace-aggregates",
];

let pass = 0;
let fail = 0;
for (const surface of ["election", "platform", "both", "multi_entity"]) {
  const assets = path.join(outRoot, surface, "assets");
  const js = fs
    .readdirSync(assets)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(assets, f), "utf8"))
    .join("\n");
  for (const marker of MARKERS) {
    const present = js.includes(marker);
    const ok = surface === "multi_entity" ? present : !present;
    ok ? pass++ : fail++;
    console.log(`  [${ok ? "PASS" : "**FAIL**"}] ${surface} ${surface === "multi_entity" ? "contains" : "does NOT contain"} ${marker}`);
  }
}
console.log(`\nSTAGE7-BUNDLE SUMMARY: ${pass} PASS / ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;
