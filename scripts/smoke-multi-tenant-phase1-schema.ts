/** Multi-Tenant Phase 1 (additive workspace_id columns) - schema-shape
 * regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase1-schema.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase1-schema.cjs && node scripts/smoke-multi-tenant-phase1-schema.cjs
 *
 * Pure text-parse of the Phase 1 migration file, no DB connection required -
 * same style as smoke-multi-tenant-phase0-schema.ts. Guards the specific
 * product requirements from the Phase 1 authorization: exactly the 12
 * existing election_day_* tables each get exactly one NULLABLE workspace_id
 * column FK'd to election_workspaces with ON DELETE CASCADE, no NOT NULL,
 * no backfill (no UPDATE/INSERT), no RLS/policy change, no function change.
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
  "20260823020000_multi_tenant_phase1_workspace_id_columns.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

// This migration's header/design-note comments deliberately discuss (in
// prose) words like "NOT NULL", "backfill", "policy" while explaining why
// this migration does NOT do those things - so every check below runs
// against comment-stripped SQL only, same fix already required for
// smoke-multi-tenant-phase0-schema.ts and smoke-role-seed-parity.ts.
const codeOnlySql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const EXPECTED_TABLES = [
  "election_day_voters",
  "election_day_ride_status_events",
  "election_day_ride_coordinators",
  "election_day_settings",
  "election_day_permission_users",
  "election_day_coordinators",
  "election_day_coordinator_operations",
  "election_day_coordinator_operation_items",
  "election_day_roles",
  "election_day_not_voting_reasons",
  "election_day_reminder_events",
  "election_day_reauth_proofs",
] as const;

// ---- 1. Exactly one ADD COLUMN workspace_id per expected table, correctly
// nullable, correctly FK'd with ON DELETE CASCADE ----
for (const name of EXPECTED_TABLES) {
  const re = new RegExp(
    `alter table public\\.${name}\\s+add column if not exists workspace_id uuid null\\s+references public\\.election_workspaces\\(id\\) on delete cascade;`,
  );
  const occurrences = [...codeOnlySql.matchAll(new RegExp(`add column if not exists workspace_id[^;]*;`, "g"))];
  assert(
    re.test(codeOnlySql),
    `"${name}" gets exactly one nullable workspace_id column, FK'd to election_workspaces(id) ON DELETE CASCADE`,
  );
  void occurrences;
}

// ---- 2. Exactly 12 ADD COLUMN workspace_id statements total - no
// unexpected table touched, none missing ----
const allAddColumnWorkspaceId = [...codeOnlySql.matchAll(/alter table public\.(\w+)\s+add column if not exists workspace_id/g)].map(
  (m) => m[1],
);
assert(
  allAddColumnWorkspaceId.length === EXPECTED_TABLES.length,
  `migration adds workspace_id to exactly ${EXPECTED_TABLES.length} tables (got ${allAddColumnWorkspaceId.length}: ${allAddColumnWorkspaceId.join(", ")})`,
);
const unexpected = allAddColumnWorkspaceId.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t));
assert(unexpected.length === 0, `no unexpected table receives workspace_id (unexpected: ${unexpected.join(", ") || "none"})`);

// ---- 3. Exactly one CREATE INDEX on workspace_id per expected table ----
for (const name of EXPECTED_TABLES) {
  assert(
    new RegExp(`create index if not exists ${name}_workspace_id_idx\\s+on public\\.${name} \\(workspace_id\\);`).test(codeOnlySql),
    `"${name}" has a workspace_id index`,
  );
}

// ---- 4. No NOT NULL anywhere near workspace_id (must stay nullable) ----
assert(
  !/workspace_id uuid not null/.test(codeOnlySql),
  "no workspace_id column is declared NOT NULL anywhere in this migration",
);

// ---- 5. No backfill - zero UPDATE/INSERT statements ----
assert(!/\bupdate\s+public\./i.test(codeOnlySql), "migration contains zero UPDATE statements (no backfill)");
assert(!/\binsert\s+into\s+public\./i.test(codeOnlySql), "migration contains zero INSERT statements (no backfill, no seed data)");

// ---- 6. No RLS/policy change of any kind ----
assert(!/create policy/i.test(codeOnlySql), "migration contains zero CREATE POLICY statements");
assert(!/drop policy/i.test(codeOnlySql), "migration contains zero DROP POLICY statements");
assert(!/alter policy/i.test(codeOnlySql), "migration contains zero ALTER POLICY statements");
assert(!/enable row level security/i.test(codeOnlySql), "migration contains zero ENABLE ROW LEVEL SECURITY statements (no new RLS toggling)");
assert(!/disable row level security/i.test(codeOnlySql), "migration contains zero DISABLE ROW LEVEL SECURITY statements");

// ---- 7. No function/RPC change of any kind ----
assert(!/create (or replace )?function/i.test(codeOnlySql), "migration contains zero CREATE [OR REPLACE] FUNCTION statements");
assert(!/drop function/i.test(codeOnlySql), "migration contains zero DROP FUNCTION statements");

// ---- 8. No other ALTER TABLE statement types (no DROP COLUMN, no other
// ADD COLUMN besides workspace_id, no constraint drops on existing columns) ----
const alterStatements = [...codeOnlySql.matchAll(/alter table public\.\w+\s+([a-z ]+?)(?=\n|$)/gi)].map((m) => m[0]);
const nonWorkspaceIdAlters = alterStatements.filter((s) => !/add column if not exists workspace_id/i.test(s));
assert(
  nonWorkspaceIdAlters.length === 0,
  `migration's only ALTER TABLE operation is "add column if not exists workspace_id" (found ${nonWorkspaceIdAlters.length} other alter clause(s))`,
);

// ---- 9. Transactionally wrapped ----
assert(/^begin;/m.test(codeOnlySql), "migration opens with BEGIN;");
assert(/^commit;/m.test(codeOnlySql), "migration closes with COMMIT;");

if (process.exitCode) {
  console.error("\nsmoke-multi-tenant-phase1-schema: FAILED");
} else {
  console.log("\nsmoke-multi-tenant-phase1-schema: all checks passed");
}
