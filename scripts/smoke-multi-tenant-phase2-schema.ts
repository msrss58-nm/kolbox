/** Multi-Tenant Phase 2 (historical Backfill RPC) - schema-shape regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-schema.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-schema.cjs && node scripts/smoke-multi-tenant-phase2-schema.cjs
 *
 * Pure text-parse of the Phase 2 migration file, no DB connection required -
 * same style as smoke-multi-tenant-phase0-schema.ts /
 * smoke-multi-tenant-phase1-schema.ts. Guards the specific product
 * requirements from the Phase 2 authorization: exactly one new RPC, granted
 * only to service_role (never anon/authenticated), idempotency-guarded,
 * touches exactly the 12 Phase-1 tables' workspace_id columns (no NOT NULL,
 * no PK/structural change to election_day_settings, no RLS policy change,
 * no auth.* write, no hardcoded UUID).
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
  "20260824010000_multi_tenant_phase2_historical_backfill_rpc.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

const codeOnlySql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const EXPECTED_TABLES = [
  "election_day_settings",
  "election_day_voters",
  "election_day_ride_status_events",
  "election_day_ride_coordinators",
  "election_day_permission_users",
  "election_day_coordinators",
  "election_day_coordinator_operations",
  "election_day_coordinator_operation_items",
  "election_day_roles",
  "election_day_not_voting_reasons",
  "election_day_reminder_events",
  "election_day_reauth_proofs",
] as const;

// ---- 1. Exactly one function definition ----
const functionDefs = [...codeOnlySql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1]);
assert(functionDefs.length === 1, `migration defines exactly one function (got ${functionDefs.length}: ${functionDefs.join(", ")})`);
assert(functionDefs[0] === "election_day_backfill_historical_workspace", "the one function is named election_day_backfill_historical_workspace");

// ---- 2. Grants: REVOKE from PUBLIC, GRANT only to service_role - never
// anon/authenticated ----
assert(/revoke all on function public\.election_day_backfill_historical_workspace/.test(codeOnlySql), "function is REVOKEd from PUBLIC");
assert(
  /grant execute on function public\.election_day_backfill_historical_workspace\([^)]*\) to service_role;/.test(codeOnlySql),
  "function is GRANTed execute to service_role",
);
assert(!/to anon/i.test(codeOnlySql), "function is never granted to anon");
assert(!/to authenticated/i.test(codeOnlySql), "function is never granted to authenticated");

// ---- 3. Idempotency guard present ----
assert(/hashtext\('election_day_historical_backfill'\)/.test(codeOnlySql), "acquires a fixed-key advisory lock for the historical backfill");
assert(/raise exception 'HISTORICAL_WORKSPACE_ALREADY_EXISTS'/.test(codeOnlySql), "raises HISTORICAL_WORKSPACE_ALREADY_EXISTS if a workspace already exists");
assert(/raise exception 'OWNER_AUTH_USER_ALREADY_LINKED'/.test(codeOnlySql), "raises OWNER_AUTH_USER_ALREADY_LINKED if the auth_user_id is already linked");
assert(
  /if exists \(select 1 from public\.election_workspaces\) then/.test(codeOnlySql),
  "guards against a second workspace via an existence check on election_workspaces",
);

// ---- 4. Exactly one workspace insert, exactly one owner insert ----
const workspaceInserts = [...codeOnlySql.matchAll(/insert into public\.election_workspaces/g)];
assert(workspaceInserts.length === 1, `exactly one INSERT into election_workspaces (got ${workspaceInserts.length})`);
const ownerInserts = [...codeOnlySql.matchAll(/insert into public\.election_owners/g)];
assert(ownerInserts.length === 1, `exactly one INSERT into election_owners (got ${ownerInserts.length})`);

// ---- 5. Exactly one UPDATE ... workspace_id per expected table, all
// guarded by "where workspace_id is null" (never unconditional) ----
for (const name of EXPECTED_TABLES) {
  const re = new RegExp(`update public\\.${name}\\s+set workspace_id = v_workspace_id\\s+where workspace_id is null;`);
  assert(re.test(codeOnlySql), `"${name}" gets exactly one UPDATE ... SET workspace_id ... WHERE workspace_id IS NULL`);
}
const allUpdates = [...codeOnlySql.matchAll(/update public\.(\w+)\s+set workspace_id/g)].map((m) => m[1]);
assert(allUpdates.length === EXPECTED_TABLES.length, `exactly ${EXPECTED_TABLES.length} UPDATE statements total (got ${allUpdates.length}: ${allUpdates.join(", ")})`);
const unexpected = allUpdates.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t));
assert(unexpected.length === 0, `no unexpected table is updated (unexpected: ${unexpected.join(", ") || "none"})`);

// ---- 6. No NOT NULL / PK / structural change anywhere ----
assert(!/workspace_id uuid not null/i.test(codeOnlySql), "no workspace_id column is set NOT NULL");
assert(!/alter table/i.test(codeOnlySql), "migration contains zero ALTER TABLE statements (no PK/structural change)");
assert(!/drop constraint/i.test(codeOnlySql), "migration contains zero DROP CONSTRAINT statements");

// ---- 7. No RLS/policy change ----
assert(!/create policy/i.test(codeOnlySql), "migration contains zero CREATE POLICY statements");
assert(!/drop policy/i.test(codeOnlySql), "migration contains zero DROP POLICY statements");
assert(!/enable row level security/i.test(codeOnlySql), "migration contains zero ENABLE ROW LEVEL SECURITY statements");
assert(!/disable row level security/i.test(codeOnlySql), "migration contains zero DISABLE ROW LEVEL SECURITY statements");

// ---- 8. Never touches auth.* directly, never hardcodes a UUID literal ----
assert(!/\bauth\.users\b/i.test(codeOnlySql), "migration never references auth.users directly (auth_user_id is a plain parameter)");
assert(!/insert into auth\./i.test(codeOnlySql), "migration contains zero INSERT INTO auth.* statements");
assert(
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(codeOnlySql),
  "migration contains zero hardcoded UUID literals",
);

// ---- 9. Function is SECURITY DEFINER - verified live that service_role
// (the only approved caller) holds no direct SELECT/INSERT/UPDATE grants on
// these tables (only REFERENCES/TRIGGER/TRUNCATE), so the function must run
// with its owner's (postgres) privileges, matching this project's
// established pattern (e.g. election_day_import_voters_v2) ----
assert(/security definer/.test(codeOnlySql), "function is SECURITY DEFINER");
assert(!/security invoker/.test(codeOnlySql), "function is not SECURITY INVOKER");
assert(/set search_path = ''/.test(codeOnlySql), "function pins search_path to '' (current Supabase/Postgres SECURITY DEFINER hardening guidance)");
assert(!/set search_path = public\b/.test(codeOnlySql), "function does not use the weaker `search_path = public` form");

// ---- 10. Every built-in FUNCTION call this function makes is explicitly
// pg_catalog-qualified (belt-and-suspenders under an empty search_path) -
// except trim(...), which is deliberately left unqualified: it's
// SQL-standard TRIM(...) parser grammar, not a real pg_catalog.trim/1
// function (verified live - only btrim/1,2 exist), so it is inherently
// immune to search_path resolution and pg_catalog.trim(...) would actually
// fail with "function does not exist" ----
for (const fn of ["hashtext", "jsonb_build_object", "length"]) {
  const unqualified = new RegExp(`(?<!pg_catalog\\.)\\b${fn}\\(`, "g");
  const matches = [...codeOnlySql.matchAll(unqualified)];
  assert(matches.length === 0, `every call to ${fn}(...) is qualified as pg_catalog.${fn}(...) (found ${matches.length} unqualified)`);
  assert(new RegExp(`pg_catalog\\.${fn}\\(`).test(codeOnlySql), `at least one pg_catalog.${fn}(...) call is present`);
}
assert(!/pg_catalog\.trim\(/.test(codeOnlySql), "trim(...) is NOT qualified as pg_catalog.trim(...) - that function doesn't exist (only btrim does)");
assert(/\btrim\(/.test(codeOnlySql), "plain trim(...) (SQL-standard TRIM syntax, inherently search_path-immune) is used");

if (process.exitCode) {
  console.error("\nsmoke-multi-tenant-phase2-schema: FAILED");
} else {
  console.log("\nsmoke-multi-tenant-phase2-schema: all checks passed");
}
