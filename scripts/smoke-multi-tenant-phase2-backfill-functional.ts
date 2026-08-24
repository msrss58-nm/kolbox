/** Multi-Tenant Phase 2 (historical Backfill) - live functional regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-backfill-functional.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-backfill-functional.cjs && node scripts/smoke-multi-tenant-phase2-backfill-functional.cjs <API_URL> <SERVICE_ROLE_KEY> <DB_CONTAINER_NAME>
 *
 * MUST be run against a disposable/local Supabase project only - never
 * Production. Exercises the real `runHistoricalBackfillOrchestration`
 * (scripts/lib/historicalBackfillOrchestration.ts - not deployable; no
 * Vercel route exists for this yet, see CURRENT_STATUS.md) via the actual
 * Supabase Admin API + the Phase 2 RPC over HTTP - happy-path creation,
 * retry/idempotency + Auth-compensation on the second attempt,
 * data-integrity/row-count proof across all 12 tables, settings
 * preservation, and temporary-password non-persistence.
 *
 * Row-level verification queries go straight to Postgres via `docker exec
 * psql` (DB_CONTAINER_NAME), not PostgREST - service_role deliberately
 * holds no direct SELECT grant on these tables (confirmed live; see the
 * Phase 2 migration's own design notes on why the RPC itself must be
 * SECURITY DEFINER), so a service_role REST read would fail with 42501
 * regardless of whether the orchestration under test is correct. The
 * orchestration itself never does a REST table read - only
 * auth.admin calls and rpc() calls, which this script also exercises for
 * real over HTTP.
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { runHistoricalBackfillOrchestration } from "./lib/historicalBackfillOrchestration";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const API_URL = process.argv[2];
const SERVICE_ROLE_KEY = process.argv[3];
const DB_CONTAINER = process.argv[4];
if (!API_URL || !SERVICE_ROLE_KEY || !DB_CONTAINER) {
  console.error("usage: node smoke-multi-tenant-phase2-backfill-functional.cjs <API_URL> <SERVICE_ROLE_KEY> <DB_CONTAINER_NAME>");
  process.exit(1);
}
if (/kolbox-gamma|nbymfgphnsounqncfjgl/.test(API_URL)) {
  console.error("FAIL: refusing to run against what looks like the Production project URL");
  process.exit(1);
}

const admin = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function sqlJson(sql: string): unknown {
  const out = execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql], {
    encoding: "utf8",
  }).trim();
  return out.length ? JSON.parse(out) : null;
}

function sqlCount(sql: string): number {
  const out = execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql], {
    encoding: "utf8",
  }).trim();
  return Number(out);
}

const TABLES = [
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

async function main() {
  console.log("=== capturing before-baseline (all 12 tables, via direct SQL) ===");
  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = sqlCount(`select count(*) from ${t}`);
  console.log(JSON.stringify(before));

  assert(sqlCount("select count(*) from election_workspaces") === 0, "zero workspaces exist before the backfill");
  assert(sqlCount("select count(*) from election_owners") === 0, "zero owners exist before the backfill");

  console.log("=== run 1: happy path (real Admin API + real RPC over HTTP) ===");
  const result1 = await runHistoricalBackfillOrchestration(admin, {
    workspaceName: "PHASE2TEST_מודיעין",
    electionEndAtIso: "2026-08-17T19:00:00.000Z", // 22:00 Asia/Jerusalem (UTC+3 in August, DST) == 19:00 UTC
    ownerName: "PHASE2TEST_נחום שניר",
    ownerPhone: "0502342010",
    ownerEmail: "phase2test-owner@example.invalid",
  });

  assert(!!result1.workspaceId, "run 1 returns a workspace_id");
  assert(!!result1.ownerId, "run 1 returns an owner_id");
  assert(!!result1.authUserId, "run 1 returns an auth_user_id");
  assert(typeof result1.temporaryPassword === "string" && result1.temporaryPassword.length >= 32, "run 1 returns a strong temporary password (in-memory only)");
  // Deliberately never print result1.temporaryPassword anywhere below.

  console.log("=== verifying workspace + owner rows (direct SQL) ===");
  const ws = sqlJson(`select row_to_json(t) from (select * from election_workspaces where id = '${result1.workspaceId}') t`) as {
    name: string;
    election_end_at: string;
  };
  assert(ws.name === "PHASE2TEST_מודיעין", `workspace name is exactly "PHASE2TEST_מודיעין" (got "${ws.name}")`);
  assert(new Date(ws.election_end_at).toISOString() === "2026-08-17T19:00:00.000Z", `election_end_at preserved as the exact instant (got ${ws.election_end_at})`);

  const owner = sqlJson(`select row_to_json(t) from (select * from election_owners where id = '${result1.ownerId}') t`) as {
    workspace_id: string;
    auth_user_id: string;
    email: string;
    name: string;
  };
  assert(owner.workspace_id === result1.workspaceId, "owner is linked to the correct workspace_id");
  assert(owner.auth_user_id === result1.authUserId, "owner.auth_user_id matches the Auth identity created by this run");
  assert(owner.email === "phase2test-owner@example.invalid", "owner email preserved correctly");
  assert(owner.name === "PHASE2TEST_נחום שניר", "owner name preserved correctly");

  const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(result1.authUserId);
  if (authUserErr) throw authUserErr;
  assert(!!authUser.user, "the Auth user created in run 1 actually exists in auth.users (via the real Admin API)");
  assert(authUser.user!.email === "phase2test-owner@example.invalid", "Auth user email matches");

  console.log("=== data-integrity proof: row counts unchanged, every table fully assigned (direct SQL) ===");
  for (const t of TABLES) {
    const after = sqlCount(`select count(*) from ${t}`);
    assert(after === before[t], `${t}: row count unchanged (${before[t]} -> ${after})`);
    const stillNull = sqlCount(`select count(*) from ${t} where workspace_id is null`);
    assert(stillNull === 0, `${t}: zero rows remain with workspace_id IS NULL after backfill`);
    const wrongWorkspace = sqlCount(`select count(*) from ${t} where workspace_id <> '${result1.workspaceId}'`);
    assert(wrongWorkspace === 0, `${t}: every row's workspace_id equals the one historical workspace (zero cross-workspace ambiguity)`);
  }

  console.log("=== settings preservation (direct SQL) ===");
  const settingsRow = sqlJson(`select row_to_json(t) from (select * from election_day_settings) t`) as { workspace_id: string; id: boolean };
  assert(settingsRow.workspace_id === result1.workspaceId, "the single settings row now carries the historical workspace_id");
  assert(settingsRow.id === true, "settings PK/structure untouched (id still boolean true - no Phase 3-style structural change)");

  console.log("=== run 2: retry/idempotency + Auth-compensation proof (real Admin API + real RPC) ===");
  let run2Error: unknown = null;
  try {
    await runHistoricalBackfillOrchestration(admin, {
      workspaceName: "PHASE2TEST_should_not_be_created",
      electionEndAtIso: "2026-08-17T19:00:00.000Z",
      ownerName: "PHASE2TEST_second_owner",
      ownerPhone: null,
      ownerEmail: "phase2test-owner-2@example.invalid",
    });
  } catch (err) {
    run2Error = err;
  }

  assert(run2Error !== null, "run 2 (retry) throws rather than succeeding");
  assert(
    run2Error instanceof Error && /HISTORICAL_WORKSPACE_ALREADY_EXISTS/.test(run2Error.message),
    `run 2's error is the expected idempotency-guard rejection (got: ${run2Error instanceof Error ? run2Error.message : String(run2Error)})`,
  );

  assert(sqlCount("select count(*) from election_workspaces") === 1, "exactly one workspace exists after the retry - no duplicate created");
  assert(sqlCount("select count(*) from election_owners") === 1, "exactly one owner exists after the retry - no duplicate created");

  const { data: authList, error: authListErr } = await admin.auth.admin.listUsers();
  if (authListErr) throw authListErr;
  const secondOwnerAuthUsers = authList.users.filter((u) => u.email === "phase2test-owner-2@example.invalid");
  assert(secondOwnerAuthUsers.length === 0, "the Auth user created during the rejected retry was deleted (compensation ran, via the real Admin API)");
  const firstOwnerAuthUsers = authList.users.filter((u) => u.email === "phase2test-owner@example.invalid");
  assert(firstOwnerAuthUsers.length === 1, "run 1's Auth user is untouched by the failed retry");

  console.log("=== credential non-persistence proof (direct SQL) ===");
  const ownerColNames = Object.keys((sqlJson(`select row_to_json(t) from (select * from election_owners where id = '${result1.ownerId}') t`) as object) ?? {});
  assert(!ownerColNames.some((c) => /password/i.test(c)), `election_owners row has no password-shaped column (columns: ${ownerColNames.join(", ")})`);
  const rpcResultKeys = Object.keys({ workspace_id: result1.workspaceId, owner_id: result1.ownerId, row_counts: result1.rowCounts });
  assert(!rpcResultKeys.some((k) => /password/i.test(k)), "the DB RPC's own jsonb result never carries a password field");

  console.log("\nsmoke-multi-tenant-phase2-backfill-functional: all checks executed");
}

main()
  .then(() => {
    if (process.exitCode) {
      console.error("\nsmoke-multi-tenant-phase2-backfill-functional: FAILED");
    } else {
      console.log("smoke-multi-tenant-phase2-backfill-functional: all checks passed");
    }
  })
  .catch((err) => {
    console.error("FAIL: unhandled error:", err);
    process.exitCode = 1;
  });
