/** Multi-Tenant Phase 2 - Contract step schema-shape regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-contract-schema.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-contract-schema.cjs && node scripts/smoke-multi-tenant-phase2-contract-schema.cjs
 *
 * Section 1 is a pure text-parse of the Contract migration file, no DB
 * connection required - same style as smoke-multi-tenant-phase2-schema.ts /
 * -acl-hotfix-schema.ts. Guards the specific Contract requirements: exactly
 * one statement, an exact-signature `DROP FUNCTION IF EXISTS`, no CASCADE,
 * nothing else (no data mutation, no unrelated ACL/schema change).
 *
 * Section 2 is one documented exception to "no DB connection required" -
 * same pattern as the live section of smoke-multi-tenant-phase2-backfill-
 * safety.ts. It queries a LOCAL disposable Supabase stack only (`supabase
 * db query --local`, never `--linked` - this file must never be able to
 * reach Production) to prove that after every migration in this repo is
 * applied to a fresh database, the Backfill RPC is genuinely absent and
 * nothing else in `public` was unexpectedly dropped alongside it. Requires
 * a local Supabase stack already started and reset (`supabase start` then
 * `supabase db reset`) - not run automatically by any other script.
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { invokeSupabaseCli } from "./lib/supabaseCliQuery";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ============================================================================
// Section 1 - pure text-parse of the Contract migration file
// ============================================================================

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260825000000_multi_tenant_phase2_contract_backfill_rpc_removal.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

const codeOnlySql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const SIG = "uuid, text, timestamptz, text, text, text";

// ---- 1. Exactly one statement: the exact-signature DROP FUNCTION IF EXISTS ----
assert(
  new RegExp(
    `drop function if exists public\\.election_day_backfill_historical_workspace\\(\\s*${SIG}\\s*\\);`,
  ).test(codeOnlySql),
  "migration contains the exact-signature DROP FUNCTION IF EXISTS statement",
);
const statementCount = codeOnlySql
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0).length;
assert(
  statementCount === 1,
  `migration contains exactly one SQL statement (got ${statementCount})`,
);

// ---- 2. No CASCADE ----
assert(!/cascade/i.test(codeOnlySql), "migration does not use CASCADE");

// ---- 3. Nothing else - no data mutation, no unrelated ACL/schema change ----
assert(
  !/create (or replace )?function/i.test(codeOnlySql),
  "migration contains zero CREATE [OR REPLACE] FUNCTION statements",
);
assert(
  !/\balter\b/i.test(codeOnlySql),
  "migration contains zero ALTER statements of any kind",
);
assert(!/\bgrant\b/i.test(codeOnlySql), "migration contains zero GRANT statements");
assert(!/\brevoke\b/i.test(codeOnlySql), "migration contains zero REVOKE statements");
assert(
  !/\binsert into\b/i.test(codeOnlySql),
  "migration contains zero INSERT statements",
);
assert(
  !/\bupdate\s+public\./i.test(codeOnlySql),
  "migration contains zero UPDATE statements",
);
assert(
  !/\bdelete from\b/i.test(codeOnlySql),
  "migration contains zero DELETE statements",
);
assert(
  !/create policy|drop policy|row level security/i.test(codeOnlySql),
  "migration contains zero RLS/policy statements",
);
assert(
  !/drop table|create table/i.test(codeOnlySql),
  "migration contains zero table-level statements",
);

if (process.exitCode) {
  console.error(
    "\nsmoke-multi-tenant-phase2-contract-schema (Section 1 - text-parse): FAILED",
  );
} else {
  console.log(
    "\nsmoke-multi-tenant-phase2-contract-schema (Section 1 - text-parse): all checks passed",
  );
}

// ============================================================================
// Section 2 - live proof against a LOCAL disposable stack only
// ============================================================================

// The exact 85 `public` functions expected to remain after every migration in
// this repo applies to a fresh database. Originally a 54-name snapshot
// captured immediately before the Phase 2 Contract migration
// (20260825000000) - re-captured live against a freshly-reset local stack as
// of the Phase 3 Contract migration (20260830000000_election_day_phase3_
// contract_v2_rpc_removal.sql), which is the most recent migration to change
// the public function set (drops the 12 legacy `_v2` RPCs whose frontend
// callers were fully cut over to trusted v3/owner-v3 - Users/Roles/
// Coordinator-Allocation/Import; the 40 `_core`/`_v3`/`_owner_v3`/session/
// reauth functions added by the intervening Multi-Tenant Phase 3
// (workspace/session/owner-trust) migrations are also reflected here for the
// first time in this file). `election_day_login_v2`/`election_day_logout_v2`
// remain - they are the live session RPCs (api/election-day/session.ts),
// deliberately not part of the Phase 3 Contract. Hardcoded deliberately, same
// convention as EXPECTED_TABLES in smoke-multi-tenant-phase2-schema.ts - a
// schema-shape regression is supposed to need a conscious update when the
// shape it guards changes.
const EXPECTED_REMAINING_FUNCTIONS = [
  "election_day_apply_initial_allocation",
  "election_day_apply_initial_allocation_core",
  "election_day_apply_initial_allocation_owner_v3",
  "election_day_apply_initial_allocation_v3",
  "election_day_cancel_reminder",
  "election_day_clear_voter_domain_for_workspace",
  "election_day_clear_voters_owner_v3",
  "election_day_clear_voters_v3",
  "election_day_clone_role",
  "election_day_clone_role_owner_v3",
  "election_day_close_reminder",
  "election_day_coordinator_participated",
  "election_day_create_non_voting_reason",
  "election_day_create_permission_user",
  "election_day_create_permission_user_v3",
  "election_day_create_role",
  "election_day_create_role_owner_v3",
  "election_day_delete_non_voting_reason",
  "election_day_delete_permission_user",
  "election_day_delete_permission_user_v3",
  "election_day_delete_role",
  "election_day_delete_role_owner_v3",
  "election_day_end_coordinator_activity",
  "election_day_end_coordinator_activity_core",
  "election_day_end_coordinator_activity_owner_v3",
  "election_day_end_coordinator_activity_v3",
  "election_day_extend_call_attempts_threshold",
  "election_day_extend_no_answer_streak_threshold",
  "election_day_has_allocation_activity",
  "election_day_has_allocation_activity_for_workspace",
  "election_day_import_voters",
  "election_day_import_voters_core",
  "election_day_import_voters_owner_v3",
  "election_day_import_voters_v3",
  "election_day_increment_call_attempts",
  "election_day_is_valid_permission",
  "election_day_list_coordinators_core",
  "election_day_list_coordinators_owner_v3",
  "election_day_list_coordinators_v3",
  "election_day_list_non_voting_reasons",
  "election_day_list_permission_users",
  "election_day_list_permission_users_v3",
  "election_day_list_roles",
  "election_day_list_roles_owner_v3",
  "election_day_list_roles_v3",
  "election_day_login",
  "election_day_login_v2",
  "election_day_logout_v2",
  "election_day_manage_coordinators",
  "election_day_manage_coordinators_core",
  "election_day_manage_coordinators_owner_v3",
  "election_day_manage_coordinators_v3",
  "election_day_owner_reauth",
  "election_day_reauth",
  "election_day_reauth_v3",
  "election_day_rebalance_assignments",
  "election_day_rebalance_assignments_core",
  "election_day_rebalance_assignments_owner_v3",
  "election_day_rebalance_assignments_v3",
  "election_day_record_call_answered",
  "election_day_record_no_answer",
  "election_day_register_login_attempt",
  "election_day_reorder_non_voting_reasons",
  "election_day_reset_permission_user_password",
  "election_day_reset_permission_user_password_v3",
  "election_day_resolve_owner_context",
  "election_day_resolve_session",
  "election_day_revoke_reauth_proof",
  "election_day_set_non_voting_reason",
  "election_day_set_non_voting_reason_active",
  "election_day_set_reminder",
  "election_day_set_updated_at",
  "election_day_set_voted",
  "election_day_sync_coordinators_from_voters",
  "election_day_sync_coordinators_from_voters_for_workspace",
  "election_day_update_non_voting_reason",
  "election_day_update_role",
  "election_day_update_role_owner_v3",
  "election_day_validate_non_voting_reason_input",
  "election_day_validate_role_input",
  "election_day_verify_and_consume_owner_proof",
  "election_day_verify_and_consume_reauth_proof_v3",
  "election_day_verify_reauth_proof",
  "election_day_verify_reauth_proof_v3",
  "election_day_voter_is_remaining",
].sort();

function sqlQueryLocalSync<T>(query: string): T {
  const tmpPath = join(tmpdir(), `kolbox-contract-sql-${randomUUID()}.sql`);
  writeFileSync(tmpPath, query, { encoding: "utf8", mode: 0o600 });
  let out: string;
  try {
    out = invokeSupabaseCli([
      "db",
      "query",
      "--local",
      "--file",
      tmpPath,
      "--output-format",
      "json",
      "--agent",
      "yes",
    ]);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup for this local-only, non-secret-bearing temp file
    }
  }
  const jsonStart = out.indexOf("{");
  if (jsonStart === -1)
    throw new Error(
      "sqlQueryLocalSync: no JSON object found in `supabase db query --local` output",
    );
  const parsed = JSON.parse(out.slice(jsonStart)) as { rows?: T[] };
  if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) {
    throw new Error("sqlQueryLocalSync: query returned zero rows");
  }
  return parsed.rows[0];
}

async function runLiveSection(): Promise<void> {
  let row: { jsonb_pretty: string };
  try {
    row = sqlQueryLocalSync<{ jsonb_pretty: string }>(`
      select jsonb_pretty(jsonb_build_object(
        'rpcOverloadCount', (select count(*) from pg_proc where proname = 'election_day_backfill_historical_workspace' and pronamespace = 'public'::regnamespace),
        'remainingFunctionNames', (select coalesce(jsonb_agg(p.proname order by p.proname), '[]'::jsonb) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')
      ));
    `);
  } catch (err) {
    assert(
      false,
      `live Section 2 could not query the local disposable stack (is it started and reset? \`supabase start\` then \`supabase db reset\`) - ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log(
      "\nsmoke-multi-tenant-phase2-contract-schema (Section 2 - live local proof): SKIPPED (no local stack reachable)",
    );
    return;
  }

  const snapshot = JSON.parse(row.jsonb_pretty) as {
    rpcOverloadCount: number;
    remainingFunctionNames: string[];
  };

  assert(
    snapshot.rpcOverloadCount === 0,
    `election_day_backfill_historical_workspace is absent after all migrations apply to a fresh local stack (overload count: ${snapshot.rpcOverloadCount})`,
  );

  const actual = [...snapshot.remainingFunctionNames].sort();
  const missing = EXPECTED_REMAINING_FUNCTIONS.filter((name) => !actual.includes(name));
  const unexpected = actual.filter(
    (name) => !EXPECTED_REMAINING_FUNCTIONS.includes(name),
  );
  assert(
    missing.length === 0,
    `no unrelated public function was dropped alongside the Backfill RPC (missing: ${missing.join(", ") || "none"})`,
  );
  assert(
    unexpected.length === 0,
    `no unexpected public function is present beyond the known baseline (unexpected: ${unexpected.join(", ") || "none"})`,
  );

  if (process.exitCode) {
    console.error(
      "\nsmoke-multi-tenant-phase2-contract-schema (Section 2 - live local proof): FAILED",
    );
  } else {
    console.log(
      "\nsmoke-multi-tenant-phase2-contract-schema (Section 2 - live local proof): all checks passed",
    );
  }
}

runLiveSection();
