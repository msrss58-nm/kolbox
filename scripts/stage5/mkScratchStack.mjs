// Platform Stage 5 - builds an ISOLATED, throwaway Supabase project directory
// for the Stage 5 test suites. Never touches the repo's own supabase/ dir and
// never touches the developer's `kolbox` local stack (which holds unrelated
// leftover fixtures).
//
// Usage:  node scripts/stage5/mkScratchStack.mjs <outDir>
//         then: npx supabase start --workdir <outDir>
//
// What differs from the committed supabase/config.toml (and nothing else):
//   - project_id "kolboxs5"          -> its own Docker containers/volumes
//   - api/db/shadow ports 54721/54722/54720 -> no clash with the kolbox stack
//   - TOTP enroll+verify ENABLED     -> real aal2 sessions (Production has TOTP
//                                        enabled; the committed local config
//                                        does not, and is deliberately left
//                                        untouched - same method as Stage 2)
//   - studio/realtime/storage/analytics/edge/smtp OFF -> faster, fewer ports
//
// Every migration under supabase/migrations is copied verbatim, so
// `supabase db reset --workdir <outDir>` replays exactly the repo's history.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node scripts/stage5/mkScratchStack.mjs <outDir>");
  process.exit(2);
}
const outSupabase = path.join(path.resolve(outDir), "supabase");
if (path.resolve(outSupabase).startsWith(path.join(repoRoot, "supabase"))) {
  console.error("refusing to write inside the repo's own supabase/ directory");
  process.exit(2);
}

// S5_PORT_OFFSET (opt-in, default 0) shifts all three ports together: after a
// reboot Windows can reserve 54115-54814 for WinNAT, making the defaults
// unbindable. lib.mjs reads the same variable, so both always agree.
const PORT_OFFSET = Number(process.env.S5_PORT_OFFSET ?? 0) || 0;
export const SCRATCH_PORTS = {
  api: 54721 + PORT_OFFSET,
  db: 54722 + PORT_OFFSET,
  shadow: 54720 + PORT_OFFSET,
};
export const SCRATCH_PROJECT_ID = "kolboxs5";

// section -> { key: newValue }. Only the FIRST occurrence of a key inside its
// section is rewritten, and every expected edit must be applied (see below).
const edits = {
  "": { project_id: `"${SCRATCH_PROJECT_ID}"` },
  api: { port: String(SCRATCH_PORTS.api) },
  db: { port: String(SCRATCH_PORTS.db), shadow_port: String(SCRATCH_PORTS.shadow) },
  realtime: { enabled: "false" },
  studio: { enabled: "false" },
  local_smtp: { enabled: "false" },
  storage: { enabled: "false" },
  "storage.vector": { enabled: "false" },
  analytics: { enabled: "false" },
  edge_runtime: { enabled: "false" },
  "auth.mfa.totp": { enroll_enabled: "true", verify_enabled: "true" },
};

const src = fs.readFileSync(path.join(repoRoot, "supabase", "config.toml"), "utf8");
const applied = {};
let section = "";
const out = src.split(/\r?\n/).map((line) => {
  const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
  if (m) {
    section = m[1];
    return line;
  }
  const kv = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
  if (!kv) return line;
  const e = edits[section];
  if (!e || !(kv[2] in e)) return line;
  const key = `${section}.${kv[2]}`;
  if (applied[key]) return line;
  applied[key] = true;
  return `${kv[1]}${kv[2]}${kv[3]}${e[kv[2]]}`;
});

const expected = Object.entries(edits).flatMap(([s, o]) =>
  Object.keys(o).map((k) => `${s}.${k}`),
);
const missing = expected.filter((k) => !applied[k]);
if (missing.length) {
  console.error(`config edits not applied: ${missing.join(", ")}`);
  process.exit(1);
}

fs.rmSync(outSupabase, { recursive: true, force: true });
fs.mkdirSync(path.join(outSupabase, "migrations"), { recursive: true });
fs.writeFileSync(path.join(outSupabase, "config.toml"), out.join("\n"));

const migDir = path.join(repoRoot, "supabase", "migrations");
const migrations = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  fs.copyFileSync(path.join(migDir, f), path.join(outSupabase, "migrations", f));
}
const seed = path.join(repoRoot, "supabase", "seed.sql");
if (fs.existsSync(seed)) fs.copyFileSync(seed, path.join(outSupabase, "seed.sql"));

console.log(`scratch project written: ${outSupabase}`);
console.log(`project_id=${SCRATCH_PROJECT_ID} api=${SCRATCH_PORTS.api} db=${SCRATCH_PORTS.db}`);
console.log(`migrations copied: ${migrations.length}`);
console.log(`edits applied: ${expected.length}/${expected.length}`);
