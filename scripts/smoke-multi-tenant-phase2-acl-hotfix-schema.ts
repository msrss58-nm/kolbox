/** Multi-Tenant Phase 2 - ACL hotfix schema-shape regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-acl-hotfix-schema.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-acl-hotfix-schema.cjs && node scripts/smoke-multi-tenant-phase2-acl-hotfix-schema.cjs
 *
 * Pure text-parse of the hotfix migration file, no DB connection required -
 * same style as the other multi-tenant schema regressions. Guards the
 * specific hotfix requirements: exactly the 4 required REVOKE/GRANT
 * statements against the exact function signature, nothing else - no
 * CREATE/ALTER/DROP FUNCTION, no ALTER DEFAULT PRIVILEGES, no table/data
 * statement of any kind, no RLS/policy change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const MIGRATION_PATH = join(__dirname, "..", "supabase", "migrations", "20260824020000_multi_tenant_phase2_backfill_rpc_acl_hotfix.sql");
const sql = readFileSync(MIGRATION_PATH, "utf8");

const codeOnlySql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const SIG = "public.election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text)";

// ---- 1. Exactly the 4 required statements, in the exact form specified ----
assert(codeOnlySql.includes(`revoke execute on function ${SIG} from public;`), "REVOKEs execute from PUBLIC on the exact signature");
assert(codeOnlySql.includes(`revoke execute on function ${SIG} from anon;`), "REVOKEs execute from anon on the exact signature");
assert(codeOnlySql.includes(`revoke execute on function ${SIG} from authenticated;`), "REVOKEs execute from authenticated on the exact signature");
assert(codeOnlySql.includes(`grant execute on function ${SIG} to service_role;`), "GRANTs execute to service_role on the exact signature");

// ---- 2. Exactly 4 REVOKE/GRANT statements total - nothing extra ----
const revokeCount = [...codeOnlySql.matchAll(/\brevoke\b/gi)].length;
const grantCount = [...codeOnlySql.matchAll(/\bgrant\b/gi)].length;
assert(revokeCount === 3, `exactly 3 REVOKE statements (got ${revokeCount})`);
assert(grantCount === 1, `exactly 1 GRANT statement (got ${grantCount})`);

// ---- 3. No function body/definition change of any kind ----
assert(!/create (or replace )?function/i.test(codeOnlySql), "migration contains zero CREATE [OR REPLACE] FUNCTION statements");
assert(!/drop function/i.test(codeOnlySql), "migration contains zero DROP FUNCTION statements");
assert(!/alter function/i.test(codeOnlySql), "migration contains zero ALTER FUNCTION statements");

// ---- 4. No global default-privilege change (deliberately out of scope) ----
assert(!/alter default privileges/i.test(codeOnlySql), "migration contains zero ALTER DEFAULT PRIVILEGES statements");

// ---- 5. No table/data/RLS/policy statement of any kind ----
assert(!/\bcreate table\b/i.test(codeOnlySql), "migration contains zero CREATE TABLE statements");
assert(!/\balter table\b/i.test(codeOnlySql), "migration contains zero ALTER TABLE statements");
assert(!/\binsert into\b/i.test(codeOnlySql), "migration contains zero INSERT statements");
assert(!/\bupdate\s+public\./i.test(codeOnlySql), "migration contains zero UPDATE statements");
assert(!/create policy/i.test(codeOnlySql), "migration contains zero CREATE POLICY statements");
assert(!/enable row level security/i.test(codeOnlySql), "migration contains zero ENABLE ROW LEVEL SECURITY statements");

// ---- 6. Never grants to anon/authenticated (the whole point of this fix) ----
assert(!/to anon\b/i.test(codeOnlySql), "migration never grants anything to anon");
assert(!/to authenticated\b/i.test(codeOnlySql), "migration never grants anything to authenticated");

if (process.exitCode) {
  console.error("\nsmoke-multi-tenant-phase2-acl-hotfix-schema: FAILED");
} else {
  console.log("\nsmoke-multi-tenant-phase2-acl-hotfix-schema: all checks passed");
}
