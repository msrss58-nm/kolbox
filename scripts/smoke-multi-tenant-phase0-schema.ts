/** Multi-Tenant Phase 0 (Platform Foundation) - schema-shape regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase0-schema.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase0-schema.cjs && node scripts/smoke-multi-tenant-phase0-schema.cjs
 *
 * Pure text-parse of the Phase 0 migration file, no DB connection required -
 * matches this project's own established style for schema-shape regressions
 * (see smoke-role-seed-parity.ts). Guards the specific product requirements
 * from the Phase 0 authorization: no password/credential material anywhere,
 * every identity table references auth.users, every table is RLS-enabled
 * with zero policies/grants, the multi_entity_owner singleton idiom is
 * present, and election_workspaces has no redundant derived-state column.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260823010000_multi_tenant_phase0_platform_foundation.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

// This migration's header/design-note comments deliberately discuss (in
// prose) the very words their checks below assert are absent from the
// actual SQL - "no password column", "no GRANT statement", "no CREATE
// POLICY" all legitimately contain those words as comment text. Statements
// 3/4 below must therefore run against comment-stripped SQL only, exactly
// the same fix already required once before in this project for
// smoke-role-seed-parity.ts's rollback-block false positive.
const codeOnlySql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const EXPECTED_TABLES = [
  "platform_owners",
  "election_workspaces",
  "election_workspace_pending_owner_access",
  "election_owners",
  "multi_entity_owner",
  "multi_entity_assignments",
  "platform_deletion_audit",
] as const;

function extractTableBlock(name: string): string {
  const re = new RegExp(`create table public\\.${name} \\(([\\s\\S]*?)\\n\\);`);
  const match = sql.match(re);
  assert(match !== null, `migration contains exactly one isolated create table block for "${name}"`);
  return match?.[1] ?? "";
}

// ---- 1. Every expected table exists exactly once, no unexpected extras ----
for (const name of EXPECTED_TABLES) {
  const occurrences = [...sql.matchAll(new RegExp(`create table public\\.${name} \\(`, "g"))];
  assert(occurrences.length === 1, `"${name}" appears as exactly one CREATE TABLE (got ${occurrences.length})`);
}
const allCreateTables = [...sql.matchAll(/create table public\.(\w+) \(/g)].map((m) => m[1]);
assert(
  allCreateTables.length === EXPECTED_TABLES.length,
  `migration creates exactly ${EXPECTED_TABLES.length} tables (got ${allCreateTables.length}: ${allCreateTables.join(", ")})`,
);

const blocks = Object.fromEntries(EXPECTED_TABLES.map((name) => [name, extractTableBlock(name)])) as Record<
  (typeof EXPECTED_TABLES)[number],
  string
>;

// ---- 2. Every table is RLS-enabled ----
for (const name of EXPECTED_TABLES) {
  assert(
    new RegExp(`alter table public\\.${name} enable row level security;`).test(sql),
    `"${name}" has an ENABLE ROW LEVEL SECURITY statement`,
  );
}

// ---- 3. Zero policies, zero grants in the actual SQL (comments legitimately
// discuss both words in prose - see codeOnlySql above) ----
assert(!/create policy/i.test(codeOnlySql), "migration's executable SQL contains zero CREATE POLICY statements (deny-by-default)");
assert(!/\bgrant\s/i.test(codeOnlySql), "migration's executable SQL contains zero GRANT statements (no anon/authenticated access yet)");

// ---- 4. No password/credential COLUMN in any table's column-definition
// list. Checked against `blocks` (populated below), which is already
// isolated to the text between each CREATE TABLE's parens - deliberately
// NOT checked against the whole file, since COMMENT ON TABLE ... IS '...'
// statements are real executable SQL whose descriptive string legitimately
// discusses "password" in prose (documenting its absence), same reasoning
// as the `--` comments above but for a different statement type. ----

for (const name of EXPECTED_TABLES) {
  assert(
    !/password/i.test(blocks[name]),
    `"${name}"'s column-definition list contains zero occurrences of "password" (Supabase Auth is the sole credential store)`,
  );
}

// ---- 5. Every identity table references auth.users via auth_user_id ----
for (const name of ["platform_owners", "election_owners", "multi_entity_owner", "election_workspace_pending_owner_access"] as const) {
  assert(
    /auth_user_id\s+uuid not null unique references auth\.users\(id\) on delete cascade/.test(blocks[name]),
    `"${name}" has auth_user_id uuid not null unique references auth.users(id) on delete cascade`,
  );
}

// ---- 6. election_workspace_pending_owner_access has no workspace_id column ----
assert(
  !/workspace_id/.test(blocks.election_workspace_pending_owner_access),
  "election_workspace_pending_owner_access has no workspace_id column (creating pending access must never create a workspace)",
);

// ---- 7. multi_entity_owner is a true singleton ----
assert(
  /id\s+boolean primary key default true/.test(blocks.multi_entity_owner),
  "multi_entity_owner.id is `boolean primary key default true` (singleton PK idiom)",
);
assert(
  /constraint multi_entity_owner_singleton check \(id\)/.test(blocks.multi_entity_owner),
  "multi_entity_owner has an explicit singleton CHECK constraint",
);

// ---- 8. election_workspaces has no redundant derived-state column ----
for (const forbidden of ["status", "is_active", "deleted_at"]) {
  assert(
    !new RegExp(`\\b${forbidden}\\b`).test(blocks.election_workspaces),
    `election_workspaces has no "${forbidden}" column (ACTIVE/lifecycle state is derived from election_end_at, never stored)`,
  );
}
assert(
  /election_end_at\s+timestamptz not null/.test(blocks.election_workspaces),
  "election_workspaces.election_end_at is timestamptz not null",
);

// ---- 9. Workspace-owned tables cascade-delete with their workspace ----
assert(
  /workspace_id\s+uuid not null references public\.election_workspaces\(id\) on delete cascade/.test(
    blocks.election_owners,
  ),
  "election_owners.workspace_id cascades on election_workspaces delete",
);
assert(
  /workspace_id\s+uuid not null unique references public\.election_workspaces\(id\) on delete cascade/.test(
    blocks.multi_entity_assignments,
  ),
  "multi_entity_assignments.workspace_id is UNIQUE and cascades on election_workspaces delete",
);

// ---- 10. platform_deletion_audit's workspace reference is a snapshot, not an FK ----
assert(
  /workspace_id_snapshot\s+uuid not null,/.test(blocks.platform_deletion_audit) &&
    !/workspace_id_snapshot[\s\S]*?references/.test(blocks.platform_deletion_audit.split("workspace_name_snapshot")[0] ?? ""),
  "platform_deletion_audit.workspace_id_snapshot is a plain uuid (not a foreign key) - survives its workspace's deletion",
);

// ---- 11. No table in this migration ends up with a "manager" role fallback ----
// (sanity guard against copy-paste from election_day_roles-style seed data,
// which this Phase 0 migration must never contain - no seed rows of any kind)
assert(!/insert into public\./i.test(sql), "migration contains zero INSERT statements (every table starts empty)");

if (process.exitCode) {
  console.error("\nsmoke-multi-tenant-phase0-schema: FAILED");
} else {
  console.log("\nsmoke-multi-tenant-phase0-schema: all checks passed");
}
