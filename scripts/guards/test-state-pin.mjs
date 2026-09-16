// Test-state guard: retained suites must PIN the global module state they
// depend on, instead of inheriting whatever a previously-run suite left behind.
//
// WHY: effective module access = platform_modules.available AND the workspace's
// entitlement row (Gate 4). `available` is GLOBAL, mutable scratch state that
// several suites switch on mid-run (every scripts/budget/* suite does). A suite
// whose expectations depend on it, but which never pins it, passes or fails
// according to run ORDER. That really happened twice: stage9/db-stage9.sql
// (CAT1 + ENF1) and stage9/api-stage9.mjs (F4 + F10) - the latter without ever
// naming platform_modules, because it depended on availability only through
// module-gated login. Both rules below exist for those two real cases.
//
// Run:  node scripts/guards/test-state-pin.mjs [--root <dir>] [--json]
// Exit: 0 = every scanned suite is self-contained; 1 = at least one is not.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const rootArg = args.includes("--root") ? args[args.indexOf("--root") + 1] : null;
const ROOT = rootArg ? path.resolve(rootArg) : path.join(repoRoot, "scripts");

/** Directories holding retained suites (relative to ROOT). A new suite folder
 * must be added here, or it is not guarded. */
const SUITE_DIRS = [
  "budget",
  "platform",
  "stage5",
  "stage6",
  "stage7",
  "stage8",
  "stage8d",
  "stage9",
  "ux",
  "voter-import",
];

/** Explicit, documented exemptions. Keep this EMPTY unless a suite genuinely
 * must not pin (and say why). A suite can also exempt itself in-file with a
 * comment containing: test-state-pin: exempt - <reason> */
const ALLOWLIST = {
  // "stage9/example.mjs": "reason why this suite must not pin the flag",
};

const EXEMPT_MARKER = /test-state-pin:\s*exempt\s*-\s*(.+)/i;

/** Comments are stripped before matching, so a commented-out pin never counts
 * as a pin and prose mentioning the table never triggers a rule.
 *
 * The block-comment rule is anchored to a `/*` that OPENS a line: a mid-line
 * `/*` is almost always a glob inside prose or a string (these suites really do
 * write "scripts/budget/* suite"), and an unanchored rule swallowed everything
 * up to the next `*​/` - including a real pin. That exact false positive was
 * caught by this guard's own self-test; the fixtures keep it caught. */
function stripComments(text, ext) {
  let out = text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ");
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  if (ext === ".sql") out = out.replace(/--[^\n]*/g, " ");
  return out;
}

// A real pin: sets the GLOBAL availability flag for one catalogued module.
const PIN = /update\s+(?:public\.)?platform_modules\s+set\s+available\s*=\s*(?:true|false)\s+where\s+key\s*=\s*'[a-z_]+'/i;
// Rule A - the suite names the global catalog table at all (read or write).
const TOUCHES_CATALOG = /(?:public\.)?platform_modules/i;
// Rule B - the suite depends on the switchable module implicitly: it entitles a
// workspace to `budget`, or asserts the module-gated login refusal for it.
// `election_day` is deliberately NOT covered: its access ignores the flag
// (availability_switchable = false), so such suites need no pin.
const USES_SWITCHABLE =
  /module_key\s*(?:=|,)\s*'budget'|,\s*'budget'\s*\)|'budget'\s*\)\s*;|budget_workspace_entitled/i;
const MODULE_GATED = /MODULE_NOT_ENABLED/;
const MENTIONS_BUDGET = /'budget'/;

function scanFile(absPath, relPath) {
  const ext = path.extname(absPath);
  const raw = fs.readFileSync(absPath, "utf8");
  const code = stripComments(raw, ext);

  const exemptInFile = raw.match(EXEMPT_MARKER);
  const exemptListed = ALLOWLIST[relPath.split(path.sep).join("/")];

  const touchesCatalog = TOUCHES_CATALOG.test(code);
  const implicit = MENTIONS_BUDGET.test(code) && (USES_SWITCHABLE.test(code) || MODULE_GATED.test(code));
  if (!touchesCatalog && !implicit) return { relPath, status: "skip" };

  const reasons = [];
  if (touchesCatalog) reasons.push("references platform_modules");
  if (implicit) reasons.push("depends on the switchable module `budget` (entitlement or MODULE_NOT_ENABLED)");

  if (PIN.test(code)) return { relPath, status: "pass", why: "pins availability in its own setup", reasons };
  if (exemptInFile) return { relPath, status: "exempt", why: exemptInFile[1].trim(), reasons };
  if (exemptListed) return { relPath, status: "exempt", why: exemptListed, reasons };
  return { relPath, status: "fail", why: "no `update platform_modules set available = ... where key = '...'` pin", reasons };
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|sql)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of SUITE_DIRS) {
  const abs = path.join(ROOT, d);
  if (fs.existsSync(abs)) files.push(...walk(abs));
}
// A bare --root (the self-test's fixture dir) scans its files directly too.
if (rootArg && files.length === 0) files.push(...walk(ROOT));

const results = files
  .map((f) => scanFile(f, path.relative(ROOT, f)))
  .filter((r) => r.status !== "skip")
  .sort((a, b) => a.relPath.localeCompare(b.relPath));

const failures = results.filter((r) => r.status === "fail");

if (args.includes("--json")) {
  console.log(JSON.stringify({ results, failures: failures.length }, null, 2));
} else {
  for (const r of results) {
    const tag = r.status === "pass" ? "ok      " : r.status === "exempt" ? "exempt  " : "FAIL    ";
    console.log(`${tag}${r.relPath.split(path.sep).join("/")}  (${r.reasons.join("; ")})`);
    if (r.status !== "pass") console.log(`          -> ${r.why}`);
  }
  console.log(
    `\nTEST-STATE PIN GUARD: ${results.length - failures.length} ok / ${failures.length} FAIL (${results.length} suites reference shared module state)`,
  );
  if (failures.length > 0) {
    console.log(
      "\nA flagged suite must pin the state its expectations depend on, e.g. in its own SETUP:\n" +
        "  update public.platform_modules set available = false where key = 'budget';\n" +
        "or declare an explicit exemption comment: test-state-pin: exempt - <reason>",
    );
  }
}

process.exit(failures.length > 0 ? 1 : 0);
