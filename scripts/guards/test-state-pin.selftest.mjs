// Self-test for scripts/guards/test-state-pin.mjs.
//
// Builds throwaway fixture suites in a temp directory and asserts the guard's
// verdict on each, then asserts the guard passes over the real repo. The
// "broken" fixture is a faithful reduction of the REAL stage9/api-stage9.mjs
// defect (module-gated login + a budget entitlement, no availability pin).
//
// Run:  node scripts/guards/test-state-pin.selftest.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const guard = path.join(here, "test-state-pin.mjs");

let failed = 0;
const check = (id, ok, detail = "") => {
  console.log(`  [${ok ? "PASS" : "**FAIL**"}] ${id}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failed++;
};

function runGuard(root) {
  try {
    const out = execFileSync(process.execPath, [guard, "--root", root, "--json"], { encoding: "utf8" });
    return { exit: 0, json: JSON.parse(out) };
  } catch (e) {
    return { exit: e.status ?? 1, json: JSON.parse(e.stdout || "{}") };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kolbox-state-pin-"));
const dir = path.join(tmp, "stage9");
fs.mkdirSync(dir, { recursive: true });

// 1. BROKEN: the real defect shape - budget entitlement + module-gated login
//    assertion, no pin anywhere.
fs.writeFileSync(
  path.join(dir, "broken.mjs"),
  `psql("insert into public.election_workspace_modules (workspace_id, module_key) values (ws, 'budget');");
const lg = await puLogin(code, "u", pw);
check("F4 budget-only workspace login refused", lg.error === "MODULE_NOT_ENABLED");
`,
);

// 2. PINNED: identical, plus the pin in setup.
fs.writeFileSync(
  path.join(dir, "pinned.mjs"),
  `psql(\`update public.platform_modules set available = false where key = 'budget';\`);
psql("insert into public.election_workspace_modules (workspace_id, module_key) values (ws, 'budget');");
const lg = await puLogin(code, "u", pw);
check("F4 budget-only workspace login refused", lg.error === "MODULE_NOT_ENABLED");
`,
);

// 3. EXEMPT: legitimately unpinned, self-documented.
fs.writeFileSync(
  path.join(dir, "exempt.mjs"),
  `// test-state-pin: exempt - drives availability through the product op itself and asserts both states
psql("insert into public.election_workspace_modules (workspace_id, module_key) values (ws, 'budget');");
check("X1 module-gated login refused", r.error === "MODULE_NOT_ENABLED");
`,
);

// 4. UNRELATED: election_day only - its access ignores the flag, so no pin needed.
fs.writeFileSync(
  path.join(dir, "unrelated.mjs"),
  `psql("insert into public.election_workspace_modules (workspace_id, module_key) values (ws, 'election_day');");
check("E1 election day login works", r.status === 200);
`,
);

// 5. COMMENTED-OUT PIN: prose/commented pin must NOT count as pinned.
fs.writeFileSync(
  path.join(dir, "commented.mjs"),
  `// update public.platform_modules set available = false where key = 'budget';
psql("select available from public.platform_modules where key = 'budget';");
check("C1 reads global availability", true);
`,
);

// 6. BLOCK-COMMENTED PIN: must not count as a pin either.
fs.writeFileSync(
  path.join(dir, "blockcomment.mjs"),
  `/* update public.platform_modules set available = false where key = 'budget'; */
psql("select available from public.platform_modules where key = 'budget';");
check("B1 reads global availability", true);
`,
);

// 7. GLOB IN PROSE + a real pin: a mid-line "/*" (e.g. "scripts/budget/* suite")
//    must not be treated as a block comment that swallows the pin. This is the
//    real false positive this guard hit on stage9/api-stage9.mjs.
fs.writeFileSync(
  path.join(dir, "globpath.mjs"),
  `psql(\\\`
  -- every scripts/budget/* suite switches it on mid-run, so pin it here
  update public.platform_modules set available = false where key = 'budget';
  delete from public.election_day_login_attempts;
\\\`);
check("P1 pinned suite", true);
`,
);

console.log("=== guard verdicts on the fixtures");
const r = runGuard(tmp);
const by = Object.fromEntries((r.json.results ?? []).map((x) => [x.relPath.split(path.sep).join("/"), x]));
check("G1 the broken suite (real defect shape) FAILS", by["stage9/broken.mjs"]?.status === "fail", by["stage9/broken.mjs"]?.status);
check("G2 the pinned suite passes", by["stage9/pinned.mjs"]?.status === "pass", by["stage9/pinned.mjs"]?.status);
check("G3 the explicitly exempt suite passes as 'exempt'", by["stage9/exempt.mjs"]?.status === "exempt", by["stage9/exempt.mjs"]?.status);
check("G4 an election_day-only suite is not flagged at all", by["stage9/unrelated.mjs"] === undefined, by["stage9/unrelated.mjs"]?.status ?? "skipped");
check("G5 a COMMENTED-OUT pin does not count as a pin", by["stage9/commented.mjs"]?.status === "fail", by["stage9/commented.mjs"]?.status);
check("G6 the guard exits non-zero when any suite is unpinned", r.exit === 1, String(r.exit));
check("G9 a BLOCK-commented pin does not count as a pin", by["stage9/blockcomment.mjs"]?.status === "fail", by["stage9/blockcomment.mjs"]?.status);
check("G10 a mid-line glob in prose (scripts/budget/*) does not hide a real pin", by["stage9/globpath.mjs"]?.status === "pass", by["stage9/globpath.mjs"]?.status);

console.log("=== guard verdict on the real repository");
const real = runGuard(path.join(repoRoot, "scripts"));
const realFails = (real.json.results ?? []).filter((x) => x.status === "fail");
check("G7 every retained suite in this repo is pinned or exempt", real.exit === 0 && realFails.length === 0,
  realFails.map((x) => x.relPath).join(", ") || "0 failures");
check("G8 the guard actually scanned the real suites (>= 10 flagged references)",
  (real.json.results ?? []).length >= 10, String((real.json.results ?? []).length));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nTEST-STATE PIN SELF-TEST: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exit(failed > 0 ? 1 : 0);
