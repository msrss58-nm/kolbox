/** Multi-Tenant Phase 2 (historical Backfill) - live functional regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-backfill-functional.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-backfill-functional.cjs && node scripts/smoke-multi-tenant-phase2-backfill-functional.cjs <API_URL> <SERVICE_ROLE_KEY> <ANON_KEY> <DB_CONTAINER_NAME>
 *
 * MUST be run against a disposable/local Supabase project only - never
 * Production, and never the main local `kolbox` stack either (refused
 * explicitly below, in addition to the existing Production URL guard).
 * Exercises the real `runHistoricalBackfillOrchestration`
 * (scripts/lib/historicalBackfillOrchestration.ts - not deployable; no
 * Vercel route exists for this yet, see CURRENT_STATUS.md) via the actual
 * Supabase Admin API + the Phase 2 RPC over HTTP:
 *
 * - Branch B (safe compensation): a deliberately invalid input triggers a
 *   pre-insert RPC validation exception; reconciliation proves zero
 *   application-level linkage and an empty election_workspaces; the
 *   orchestration compensates for real (Auth user actually deleted).
 * - Happy-path creation, with the caller supplying the temporary password
 *   (never generated/returned by the orchestration itself).
 * - A real sign-in against the live Auth API using that exact
 *   caller-supplied password, proving it was actually set on the account -
 *   not just asserting on a returned value's shape.
 * - Branch A (likely-committed, no compensation): reconciliation against the
 *   real post-success database state.
 * - Branch C (hard stop, no compensation) via a real rejected retry against
 *   the now-existing workspace - proves the retry's own orphaned Auth user
 *   is deliberately left untouched, not silently cleaned up.
 * - Exhaustive synthetic branch coverage of `decideReconciliation` for every
 *   combination the live flow above cannot itself trigger (each of the
 *   other three identity-table linkages refusing Branch B on its own,
 *   workspace-mismatch cases, and "workspace non-empty but unrelated").
 * - Password-leak checks: the temporary password never appears in any
 *   thrown error's message, and the orchestration's result type carries no
 *   password field of any kind.
 * - Data-integrity/row-count proof across all 12 tables, settings
 *   preservation, and general credential non-persistence.
 * - Complete pre-flight (`runFullPreflight`, the exact function the
 *   production runner uses): a clean pass on a pristine database (including
 *   the RPC ACL/security check and settings-shape check), then a re-run
 *   after real data exists proving it correctly DETECTS the now-dirty
 *   state, and a final run proving live detection of a real, deliberately-
 *   introduced anon-EXECUTE privilege escalation on this disposable
 *   project's own RPC grant.
 * - Receipt lifecycle + post-flight verification (`backfillReceipt.ts`/
 *   `backfillPostflight.ts`): a real receipt taken through PREFLIGHT_
 *   CONFIRMED -> AUTH_CREATED -> RPC_CONFIRMED, then post-flight verified
 *   against real committed data (pass) and against a deliberately corrupted
 *   expectation (fail, with the mismatched table identified).
 * - Process-death recovery proof: a real receipt simulating an AUTH_CREATED
 *   state for the Branch C retry's own orphaned Auth user, reconciled via
 *   the exact reader the recovery tool uses, reaching Branch C correctly.
 *
 * Row-level verification queries go straight to Postgres via `docker exec
 * psql` (DB_CONTAINER_NAME), not PostgREST - service_role deliberately
 * holds no direct SELECT grant on these tables (confirmed live; see the
 * Phase 2 migration's own design notes on why the RPC itself must be
 * SECURITY DEFINER), so a service_role REST read would fail with 42501
 * regardless of whether the orchestration under test is correct. This is
 * also why `readReconciliationSnapshot` below uses the same direct-SQL
 * channel - it mirrors exactly how the production runner must read this
 * state too (via `supabase db query --linked`, never a raw connection
 * string, never service_role over PostgREST).
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  decideReconciliation,
  generateOwnerTemporaryPassword,
  HistoricalBackfillCompensatedError,
  HistoricalBackfillHardStopError,
  HistoricalBackfillReceiptWriteFailedError,
  runHistoricalBackfillOrchestration,
  type ReconciliationSnapshot,
} from "./lib/historicalBackfillOrchestration";
import { runFullPreflight, type SqlQueryOne } from "./lib/backfillPreflight";
import { runPostflightVerification } from "./lib/backfillPostflight";
import {
  createReceipt,
  generateRunId,
  markAuthCreated,
  markRpcConfirmed,
  readReceipt,
  receiptPath,
} from "./lib/backfillReceipt";
import { makeReconciliationSnapshotReader } from "./lib/backfillReconciliationRead";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const API_URL = process.argv[2];
const SERVICE_ROLE_KEY = process.argv[3];
const ANON_KEY = process.argv[4];
const DB_CONTAINER = process.argv[5];
if (!API_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !DB_CONTAINER) {
  console.error(
    "usage: node smoke-multi-tenant-phase2-backfill-functional.cjs <API_URL> <SERVICE_ROLE_KEY> <ANON_KEY> <DB_CONTAINER_NAME>",
  );
  process.exit(1);
}
if (/kolbox-gamma|nbymfgphnsounqncfjgl/.test(API_URL)) {
  console.error(
    "FAIL: refusing to run against what looks like the Production project URL",
  );
  process.exit(1);
}
if (DB_CONTAINER === "supabase_db_kolbox") {
  console.error(
    "FAIL: refusing to run against the main local kolbox Postgres container - point this at a disposable/isolated project instead",
  );
  process.exit(1);
}

const admin = createClient(API_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sqlJson(sql: string): unknown {
  const out = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    {
      encoding: "utf8",
    },
  ).trim();
  return out.length ? JSON.parse(out) : null;
}

function sqlCount(sql: string): number {
  const out = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    {
      encoding: "utf8",
    },
  ).trim();
  return Number(out);
}

/** Promise-returning adapter over the sync `sqlJson` helper, matching the
 * shared `SqlQueryOne` contract used by backfillPreflight.ts/
 * backfillPostflight.ts/backfillReconciliationRead.ts - every query in
 * those modules is `select jsonb_build_object(...) as snapshot`, and raw
 * `psql -t -A` output for that is the bare jsonb value (not wrapped by
 * column name, unlike the CLI `--linked` channel's `{rows:[...]}` shape) -
 * so this wraps it back into the same `{ snapshot: ... }` shape those
 * modules expect, keeping them identical between this disposable-project
 * test and the production runner. */
const sqlQueryOneLocal: SqlQueryOne = async <T>(sql: string) =>
  ({ snapshot: sqlJson(sql) }) as T;

/** Mirrors what the production runner must do: read the 4 identity tables'
 * linkage plus election_workspaces' row count for one exact auth_user_id,
 * via the same shared reader the production runner and recovery tool use. */
const readReconciliationSnapshot = makeReconciliationSnapshotReader(sqlQueryOneLocal);

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

  assert(
    sqlCount("select count(*) from election_workspaces") === 0,
    "zero workspaces exist before any test",
  );
  assert(
    sqlCount("select count(*) from election_owners") === 0,
    "zero owners exist before any test",
  );

  // ==========================================================================
  // Complete pre-flight (real runFullPreflight, the exact function the
  // production runner uses): must pass cleanly on a pristine database,
  // including the RPC ACL/security check and the settings-shape check -
  // both real gaps found in the prior review, now implemented and proven
  // live rather than asserted in the abstract.
  // ==========================================================================
  console.log("=== complete pre-flight: clean pass on a pristine database ===");
  const cleanPreflight = await runFullPreflight({
    sqlQueryOne: sqlQueryOneLocal,
    ownerEmail: "phase2test-owner@example.invalid",
    tables: TABLES,
    // no checkMigrations - this disposable local project has no "linked
    // remote" concept at all, matching the documented "if safely
    // obtainable" scope of that one check.
  });
  assert(
    cleanPreflight.ok,
    `pre-flight passes cleanly on a pristine database (problems: ${JSON.stringify(cleanPreflight.problems)})`,
  );
  assert(
    cleanPreflight.settingsOk,
    "pre-flight reports settingsOk on a pristine database (1 row, id=true, workspace_id IS NULL)",
  );
  assert(
    cleanPreflight.migrationsInSync === null,
    "pre-flight reports migrationsInSync as null (not applicable) when checkMigrations is omitted",
  );
  assert(
    cleanPreflight.rpcAcl.overloadCount === 1,
    "pre-flight RPC ACL check: exactly 1 overload",
  );
  assert(
    cleanPreflight.rpcAcl.securityDefiner,
    "pre-flight RPC ACL check: SECURITY DEFINER true",
  );
  assert(
    cleanPreflight.rpcAcl.searchPathEmpty,
    "pre-flight RPC ACL check: search_path = '' true",
  );
  assert(
    cleanPreflight.rpcAcl.owner === "postgres",
    "pre-flight RPC ACL check: owner is postgres",
  );
  assert(
    cleanPreflight.rpcAcl.proacl === "{postgres=X/postgres,service_role=X/postgres}",
    `pre-flight RPC ACL check: exact proacl (got "${cleanPreflight.rpcAcl.proacl}")`,
  );
  assert(
    cleanPreflight.rpcAcl.serviceRoleExecute,
    "pre-flight RPC ACL check: service_role EXECUTE true",
  );
  assert(
    !cleanPreflight.rpcAcl.anonExecute,
    "pre-flight RPC ACL check: anon EXECUTE false",
  );
  assert(
    !cleanPreflight.rpcAcl.authenticatedExecute,
    "pre-flight RPC ACL check: authenticated EXECUTE false",
  );

  // ==========================================================================
  // Branch B: a deliberately invalid input triggers a pre-insert RPC
  // rejection (MISSING_OWNER_NAME, raised before the advisory lock / any
  // insert), reconciliation proves a fully clean state, compensation runs
  // for real.
  // ==========================================================================
  console.log(
    "=== Branch B proof: pre-insert validation rejection -> real compensation ===",
  );
  const branchBPassword = generateOwnerTemporaryPassword();
  let branchBError: unknown = null;
  let branchBOnAuthCreatedFired = false;
  try {
    await runHistoricalBackfillOrchestration(
      admin,
      {
        workspaceName: "PHASE2TEST_branchB_מודיעין",
        electionEndAtIso: "2026-08-17T19:00:00.000Z",
        ownerName: "   ", // whitespace-only -> RPC raises MISSING_OWNER_NAME before touching election_workspaces
        ownerPhone: null,
        ownerEmail: "phase2test-branchb@example.invalid",
        ownerTemporaryPassword: branchBPassword,
      },
      readReconciliationSnapshot,
      async () => {
        branchBOnAuthCreatedFired = true;
      },
    );
  } catch (err) {
    branchBError = err;
  }
  assert(
    branchBOnAuthCreatedFired,
    "onAuthCreated fires even on a run that ultimately hits Branch B (Auth was genuinely created before the RPC's pre-insert rejection)",
  );
  assert(
    branchBError instanceof HistoricalBackfillCompensatedError,
    `Branch B proof throws HistoricalBackfillCompensatedError (got: ${branchBError instanceof Error ? branchBError.constructor.name : String(branchBError)})`,
  );
  let branchBAuthUserId: string | null = null;
  if (branchBError instanceof HistoricalBackfillCompensatedError) {
    branchBAuthUserId = branchBError.authUserId;
    assert(
      !branchBError.message.includes(branchBPassword),
      "Branch B error message does not contain the password",
    );
  }
  {
    const { data: authList, error: authListErr } = await admin.auth.admin.listUsers();
    if (authListErr) throw authListErr;
    const stillExists = branchBAuthUserId
      ? authList.users.some((u) => u.id === branchBAuthUserId)
      : true;
    assert(
      !stillExists,
      "Branch B: the Auth user was actually deleted (compensation ran for real, not simulated)",
    );
  }
  assert(
    sqlCount("select count(*) from election_workspaces") === 0,
    "Branch B proof: zero workspaces afterward - nothing leaked",
  );
  assert(
    sqlCount("select count(*) from election_owners") === 0,
    "Branch B proof: zero owners afterward",
  );

  // ==========================================================================
  // Receipt-write-failure proof: if onAuthCreated itself rejects (simulating
  // a durable-record write failure right after a real Auth user was
  // created), the RPC must NEVER be called, the Auth user must NOT be
  // auto-deleted, and the thrown error must be the dedicated named class -
  // proven by real DB observation (zero workspaces, zero linkage for the
  // exact id created), not by inspecting the orchestration's internals.
  // ==========================================================================
  console.log(
    "=== receipt-write-failure proof: onAuthCreated rejecting prevents the RPC entirely ===",
  );
  const receiptFailurePassword = generateOwnerTemporaryPassword();
  let receiptFailureError: unknown = null;
  try {
    await runHistoricalBackfillOrchestration(
      admin,
      {
        workspaceName: "PHASE2TEST_receiptfail_מודיעין",
        electionEndAtIso: "2026-08-17T19:00:00.000Z",
        ownerName: "PHASE2TEST_receiptfail_owner",
        ownerPhone: null,
        ownerEmail: "phase2test-receiptfail@example.invalid",
        ownerTemporaryPassword: receiptFailurePassword,
      },
      readReconciliationSnapshot,
      async () => {
        throw new Error("simulated receipt write failure");
      },
    );
  } catch (err) {
    receiptFailureError = err;
  }
  assert(
    receiptFailureError instanceof HistoricalBackfillReceiptWriteFailedError,
    `receipt-write failure throws HistoricalBackfillReceiptWriteFailedError (got: ${receiptFailureError instanceof Error ? receiptFailureError.constructor.name : String(receiptFailureError)})`,
  );
  let receiptFailureAuthUserId: string | null = null;
  if (receiptFailureError instanceof HistoricalBackfillReceiptWriteFailedError) {
    receiptFailureAuthUserId = receiptFailureError.authUserId;
    assert(
      !receiptFailureError.message.includes(receiptFailurePassword),
      "receipt-write-failure error message does not contain the password",
    );
  }
  assert(
    sqlCount("select count(*) from election_workspaces") === 0,
    "receipt-write-failure proof: zero workspaces afterward - the RPC genuinely never ran",
  );
  {
    const { data: authList, error: authListErr } = await admin.auth.admin.listUsers();
    if (authListErr) throw authListErr;
    const stillExists = receiptFailureAuthUserId
      ? authList.users.some((u) => u.id === receiptFailureAuthUserId)
      : false;
    assert(
      stillExists,
      "receipt-write-failure proof: the Auth user was NOT auto-deleted (per spec - a failed durable-record write is not auto-compensated)",
    );
  }
  if (receiptFailureAuthUserId) {
    const orphanSnapshot = await readReconciliationSnapshot(receiptFailureAuthUserId);
    assert(
      !orphanSnapshot.electionOwnerLinked &&
        !orphanSnapshot.pendingOwnerAccessLinked &&
        !orphanSnapshot.platformOwnerLinked &&
        !orphanSnapshot.multiEntityOwnerLinked,
      "receipt-write-failure proof: the orphaned Auth user has zero application-level linkage anywhere (the RPC never touched it)",
    );
  }

  // ==========================================================================
  // Happy path (real Admin API + real RPC over HTTP, not mocked). The
  // orchestration no longer generates the password - this script does,
  // exactly mirroring the production runner's approved design.
  // ==========================================================================
  console.log(
    "=== run 1: happy path (caller-supplied password, real Admin API + real RPC over HTTP) ===",
  );
  const password1 = generateOwnerTemporaryPassword();

  // The receipt is created BEFORE the mutating call, exactly like the
  // production runner - onAuthCreated below writes it to AUTH_CREATED
  // synchronously, at the real moment Auth creation happens, not
  // reconstructed after the fact.
  let testReceipt = createReceipt({
    runId: generateRunId(),
    productionProjectRef: "local-disposable-test",
    workspaceName: "PHASE2TEST_מודיעין",
    electionEndAtIso: "2026-08-17T19:00:00.000Z",
    ownerName: "PHASE2TEST_נחום שניר",
    ownerPhone: "0502342010",
    ownerEmail: "phase2test-owner@example.invalid",
    preflight: {
      tableBaseline: cleanPreflight.tableBaseline,
      settingsOk: cleanPreflight.settingsOk,
      migrationsInSync: cleanPreflight.migrationsInSync,
      rpcAcl: cleanPreflight.rpcAcl,
    },
  });
  const testRunId = testReceipt.runId;

  // Live observations taken INSIDE the callback itself - not timing/race
  // guessing - proving onAuthCreated fires strictly after createUser (the
  // Auth user already exists) and strictly before the RPC (the workspace
  // does not exist yet, since the RPC is what creates it).
  let onAuthCreatedObservedAuthUserExists = false;
  let onAuthCreatedObservedWorkspaceCountBeforeRpc: number | null = null;

  const result1 = await runHistoricalBackfillOrchestration(
    admin,
    {
      workspaceName: "PHASE2TEST_מודיעין",
      electionEndAtIso: "2026-08-17T19:00:00.000Z", // 22:00 Asia/Jerusalem (UTC+3 in August, DST) == 19:00 UTC
      ownerName: "PHASE2TEST_נחום שניר",
      ownerPhone: "0502342010",
      ownerEmail: "phase2test-owner@example.invalid",
      ownerTemporaryPassword: password1,
    },
    readReconciliationSnapshot,
    async (authUserId) => {
      onAuthCreatedObservedWorkspaceCountBeforeRpc = sqlCount(
        "select count(*) from election_workspaces",
      );
      const { data: authUser } = await admin.auth.admin.getUserById(authUserId);
      onAuthCreatedObservedAuthUserExists = !!authUser.user;
      testReceipt = markAuthCreated(testReceipt, authUserId);
    },
  );

  assert(!!result1.workspaceId, "run 1 returns a workspace_id");
  assert(!!result1.ownerId, "run 1 returns an owner_id");
  assert(!!result1.authUserId, "run 1 returns an auth_user_id");
  assert(
    !("temporaryPassword" in (result1 as object)) &&
      !("ownerTemporaryPassword" in (result1 as object)),
    "run 1's result carries no password field of any kind",
  );
  assert(
    onAuthCreatedObservedAuthUserExists,
    "onAuthCreated observed the real Auth user already existing when it fired (fires AFTER createUser)",
  );
  assert(
    onAuthCreatedObservedWorkspaceCountBeforeRpc === 0,
    "onAuthCreated observed zero workspaces when it fired (fires BEFORE the RPC, which is what creates the workspace)",
  );
  assert(
    testReceipt.phase === "AUTH_CREATED" && testReceipt.authUserId === result1.authUserId,
    "receipt reached AUTH_CREATED synchronously via the callback, with the correct authUserId, before orchestration returned",
  );

  console.log("=== verifying workspace + owner rows (direct SQL) ===");
  const ws = sqlJson(
    `select row_to_json(t) from (select * from election_workspaces where id = '${result1.workspaceId}') t`,
  ) as {
    name: string;
    election_end_at: string;
  };
  assert(
    ws.name === "PHASE2TEST_מודיעין",
    `workspace name is exactly "PHASE2TEST_מודיעין" (got "${ws.name}")`,
  );
  assert(
    new Date(ws.election_end_at).toISOString() === "2026-08-17T19:00:00.000Z",
    `election_end_at preserved as the exact instant (got ${ws.election_end_at})`,
  );

  const owner = sqlJson(
    `select row_to_json(t) from (select * from election_owners where id = '${result1.ownerId}') t`,
  ) as {
    workspace_id: string;
    auth_user_id: string;
    email: string;
    name: string;
  };
  assert(
    owner.workspace_id === result1.workspaceId,
    "owner is linked to the correct workspace_id",
  );
  assert(
    owner.auth_user_id === result1.authUserId,
    "owner.auth_user_id matches the Auth identity created by this run",
  );
  assert(
    owner.email === "phase2test-owner@example.invalid",
    "owner email preserved correctly",
  );
  assert(owner.name === "PHASE2TEST_נחום שניר", "owner name preserved correctly");

  const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(
    result1.authUserId,
  );
  if (authUserErr) throw authUserErr;
  assert(
    !!authUser.user,
    "the Auth user created in run 1 actually exists in auth.users (via the real Admin API)",
  );
  assert(
    authUser.user!.email === "phase2test-owner@example.invalid",
    "Auth user email matches",
  );

  // ==========================================================================
  // Real sign-in proof: the caller-supplied password was actually set on the
  // account, not just accepted and discarded.
  // ==========================================================================
  console.log("=== real sign-in proof with the caller-supplied password ===");
  const anonClient = createClient(API_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signInData, error: signInError } =
    await anonClient.auth.signInWithPassword({
      email: "phase2test-owner@example.invalid",
      password: password1,
    });
  assert(
    !signInError,
    `sign-in with the caller-supplied temporary password succeeds (error: ${signInError?.message ?? "none"})`,
  );
  assert(
    signInData?.user?.id === result1.authUserId,
    "the signed-in user id matches the Auth user this run created",
  );
  await anonClient.auth.signOut();

  // ==========================================================================
  // Branch A: real post-success state correctly classified as
  // likely-committed - no compensation, no retry, proceed to verification.
  // ==========================================================================
  console.log("=== Branch A proof: real post-commit state correctly classified ===");
  const snapshotAfterSuccess = await readReconciliationSnapshot(result1.authUserId);
  const decisionAfterSuccess = decideReconciliation(snapshotAfterSuccess, {
    workspaceName: "PHASE2TEST_מודיעין",
    electionEndAtIso: "2026-08-17T19:00:00.000Z",
  });
  assert(
    decisionAfterSuccess.branch === "A",
    `real post-commit state classifies as Branch A (got ${decisionAfterSuccess.branch}: ${decisionAfterSuccess.reason})`,
  );

  console.log(
    "=== data-integrity proof: row counts unchanged, every table fully assigned (direct SQL) ===",
  );
  for (const t of TABLES) {
    const after = sqlCount(`select count(*) from ${t}`);
    assert(after === before[t], `${t}: row count unchanged (${before[t]} -> ${after})`);
    const stillNull = sqlCount(`select count(*) from ${t} where workspace_id is null`);
    assert(
      stillNull === 0,
      `${t}: zero rows remain with workspace_id IS NULL after backfill`,
    );
    const wrongWorkspace = sqlCount(
      `select count(*) from ${t} where workspace_id <> '${result1.workspaceId}'`,
    );
    assert(
      wrongWorkspace === 0,
      `${t}: every row's workspace_id equals the one historical workspace (zero cross-workspace ambiguity)`,
    );
  }

  console.log("=== settings preservation (direct SQL) ===");
  const settingsRow = sqlJson(
    `select row_to_json(t) from (select * from election_day_settings) t`,
  ) as { workspace_id: string; id: boolean };
  assert(
    settingsRow.workspace_id === result1.workspaceId,
    "the single settings row now carries the historical workspace_id",
  );
  assert(
    settingsRow.id === true,
    "settings PK/structure untouched (id still boolean true - no Phase 3-style structural change)",
  );

  // ==========================================================================
  // Complete pre-flight, re-run now that real data exists: must correctly
  // DETECT the dirty state (existing owner/workspace/identity, non-null
  // workspace_id everywhere, settings no longer "clean") rather than only
  // ever having been proven on an empty database.
  // ==========================================================================
  console.log("=== complete pre-flight: re-run detects the now-dirty state ===");
  const dirtyPreflight = await runFullPreflight({
    sqlQueryOne: sqlQueryOneLocal,
    ownerEmail: "phase2test-owner@example.invalid",
    tables: TABLES,
  });
  assert(
    !dirtyPreflight.ok,
    "pre-flight correctly reports NOT ok once a real workspace/owner/backfill exists",
  );
  assert(
    !dirtyPreflight.settingsOk,
    "pre-flight correctly reports settingsOk=false once settings.workspace_id is no longer null",
  );
  assert(
    dirtyPreflight.problems.some((p) => /election_workspaces already has/.test(p)),
    "pre-flight problems mention the existing workspace",
  );
  assert(
    dirtyPreflight.problems.some((p) =>
      /election_owners already has 1 row\(s\) for phase2test-owner@example\.invalid/.test(
        p,
      ),
    ),
    "pre-flight problems mention the existing owner for the target email",
  );
  assert(
    // election_day_roles has 3 seeded rows in this disposable fixture (vs.
    // election_day_voters, which has 0 here and so correctly reports no
    // violation - a table with zero rows has zero non-null ones too).
    dirtyPreflight.problems.some((p) =>
      /election_day_roles already has .* non-null workspace_id/.test(p),
    ),
    "pre-flight problems mention at least one table's non-null workspace_id violation",
  );

  // ==========================================================================
  // Receipt lifecycle + post-flight verification, using the SAME real
  // receipt this run actually produced above (AUTH_CREATED was already
  // written synchronously via onAuthCreated, before the RPC ran) - only
  // RPC_CONFIRMED remains, then the exact post-flight verifier the
  // production runner points operators at.
  // ==========================================================================
  console.log(
    "=== receipt lifecycle + post-flight verification (real, against committed data) ===",
  );
  markRpcConfirmed(testReceipt, {
    workspaceId: result1.workspaceId,
    ownerId: result1.ownerId,
    rowCounts: result1.rowCounts,
  });

  const receiptReadBack = readReceipt(testRunId);
  assert(
    receiptReadBack.phase === "RPC_CONFIRMED",
    "receipt reflects RPC_CONFIRMED after the real run's lifecycle",
  );

  const postflightOk = await runPostflightVerification(sqlQueryOneLocal, {
    workspaceName: receiptReadBack.workspaceName,
    electionEndAtIso: receiptReadBack.electionEndAtIso,
    ownerName: receiptReadBack.ownerName,
    ownerPhone: receiptReadBack.ownerPhone,
    ownerEmail: receiptReadBack.ownerEmail,
    authUserId: receiptReadBack.authUserId!,
    tableBaseline: receiptReadBack.preflight.tableBaseline,
    expectedRpcAcl: receiptReadBack.preflight.rpcAcl,
  });
  assert(
    postflightOk.ok,
    `post-flight verification passes against real committed data, using the receipt's own baseline (problems: ${JSON.stringify(postflightOk.problems)})`,
  );

  const postflightCorrupted = await runPostflightVerification(sqlQueryOneLocal, {
    workspaceName: receiptReadBack.workspaceName,
    electionEndAtIso: receiptReadBack.electionEndAtIso,
    ownerName: receiptReadBack.ownerName,
    ownerPhone: receiptReadBack.ownerPhone,
    ownerEmail: receiptReadBack.ownerEmail,
    authUserId: receiptReadBack.authUserId!,
    tableBaseline: {
      ...receiptReadBack.preflight.tableBaseline,
      election_day_voters:
        receiptReadBack.preflight.tableBaseline.election_day_voters + 1,
    },
    expectedRpcAcl: receiptReadBack.preflight.rpcAcl,
  });
  assert(
    !postflightCorrupted.ok,
    "post-flight verification correctly FAILS when the expectation's table baseline is deliberately wrong",
  );
  assert(
    postflightCorrupted.problems.some((p) =>
      /election_day_voters: row count changed/.test(p),
    ),
    "post-flight's failure message identifies exactly which table's baseline mismatched",
  );

  rmSync(receiptPath(testRunId), { force: true });
  console.log("(test receipt cleaned up)");

  // ==========================================================================
  // Branch C: a real rejected retry against the now-existing workspace hard
  // stops - deliberately NOT compensated, since election_workspaces is no
  // longer empty (see decideReconciliation's doc comment on this intentional
  // consequence for a one-time-ever operation).
  // ==========================================================================
  console.log(
    "=== Branch C proof: rejected retry against an existing workspace hard-stops, no compensation ===",
  );
  const password2 = generateOwnerTemporaryPassword();
  let run2Error: unknown = null;
  try {
    await runHistoricalBackfillOrchestration(
      admin,
      {
        workspaceName: "PHASE2TEST_should_not_be_created",
        electionEndAtIso: "2026-08-17T19:00:00.000Z",
        ownerName: "PHASE2TEST_second_owner",
        ownerPhone: null,
        ownerEmail: "phase2test-owner-2@example.invalid",
        ownerTemporaryPassword: password2,
      },
      readReconciliationSnapshot,
      async () => {},
    );
  } catch (err) {
    run2Error = err;
  }
  assert(
    run2Error instanceof HistoricalBackfillHardStopError,
    `rejected retry throws HistoricalBackfillHardStopError, not silently compensated (got: ${run2Error instanceof Error ? run2Error.constructor.name : String(run2Error)})`,
  );
  let run2AuthUserId: string | null = null;
  if (run2Error instanceof HistoricalBackfillHardStopError) {
    run2AuthUserId = run2Error.authUserId;
    assert(
      !run2Error.message.includes(password2),
      "Branch C error message does not contain the password",
    );
  }
  {
    const { data: authList, error: authListErr } = await admin.auth.admin.listUsers();
    if (authListErr) throw authListErr;
    const run2StillExists = run2AuthUserId
      ? authList.users.some((u) => u.id === run2AuthUserId)
      : false;
    assert(
      run2StillExists,
      "Branch C: the retry's own orphaned Auth user was NOT deleted (no auto-compensation on hard stop)",
    );
    const firstOwnerAuthUsers = authList.users.filter(
      (u) => u.email === "phase2test-owner@example.invalid",
    );
    assert(
      firstOwnerAuthUsers.length === 1,
      "run 1's Auth user is untouched by the rejected retry",
    );
  }
  assert(
    sqlCount("select count(*) from election_workspaces") === 1,
    "still exactly one workspace after the hard-stopped retry - no duplicate, no deletion",
  );
  assert(
    sqlCount("select count(*) from election_owners") === 1,
    "still exactly one owner after the hard-stopped retry",
  );

  // ==========================================================================
  // Process-death recovery proof: simulate the AUTH_CREATED-then-died state
  // using a REAL receipt file (not an in-memory value) and the retry's own
  // real orphaned Auth user id, then run the exact same reconciliation the
  // recovery tool runs. Proves the receipt->reconciliation path end to end,
  // not just decideReconciliation as a bare function call.
  // ==========================================================================
  console.log(
    "=== process-death recovery proof: receipt-driven reconciliation for a simulated AUTH_CREATED state ===",
  );
  if (run2AuthUserId) {
    const recoveryRunId = generateRunId();
    const recoveryReceipt0 = createReceipt({
      runId: recoveryRunId,
      productionProjectRef: "local-disposable-test",
      workspaceName: "PHASE2TEST_should_not_be_created",
      electionEndAtIso: "2026-08-17T19:00:00.000Z",
      ownerName: "PHASE2TEST_second_owner",
      ownerPhone: null,
      ownerEmail: "phase2test-owner-2@example.invalid",
      preflight: {
        tableBaseline: {},
        settingsOk: true,
        migrationsInSync: null,
        rpcAcl: cleanPreflight.rpcAcl,
      },
    });
    const recoveryReceiptAuthCreated = markAuthCreated(recoveryReceipt0, run2AuthUserId);
    assert(
      recoveryReceiptAuthCreated.phase === "AUTH_CREATED",
      "simulated crash receipt correctly reflects AUTH_CREATED (RPC outcome unknown from the receipt's own perspective)",
    );

    const recoveredReceipt = readReceipt(recoveryRunId);
    const recoverySnapshot = await readReconciliationSnapshot(
      recoveredReceipt.authUserId!,
    );
    const recoveryDecision = decideReconciliation(recoverySnapshot, {
      workspaceName: recoveredReceipt.workspaceName,
      electionEndAtIso: recoveredReceipt.electionEndAtIso,
    });
    assert(
      recoveryDecision.branch === "C",
      `receipt-driven recovery reconciliation for the real orphaned retry account correctly reaches Branch C (got ${recoveryDecision.branch}: ${recoveryDecision.reason})`,
    );

    rmSync(receiptPath(recoveryRunId), { force: true });
    console.log("(recovery test receipt cleaned up)");
  } else {
    assert(
      false,
      "process-death recovery proof requires run2AuthUserId from the Branch C test above",
    );
  }

  // ==========================================================================
  // Exhaustive synthetic branch coverage - the live flow above cannot itself
  // trigger every combination decideReconciliation must handle.
  // ==========================================================================
  console.log("=== decideReconciliation: exhaustive synthetic branch coverage ===");
  const base: ReconciliationSnapshot = {
    workspaceCount: 0,
    electionOwnerLinked: false,
    electionOwnerWorkspaceName: null,
    electionOwnerWorkspaceElectionEndAtIso: null,
    pendingOwnerAccessLinked: false,
    platformOwnerLinked: false,
    multiEntityOwnerLinked: false,
  };
  const expected = { workspaceName: "X", electionEndAtIso: "2026-01-01T00:00:00.000Z" };

  assert(
    decideReconciliation(base, expected).branch === "B",
    "all-clear synthetic snapshot -> Branch B",
  );
  assert(
    decideReconciliation({ ...base, pendingOwnerAccessLinked: true }, expected).branch ===
      "C",
    "election_workspace_pending_owner_access linkage alone refuses Branch B -> C",
  );
  assert(
    decideReconciliation({ ...base, platformOwnerLinked: true }, expected).branch === "C",
    "platform_owners linkage alone refuses Branch B -> C",
  );
  assert(
    decideReconciliation({ ...base, multiEntityOwnerLinked: true }, expected).branch ===
      "C",
    "multi_entity_owner linkage alone refuses Branch B -> C",
  );
  assert(
    decideReconciliation(
      {
        ...base,
        electionOwnerLinked: true,
        electionOwnerWorkspaceName: "WRONG",
        electionOwnerWorkspaceElectionEndAtIso: expected.electionEndAtIso,
      },
      expected,
    ).branch === "C",
    "election_owners linkage to a mismatched workspace name -> C, not A",
  );
  assert(
    decideReconciliation(
      {
        ...base,
        electionOwnerLinked: true,
        electionOwnerWorkspaceName: expected.workspaceName,
        electionOwnerWorkspaceElectionEndAtIso: "1999-01-01T00:00:00.000Z",
      },
      expected,
    ).branch === "C",
    "election_owners linkage to a mismatched election_end_at -> C, not A",
  );
  assert(
    decideReconciliation({ ...base, workspaceCount: 1 }, expected).branch === "C",
    "no linkage anywhere but election_workspaces non-empty -> C, never auto-treated as B",
  );
  assert(
    decideReconciliation(
      {
        ...base,
        electionOwnerLinked: true,
        electionOwnerWorkspaceName: expected.workspaceName,
        electionOwnerWorkspaceElectionEndAtIso: expected.electionEndAtIso,
      },
      expected,
    ).branch === "A",
    "election_owners linkage matching exactly -> A",
  );

  console.log("=== credential non-persistence proof (direct SQL) ===");
  const ownerColNames = Object.keys(
    (sqlJson(
      `select row_to_json(t) from (select * from election_owners where id = '${result1.ownerId}') t`,
    ) as object) ?? {},
  );
  assert(
    !ownerColNames.some((c) => /password/i.test(c)),
    `election_owners row has no password-shaped column (columns: ${ownerColNames.join(", ")})`,
  );
  const rpcResultKeys = Object.keys({
    workspace_id: result1.workspaceId,
    owner_id: result1.ownerId,
    row_counts: result1.rowCounts,
  });
  assert(
    !rpcResultKeys.some((k) => /password/i.test(k)),
    "the DB RPC's own jsonb result never carries a password field",
  );

  // ==========================================================================
  // "bad ACL -> refuses" proof: deliberately grant EXECUTE on the RPC to
  // anon on THIS disposable, about-to-be-destroyed project (never on
  // Production) and confirm the pre-flight RPC ACL check actually detects
  // it live against real Postgres grants - not just asserted against a
  // fabricated JS object. No revert needed - this project is torn down
  // immediately after this test run regardless of outcome.
  // ==========================================================================
  console.log(
    "=== pre-flight RPC ACL check: live detection of a real, deliberately-introduced privilege escalation ===",
  );
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      "grant execute on function election_day_backfill_historical_workspace(uuid, text, timestamptz, text, text, text) to anon;",
    ],
    { encoding: "utf8" },
  );
  const badAclPreflight = await runFullPreflight({
    sqlQueryOne: sqlQueryOneLocal,
    ownerEmail: "phase2test-owner-badacl@example.invalid",
    tables: TABLES,
  });
  assert(
    !badAclPreflight.ok,
    "pre-flight correctly reports NOT ok once anon EXECUTE is granted on the RPC",
  );
  assert(
    badAclPreflight.rpcAcl.anonExecute,
    "pre-flight RPC ACL check detects anonExecute=true live against a real Postgres grant",
  );
  assert(
    badAclPreflight.problems.some((p) =>
      /anon EXECUTE = false, is true - PRIVILEGE ESCALATION RISK/.test(p),
    ),
    "pre-flight problems explicitly flag the privilege-escalation risk by name",
  );

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
