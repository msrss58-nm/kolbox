/** Multi-Tenant Phase 2 (historical Backfill) - crash-recovery regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-backfill-recovery.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-backfill-recovery.cjs && node scripts/smoke-multi-tenant-phase2-backfill-recovery.cjs <API_URL> <SERVICE_ROLE_KEY> <DB_CONTAINER_NAME>
 *
 * MUST be run against a disposable/local Supabase project only - never
 * Production, never the main local `kolbox` stack.
 *
 * ==========================================================================
 * PART 1 - pure, no DB/network required: target-metadata tamper coverage
 * ==========================================================================
 * Proves `assertReceiptMatchesApprovedTarget`/`evaluateRecovery` reject a
 * receipt whose productionProjectRef/ownerEmail/workspaceName/
 * electionEndAtIso/ownerName/ownerPhone diverges from the fixed
 * backfillTarget.ts constants BEFORE any live query - each tampered field is
 * proven individually, using a spy `sqlQueryOne`/`readReconciliationSnapshot`
 * that fails the test if ever invoked. Also proves a receipt with every
 * target field correct passes validation, and that tampering ONLY
 * `authUserId` (which is NOT static target metadata - it's run-specific
 * evidence validated by a separate, live mechanism) does not itself trip
 * this check.
 *
 * ==========================================================================
 * PART 2 - live, against a real disposable project
 * ==========================================================================
 *  - `recover-historical-backfill.ts` and `lib/backfillRecovery.ts` contain
 *    no reference to `deleteUser`/`createClient` at all (structural,
 *    static-source check).
 *  - PREFLIGHT_CONFIRMED + a genuinely clean live state -> NOTHING_CREATED.
 *  - PREFLIGHT_CONFIRMED + a real stray Auth user for the approved email
 *    (simulating a crash between createUser and the receipt write) ->
 *    PREFLIGHT_HARD_STOP.
 *  - AUTH_CREATED + a receipt whose authUserId does NOT match the live
 *    Auth user actually found for the approved email (a tampered/wrong
 *    receipt) -> IDENTITY_MISMATCH_HARD_STOP - the receipt is never
 *    trusted at face value.
 *  - AUTH_CREATED + a real orphaned account (Auth created, RPC rejected
 *    directly, bypassing the orchestration's own auto-compensation) ->
 *    BRANCH_B_ORPHAN_CANDIDATE, and the account is proven to still exist
 *    afterward - `evaluateRecovery` never deletes anything.
 *  - AUTH_CREATED + a real, fully-committed RPC success (using the real
 *    approved target - the only identity a valid receipt can ever carry
 *    now) -> BRANCH_A_LIKELY_COMMITTED.
 *  - PREFLIGHT_CONFIRMED evaluated again after that real success ->
 *    PREFLIGHT_HARD_STOP (live state is no longer clean for the approved
 *    target - the workspace-exists check fires regardless of which
 *    scenario created it).
 *
 * Every live-DB scenario below necessarily targets the ONE fixed approved
 * identity (OWNER_EMAIL/WORKSPACE_NAME/ELECTION_END_AT_ISO/OWNER_NAME/
 * OWNER_PHONE) - `evaluateRecovery` now hard-rejects anything else before
 * ever reaching a query, so scenarios that used to isolate themselves with
 * distinct fake emails are run sequentially instead, each cleaning up its
 * own Auth user before the next begins (except the final real-success
 * scenario, which is deliberately last since it permanently creates the
 * one-and-only workspace this disposable project's RPC will ever allow).
 */
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  generateOwnerTemporaryPassword,
  runHistoricalBackfillOrchestration,
} from "./lib/historicalBackfillOrchestration";
import type { SqlQueryOne } from "./lib/backfillPreflight";
import {
  createReceipt,
  generateRunId,
  markAuthCreated,
  receiptPath,
  type BackfillReceipt,
} from "./lib/backfillReceipt";
import { makeReconciliationSnapshotReader } from "./lib/backfillReconciliationRead";
import { evaluateRecovery } from "./lib/backfillRecovery";
import {
  WORKSPACE_NAME,
  ELECTION_END_AT_ISO,
  OWNER_NAME,
  OWNER_PHONE,
  OWNER_EMAIL,
  assertReceiptMatchesApprovedTarget,
} from "./lib/backfillTarget";
import { APPROVED_PRODUCTION_PROJECT_REF } from "./lib/productionIdentity";

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
  console.error(
    "usage: node smoke-multi-tenant-phase2-backfill-recovery.cjs <API_URL> <SERVICE_ROLE_KEY> <DB_CONTAINER_NAME>",
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
    { encoding: "utf8" },
  ).trim();
  return out.length ? JSON.parse(out) : null;
}
function sqlCount(sql: string): number {
  return Number(
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
        "-t",
        "-A",
        "-c",
        sql,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
}
const sqlQueryOneLocal: SqlQueryOne = async <T>(sql: string) =>
  ({ snapshot: sqlJson(sql) }) as T;
const readReconciliationSnapshot = makeReconciliationSnapshotReader(sqlQueryOneLocal);

async function main() {
  // ==========================================================================
  // Structural proof: neither file has any mutating-capability reference at
  // all - a static-source check, independent of runtime behavior.
  // ==========================================================================
  console.log("=== structural proof: recovery has zero mutating Auth/DB capability ===");
  // Strips /** ... */ and // ... comments before scanning - both files'
  // own doc comments correctly DESCRIBE the absence of deleteUser/
  // createClient (that's what makes them safe to read), which would
  // otherwise make a naive whole-file string search self-defeating.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const recoveryToolSrc = stripComments(
    readFileSync(join(__dirname, "recover-historical-backfill.ts"), "utf8"),
  );
  const recoveryLibSrc = stripComments(
    readFileSync(join(__dirname, "lib", "backfillRecovery.ts"), "utf8"),
  );
  assert(
    !/deleteUser/.test(recoveryToolSrc),
    "recover-historical-backfill.ts's actual code (comments stripped) contains no reference to deleteUser",
  );
  assert(
    !/createClient|@supabase\/supabase-js/.test(recoveryToolSrc),
    "recover-historical-backfill.ts's actual code (comments stripped) imports no Supabase JS client at all",
  );
  assert(
    !/deleteUser/.test(recoveryLibSrc),
    "lib/backfillRecovery.ts's actual code (comments stripped) contains no reference to deleteUser",
  );
  assert(
    !/createClient|@supabase\/supabase-js/.test(recoveryLibSrc),
    "lib/backfillRecovery.ts's actual code (comments stripped) imports no Supabase JS client at all",
  );

  // ==========================================================================
  // PART 1 - pure, no DB/network: target-metadata tamper coverage.
  // Every scenario below uses a spy sqlQueryOne/readReconciliationSnapshot
  // that fails the test if invoked at all, proving the mismatch is caught
  // BEFORE any live query - not merely caught eventually.
  // ==========================================================================
  console.log("=== target-metadata tamper coverage (pure, no live query performed) ===");

  const standardPreflight = {
    tableBaseline: {},
    settingsOk: true,
    migrationsInSync: null,
    rpcAcl: {
      overloadCount: 1,
      securityDefiner: true,
      searchPathEmpty: true,
      owner: "postgres",
      proacl: "",
      serviceRoleExecute: true,
      anonExecute: false,
      authenticatedExecute: false,
    },
  };

  /** Builds a receipt whose target metadata matches the fixed approved
   * target exactly, except for whichever fields are overridden - for
   * exercising exactly one tampered field at a time. */
  function buildReceipt(
    overrides: Partial<{
      productionProjectRef: string;
      workspaceName: string;
      electionEndAtIso: string;
      ownerName: string;
      ownerPhone: string | null;
      ownerEmail: string;
    }> = {},
  ): BackfillReceipt {
    return createReceipt({
      runId: generateRunId(),
      productionProjectRef: APPROVED_PRODUCTION_PROJECT_REF,
      workspaceName: WORKSPACE_NAME,
      electionEndAtIso: ELECTION_END_AT_ISO,
      ownerName: OWNER_NAME,
      ownerPhone: OWNER_PHONE,
      ownerEmail: OWNER_EMAIL,
      preflight: standardPreflight,
      ...overrides,
    });
  }

  function makeNeverCalledSpies(): {
    sqlQueryOne: SqlQueryOne;
    readReconciliationSnapshot: typeof readReconciliationSnapshot;
    wasCalled: () => boolean;
  } {
    let called = false;
    const sqlQueryOneSpy: SqlQueryOne = async <T>(_sql: string): Promise<T> => {
      called = true;
      throw new Error(
        "sqlQueryOne must never be called for a target-metadata-mismatched receipt",
      );
    };
    const readReconciliationSnapshotSpy: typeof readReconciliationSnapshot = async (
      _authUserId: string,
    ) => {
      called = true;
      throw new Error(
        "readReconciliationSnapshot must never be called for a target-metadata-mismatched receipt",
      );
    };
    return {
      sqlQueryOne: sqlQueryOneSpy,
      readReconciliationSnapshot: readReconciliationSnapshotSpy,
      wasCalled: () => called,
    };
  }

  // A receipt whose every target field matches exactly must NOT be rejected
  // by the guard itself (the live-DB scenarios in Part 2 rely on this).
  {
    let threw = false;
    try {
      assertReceiptMatchesApprovedTarget(buildReceipt());
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "a receipt with every target field matching exactly passes validation",
    );
  }

  // Tampering ONLY authUserId (not static target metadata - it has no fixed
  // "approved" value of its own, see the module doc comment) must NOT trip
  // this specific guard - it's validated separately via the live identity
  // cross-check, proven live in Part 2's IDENTITY_MISMATCH_HARD_STOP case.
  {
    let threw = false;
    try {
      const r = buildReceipt();
      const tampered = markAuthCreated(r, "99999999-9999-9999-9999-999999999999");
      assertReceiptMatchesApprovedTarget(tampered);
      rmSync(receiptPath(tampered.runId), { force: true });
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "tampering only authUserId does not trip assertReceiptMatchesApprovedTarget (it is not static target metadata)",
    );
  }

  const tamperCases: Array<{
    label: string;
    overrides: Parameters<typeof buildReceipt>[0];
  }> = [
    {
      label: "productionProjectRef",
      overrides: { productionProjectRef: "some-other-project-ref" },
    },
    { label: "ownerEmail", overrides: { ownerEmail: "attacker@example.invalid" } },
    { label: "workspaceName", overrides: { workspaceName: "attacker workspace" } },
    {
      label: "electionEndAtIso",
      overrides: { electionEndAtIso: "2099-01-01T00:00:00.000Z" },
    },
    { label: "ownerName", overrides: { ownerName: "attacker name" } },
    { label: "ownerPhone", overrides: { ownerPhone: "0000000000" } },
  ];

  for (const { label, overrides } of tamperCases) {
    const receipt = buildReceipt(overrides);

    // The guard itself rejects it directly.
    let guardThrew = false;
    try {
      assertReceiptMatchesApprovedTarget(receipt);
    } catch {
      guardThrew = true;
    }
    assert(
      guardThrew,
      `assertReceiptMatchesApprovedTarget rejects a receipt with a tampered ${label}`,
    );

    // evaluateRecovery rejects it as TARGET_METADATA_MISMATCH_HARD_STOP,
    // and crucially never calls the live query at all.
    const spies = makeNeverCalledSpies();
    const verdict = await evaluateRecovery({
      receipt,
      sqlQueryOne: spies.sqlQueryOne,
      readReconciliationSnapshot: spies.readReconciliationSnapshot,
    });
    assert(
      verdict.kind === "TARGET_METADATA_MISMATCH_HARD_STOP",
      `evaluateRecovery(${label} tampered) -> TARGET_METADATA_MISMATCH_HARD_STOP (got ${verdict.kind})`,
    );
    assert(
      !spies.wasCalled(),
      `evaluateRecovery(${label} tampered) never invoked the live query - rejected before any Production access`,
    );

    rmSync(receiptPath(receipt.runId), { force: true });
  }

  // Same proof again with the receipt already at AUTH_CREATED (not just
  // PREFLIGHT_CONFIRMED) - the guard must fire on this phase too, not only
  // the phase Part 2's own scenarios happen to exercise it from.
  {
    const receipt = markAuthCreated(
      buildReceipt({ ownerEmail: "attacker-at-auth-created@example.invalid" }),
      "99999999-9999-9999-9999-999999999998",
    );
    const spies = makeNeverCalledSpies();
    const verdict = await evaluateRecovery({
      receipt,
      sqlQueryOne: spies.sqlQueryOne,
      readReconciliationSnapshot: spies.readReconciliationSnapshot,
    });
    assert(
      verdict.kind === "TARGET_METADATA_MISMATCH_HARD_STOP",
      `evaluateRecovery(ownerEmail tampered, phase AUTH_CREATED) -> TARGET_METADATA_MISMATCH_HARD_STOP (got ${verdict.kind})`,
    );
    assert(
      !spies.wasCalled(),
      "evaluateRecovery(ownerEmail tampered, phase AUTH_CREATED) never invoked the live query",
    );
    rmSync(receiptPath(receipt.runId), { force: true });
  }

  // ==========================================================================
  // PART 2 - live, against a real disposable project. Every receipt from
  // here on MUST use the fixed approved target exactly (Part 1 just proved
  // why) - scenarios are sequential and self-cleaning rather than isolated
  // by distinct fake emails, since only the one approved identity can ever
  // pass validation now.
  // ==========================================================================

  // ==========================================================================
  // PREFLIGHT_CONFIRMED + genuinely clean live state -> NOTHING_CREATED
  // ==========================================================================
  console.log("=== PREFLIGHT_CONFIRMED + clean live state -> NOTHING_CREATED ===");
  const cleanReceipt = buildReceipt();
  const cleanVerdict = await evaluateRecovery({
    receipt: cleanReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    cleanVerdict.kind === "NOTHING_CREATED",
    `PREFLIGHT_CONFIRMED + clean state -> NOTHING_CREATED (got ${cleanVerdict.kind})`,
  );
  rmSync(receiptPath(cleanReceipt.runId), { force: true });

  // ==========================================================================
  // PREFLIGHT_CONFIRMED + a real stray Auth user for the approved email
  // (simulating a crash between createUser and the receipt write) ->
  // PREFLIGHT_HARD_STOP
  // ==========================================================================
  console.log(
    "=== PREFLIGHT_CONFIRMED + real stray Auth user for the approved email -> PREFLIGHT_HARD_STOP ===",
  );
  const { data: strayUser, error: strayErr } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: generateOwnerTemporaryPassword(),
    email_confirm: true,
  });
  if (strayErr || !strayUser?.user) throw new Error(`setup failed: ${strayErr?.message}`);
  const strayReceipt = buildReceipt();
  const strayVerdict = await evaluateRecovery({
    receipt: strayReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    strayVerdict.kind === "PREFLIGHT_HARD_STOP",
    `PREFLIGHT_CONFIRMED + real stray Auth user -> PREFLIGHT_HARD_STOP (got ${strayVerdict.kind})`,
  );
  rmSync(receiptPath(strayReceipt.runId), { force: true });
  await admin.auth.admin.deleteUser(strayUser.user.id); // test cleanup only - not part of the code under test - back to a clean state for the next scenario

  // ==========================================================================
  // AUTH_CREATED + a receipt whose authUserId does NOT match the live Auth
  // user actually found for the approved email (tampered/wrong receipt) ->
  // IDENTITY_MISMATCH_HARD_STOP. The receipt is never trusted at face value.
  // ==========================================================================
  console.log(
    "=== AUTH_CREATED + tampered/mismatched receipt authUserId -> IDENTITY_MISMATCH_HARD_STOP ===",
  );
  const { data: realAccountForEmail, error: realErr } = await admin.auth.admin.createUser(
    {
      email: OWNER_EMAIL,
      password: generateOwnerTemporaryPassword(),
      email_confirm: true,
    },
  );
  if (realErr || !realAccountForEmail?.user)
    throw new Error(`setup failed: ${realErr?.message}`);
  const { data: unrelatedAccount, error: unrelatedErr } =
    await admin.auth.admin.createUser({
      email: "phase2test-recovery-unrelated@example.invalid",
      password: generateOwnerTemporaryPassword(),
      email_confirm: true,
    });
  if (unrelatedErr || !unrelatedAccount?.user)
    throw new Error(`setup failed: ${unrelatedErr?.message}`);

  // Simulates a hand-edited/tampered receipt: target metadata is exactly the
  // approved one (so it passes assertReceiptMatchesApprovedTarget), but
  // claims AUTH_CREATED with the UNRELATED account's id, even though
  // OWNER_EMAIL actually belongs to a DIFFERENT, real account.
  const tamperReceipt = markAuthCreated(buildReceipt(), unrelatedAccount.user.id);

  const tamperVerdict = await evaluateRecovery({
    receipt: tamperReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    tamperVerdict.kind === "IDENTITY_MISMATCH_HARD_STOP",
    `AUTH_CREATED + mismatched authUserId -> IDENTITY_MISMATCH_HARD_STOP (got ${tamperVerdict.kind})`,
  );
  rmSync(receiptPath(tamperReceipt.runId), { force: true });
  await admin.auth.admin.deleteUser(realAccountForEmail.user.id); // test cleanup only - back to a clean state for the next scenario
  await admin.auth.admin.deleteUser(unrelatedAccount.user.id); // test cleanup only

  // ==========================================================================
  // AUTH_CREATED + a real orphaned account (Auth created, RPC rejected
  // DIRECTLY - bypassing runHistoricalBackfillOrchestration's own auto-
  // compensation entirely, to simulate a process death before that
  // compensation could run) -> BRANCH_B_ORPHAN_CANDIDATE, and the account
  // is proven to still exist afterward.
  // ==========================================================================
  console.log(
    "=== AUTH_CREATED + real orphaned account (no auto-compensation ran) -> BRANCH_B_ORPHAN_CANDIDATE, zero deletion ===",
  );
  const { data: orphanUser, error: orphanErr } = await admin.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: generateOwnerTemporaryPassword(),
    email_confirm: true,
  });
  if (orphanErr || !orphanUser?.user)
    throw new Error(`setup failed: ${orphanErr?.message}`);
  // Call the RPC directly (not via the orchestration) with invalid input so
  // it rejects before any insert - no compensation logic runs at all here,
  // exactly simulating "the process died before it could react".
  const { error: rpcRejectErr } = await admin.rpc(
    "election_day_backfill_historical_workspace",
    {
      p_auth_user_id: orphanUser.user.id,
      p_workspace_name: WORKSPACE_NAME,
      p_election_end_at: ELECTION_END_AT_ISO,
      p_owner_name: "   ", // whitespace-only -> MISSING_OWNER_NAME, before any insert
      p_owner_phone: null,
      p_owner_email: OWNER_EMAIL,
    },
  );
  assert(
    !!rpcRejectErr,
    "the direct RPC call was rejected as expected (MISSING_OWNER_NAME) - no insert happened",
  );

  const orphanReceipt = markAuthCreated(buildReceipt(), orphanUser.user.id);

  const orphanVerdict = await evaluateRecovery({
    receipt: orphanReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    orphanVerdict.kind === "BRANCH_B_ORPHAN_CANDIDATE",
    `AUTH_CREATED + real orphan -> BRANCH_B_ORPHAN_CANDIDATE (got ${orphanVerdict.kind})`,
  );
  {
    const { data: authList, error: authListErr } = await admin.auth.admin.listUsers();
    if (authListErr) throw authListErr;
    assert(
      authList.users.some((u) => u.id === orphanUser.user.id),
      "the orphaned Auth user STILL EXISTS after evaluateRecovery classified it as Branch B - recovery never deletes anything",
    );
  }
  rmSync(receiptPath(orphanReceipt.runId), { force: true });
  await admin.auth.admin.deleteUser(orphanUser.user.id); // test cleanup only - not part of the code under test - back to a clean state for the next scenario

  // ==========================================================================
  // AUTH_CREATED + a real, fully-committed RPC success -> BRANCH_A_LIKELY_COMMITTED.
  // Deliberately LAST among the live scenarios: this is the only one that
  // permanently creates the one-and-only workspace this disposable
  // project's RPC will ever allow, and it necessarily uses the real
  // approved target (workspaceName/electionEndAtIso/ownerName/ownerPhone/
  // ownerEmail) - a valid receipt can no longer carry anything else.
  // ==========================================================================
  console.log(
    "=== AUTH_CREATED + real committed success -> BRANCH_A_LIKELY_COMMITTED ===",
  );
  let committedReceipt = buildReceipt();
  const password = generateOwnerTemporaryPassword();
  const result = await runHistoricalBackfillOrchestration(
    admin,
    {
      workspaceName: WORKSPACE_NAME,
      electionEndAtIso: ELECTION_END_AT_ISO,
      ownerName: OWNER_NAME,
      ownerPhone: OWNER_PHONE,
      ownerEmail: OWNER_EMAIL,
      ownerTemporaryPassword: password,
    },
    readReconciliationSnapshot,
    async (authUserId) => {
      committedReceipt = markAuthCreated(committedReceipt, authUserId);
    },
  );
  // Deliberately do NOT mark RPC_CONFIRMED - this receipt stays frozen at
  // AUTH_CREATED, simulating "the RPC actually succeeded but the process
  // died before the receipt could record that."
  const committedVerdict = await evaluateRecovery({
    receipt: committedReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    committedVerdict.kind === "BRANCH_A_LIKELY_COMMITTED",
    `AUTH_CREATED + real committed success -> BRANCH_A_LIKELY_COMMITTED (got ${committedVerdict.kind})`,
  );
  if (committedVerdict.kind === "BRANCH_A_LIKELY_COMMITTED") {
    assert(
      committedVerdict.authUserId === result.authUserId,
      "Branch A verdict's independently-confirmed authUserId matches the real one",
    );
  }
  rmSync(receiptPath(committedReceipt.runId), { force: true });

  // ==========================================================================
  // PREFLIGHT_CONFIRMED evaluated again after the real success just above ->
  // PREFLIGHT_HARD_STOP. Live state for the approved target is no longer
  // clean (a real workspace + owner + Auth user now exist), so a fresh
  // PREFLIGHT_CONFIRMED receipt (as if a brand new run's own pre-flight had
  // somehow not caught this) must be refused, not treated as "nothing
  // happened yet".
  // ==========================================================================
  console.log(
    "=== PREFLIGHT_CONFIRMED + real committed state already exists -> PREFLIGHT_HARD_STOP ===",
  );
  assert(
    sqlCount("select count(*) from election_workspaces") === 1,
    "sanity: exactly one real workspace now exists from the run above",
  );
  const workspaceExistsReceipt = buildReceipt();
  const workspaceExistsVerdict = await evaluateRecovery({
    receipt: workspaceExistsReceipt,
    sqlQueryOne: sqlQueryOneLocal,
    readReconciliationSnapshot,
  });
  assert(
    workspaceExistsVerdict.kind === "PREFLIGHT_HARD_STOP",
    `PREFLIGHT_CONFIRMED + real committed state already exists -> PREFLIGHT_HARD_STOP (got ${workspaceExistsVerdict.kind})`,
  );
  rmSync(receiptPath(workspaceExistsReceipt.runId), { force: true });

  console.log("\nsmoke-multi-tenant-phase2-backfill-recovery: all checks executed");
}

main()
  .then(() => {
    if (process.exitCode) {
      console.error("\nsmoke-multi-tenant-phase2-backfill-recovery: FAILED");
    } else {
      console.log("smoke-multi-tenant-phase2-backfill-recovery: all checks passed");
    }
  })
  .catch((err) => {
    console.error("FAIL: unhandled error:", err);
    process.exitCode = 1;
  });
