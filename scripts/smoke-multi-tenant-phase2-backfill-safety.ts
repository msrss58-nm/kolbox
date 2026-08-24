/** Multi-Tenant Phase 2 (historical Backfill) - safety-module unit regression.
 * Run via: npx esbuild scripts/smoke-multi-tenant-phase2-backfill-safety.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-multi-tenant-phase2-backfill-safety.cjs && node scripts/smoke-multi-tenant-phase2-backfill-safety.cjs
 *
 * Pure unit coverage, no Docker/Supabase/network required, for the pieces
 * that don't need a live database:
 *  - backfillReceipt.ts: secret-key/JWT-value scanning, phase-advance
 *    enforcement, atomic write/read round-trip, malformed-phase rejection.
 *  - productionIdentity.ts: URL ref parsing (rejects substring tricks),
 *    CLI-linked-ref reading from a fabricated fixture directory (agreement/
 *    disagreement/missing-file cases), and the combined hard gate.
 *  - backfillTarget.ts's assertReceiptMatchesApprovedTarget: rejects a
 *    receipt whose productionProjectRef/workspaceName/electionEndAtIso/
 *    ownerName/ownerPhone/ownerEmail diverges from the fixed approved
 *    target, one field at a time; accepts one with every field matching
 *    exactly; does not itself reject a receipt whose ONLY divergent field
 *    is authUserId (not static target metadata - see
 *    smoke-multi-tenant-phase2-backfill-recovery.ts for the live,
 *    no-query-performed proof of the same guarantee via evaluateRecovery).
 *
 * decideReconciliation's A/B/C branch logic is already covered exhaustively
 * (live and synthetic) by smoke-multi-tenant-phase2-backfill-functional.ts -
 * not duplicated here.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoForbiddenSecrets,
  createReceipt,
  generateRunId,
  markAuthCreated,
  markPostflightVerified,
  markRpcConfirmed,
  readReceipt,
  receiptPath,
} from "./lib/backfillReceipt";
import {
  APPROVED_PRODUCTION_PROJECT_REF,
  getCliLinkedProjectRef,
  parseProductionUrlRef,
  requireProductionIdentityMatch,
} from "./lib/productionIdentity";
import {
  WORKSPACE_NAME,
  ELECTION_END_AT_ISO,
  OWNER_NAME,
  OWNER_PHONE,
  OWNER_EMAIL,
  assertReceiptMatchesApprovedTarget,
} from "./lib/backfillTarget";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function throws(fn: () => unknown, msg: string) {
  try {
    fn();
    assert(false, `${msg} (expected to throw, did not)`);
  } catch {
    assert(true, msg);
  }
}

async function throwsAsync(fn: () => Promise<unknown>, msg: string) {
  try {
    await fn();
    assert(false, `${msg} (expected to throw, did not)`);
  } catch {
    assert(true, msg);
  }
}

async function main() {
  // ==========================================================================
  // assertNoForbiddenSecrets
  // ==========================================================================
  console.log("=== assertNoForbiddenSecrets ===");
  throws(
    () => assertNoForbiddenSecrets({ password: "x" }),
    "rejects a top-level 'password' key",
  );
  throws(
    () => assertNoForbiddenSecrets({ nested: { service_role_key: "x" } }),
    "rejects a nested 'service_role_key' key",
  );
  throws(() => assertNoForbiddenSecrets({ jwt: "x" }), "rejects a 'jwt' key");
  throws(
    () =>
      assertNoForbiddenSecrets({
        ownerEmail:
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19ub3RfcmVhbA",
      }),
    "rejects a JWT-shaped VALUE even under an innocuous key name",
  );
  throws(
    () => assertNoForbiddenSecrets([{ accessToken: "x" }]),
    "rejects a forbidden key inside an array element",
  );
  {
    let ok = true;
    try {
      assertNoForbiddenSecrets({
        runId: "abc123",
        workspaceName: "מודיעין",
        tableBaseline: { election_day_voters: 1420 },
        authUserId: "11111111-1111-1111-1111-111111111111",
      });
    } catch {
      ok = false;
    }
    assert(ok, "accepts an ordinary receipt-shaped object with no secret-looking fields");
  }

  // ==========================================================================
  // Receipt lifecycle (real OS temp dir - receiptPath is intentionally not
  // injectable, so this exercises the real write/rename/read path)
  // ==========================================================================
  console.log("=== receipt lifecycle ===");
  const testRunId = generateRunId();
  assert(
    /^run\d+[0-9a-f]+$/.test(testRunId),
    "generateRunId produces a safely-shaped id",
  );

  const r0 = createReceipt({
    runId: testRunId,
    productionProjectRef: APPROVED_PRODUCTION_PROJECT_REF,
    workspaceName: "PHASE2TEST_מודיעין",
    electionEndAtIso: "2026-08-17T19:00:00.000Z",
    ownerName: "PHASE2TEST_owner",
    ownerPhone: "0500000000",
    ownerEmail: "phase2test-safety@example.invalid",
    preflight: {
      tableBaseline: { election_day_voters: 0 },
      settingsOk: true,
      migrationsInSync: true,
      rpcAcl: {
        overloadCount: 1,
        securityDefiner: true,
        searchPathEmpty: true,
        owner: "postgres",
        proacl: "{postgres=X/postgres,service_role=X/postgres}",
        serviceRoleExecute: true,
        anonExecute: false,
        authenticatedExecute: false,
      },
    },
  });
  assert(
    r0.phase === "PREFLIGHT_CONFIRMED",
    "createReceipt starts at PREFLIGHT_CONFIRMED",
  );
  assert(
    existsSync(receiptPath(testRunId)),
    "receipt file actually exists on disk after createReceipt",
  );

  const readBack0 = readReceipt(testRunId);
  assert(
    readBack0.workspaceName === "PHASE2TEST_מודיעין",
    "readReceipt round-trips the workspace name correctly",
  );
  assert(
    readBack0.authUserId === null,
    "readReceipt round-trips authUserId as null before AUTH_CREATED",
  );

  const fakeAuthUserId = "22222222-2222-2222-2222-222222222222";
  const r1 = markAuthCreated(r0, fakeAuthUserId);
  assert(r1.phase === "AUTH_CREATED", "markAuthCreated advances phase to AUTH_CREATED");
  assert(r1.authUserId === fakeAuthUserId, "markAuthCreated stores the authUserId");
  assert(
    readReceipt(testRunId).phase === "AUTH_CREATED",
    "the on-disk receipt reflects AUTH_CREATED after markAuthCreated",
  );

  throws(
    () => markAuthCreated(r1, fakeAuthUserId),
    "markAuthCreated refuses to re-mark an already-AUTH_CREATED receipt (no backward/sideways phase move)",
  );
  throws(
    () => markPostflightVerified(r0),
    "markPostflightVerified refuses to skip ahead from PREFLIGHT_CONFIRMED directly to POSTFLIGHT_VERIFIED",
  );

  const r2 = markRpcConfirmed(r1, {
    workspaceId: "33333333-3333-3333-3333-333333333333",
    ownerId: "44444444-4444-4444-4444-444444444444",
    rowCounts: { election_day_voters: 0 },
  });
  assert(
    r2.phase === "RPC_CONFIRMED",
    "markRpcConfirmed advances phase to RPC_CONFIRMED",
  );
  assert(
    r2.rpcResult?.workspaceId === "33333333-3333-3333-3333-333333333333",
    "markRpcConfirmed stores rpcResult",
  );

  const r3 = markPostflightVerified(r2);
  assert(
    r3.phase === "POSTFLIGHT_VERIFIED",
    "markPostflightVerified advances phase to POSTFLIGHT_VERIFIED",
  );

  await throwsAsync(
    async () => readReceipt("this-run-id-does-not-exist-00000"),
    "readReceipt HARD STOPs (throws) for a nonexistent runId rather than guessing",
  );

  rmSync(receiptPath(testRunId), { force: true });
  console.log("(test receipt cleaned up)");

  // ==========================================================================
  // assertReceiptMatchesApprovedTarget - "receipt is never authority" gate
  // ==========================================================================
  console.log("=== assertReceiptMatchesApprovedTarget ===");

  function makeTargetReceipt(
    overrides: Partial<{
      productionProjectRef: string;
      workspaceName: string;
      electionEndAtIso: string;
      ownerName: string;
      ownerPhone: string | null;
      ownerEmail: string;
    }> = {},
  ) {
    const runId = generateRunId();
    const receipt = createReceipt({
      runId,
      productionProjectRef: APPROVED_PRODUCTION_PROJECT_REF,
      workspaceName: WORKSPACE_NAME,
      electionEndAtIso: ELECTION_END_AT_ISO,
      ownerName: OWNER_NAME,
      ownerPhone: OWNER_PHONE,
      ownerEmail: OWNER_EMAIL,
      preflight: {
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
      },
      ...overrides,
    });
    return receipt;
  }

  {
    const r = makeTargetReceipt();
    let threw = false;
    try {
      assertReceiptMatchesApprovedTarget(r);
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "accepts a receipt whose target metadata matches the approved target exactly",
    );
    rmSync(receiptPath(r.runId), { force: true });
  }

  const singleFieldTamperCases: Array<{
    label: string;
    overrides: Parameters<typeof makeTargetReceipt>[0];
  }> = [
    { label: "productionProjectRef", overrides: { productionProjectRef: "wrong-ref" } },
    { label: "workspaceName", overrides: { workspaceName: "wrong workspace" } },
    {
      label: "electionEndAtIso",
      overrides: { electionEndAtIso: "2099-01-01T00:00:00.000Z" },
    },
    { label: "ownerName", overrides: { ownerName: "wrong name" } },
    { label: "ownerPhone", overrides: { ownerPhone: "0000000000" } },
    { label: "ownerPhone (null vs approved non-null)", overrides: { ownerPhone: null } },
    { label: "ownerEmail", overrides: { ownerEmail: "attacker@example.invalid" } },
  ];
  for (const { label, overrides } of singleFieldTamperCases) {
    const r = makeTargetReceipt(overrides);
    throws(
      () => assertReceiptMatchesApprovedTarget(r),
      `rejects a receipt with a tampered ${label}`,
    );
    rmSync(receiptPath(r.runId), { force: true });
  }

  {
    // authUserId is run-specific evidence, not static target metadata - it
    // has no fixed "approved" value and must NOT be checked by this
    // function (it's validated separately, via a live identity
    // cross-check - see smoke-multi-tenant-phase2-backfill-recovery.ts).
    const r = markAuthCreated(
      makeTargetReceipt(),
      "99999999-9999-9999-9999-999999999997",
    );
    let threw = false;
    try {
      assertReceiptMatchesApprovedTarget(r);
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "does not reject a receipt whose target metadata is correct even when authUserId is an arbitrary value (authUserId is not static target metadata)",
    );
    rmSync(receiptPath(r.runId), { force: true });
  }

  // ==========================================================================
  // productionIdentity - URL ref parsing (no substring matching)
  // ==========================================================================
  console.log("=== parseProductionUrlRef ===");
  assert(
    parseProductionUrlRef(`https://${APPROVED_PRODUCTION_PROJECT_REF}.supabase.co`) ===
      APPROVED_PRODUCTION_PROJECT_REF,
    "parses the correct ref from a well-formed URL",
  );
  throws(() => parseProductionUrlRef("not a url at all"), "rejects a non-URL string");
  throws(
    () =>
      parseProductionUrlRef(
        `https://evil.example.com/?ref=${APPROVED_PRODUCTION_PROJECT_REF}`,
      ),
    "rejects a URL where the ref only appears as a query param on a different host (no substring matching)",
  );
  throws(
    () =>
      parseProductionUrlRef(
        `https://${APPROVED_PRODUCTION_PROJECT_REF}.supabase.co.evil.com`,
      ),
    "rejects a lookalike hostname that merely CONTAINS the ref as a substring",
  );
  throws(
    () => parseProductionUrlRef("https://supabase.co"),
    "rejects a hostname with no ref subdomain at all",
  );

  // ==========================================================================
  // productionIdentity - CLI-linked ref (fabricated fixture directory, no
  // real Supabase CLI/project touched)
  // ==========================================================================
  console.log("=== getCliLinkedProjectRef / requireProductionIdentityMatch ===");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "kolbox-identity-fixture-"));

  function writeFixture(
    dir: string,
    ref: string | null,
    jsonRef: string | null | "malformed" | "missing",
  ) {
    const tempDir = join(dir, ".temp");
    mkdirSync(tempDir, { recursive: true });
    if (ref !== null) writeFileSync(join(tempDir, "project-ref"), ref, "utf8");
    if (jsonRef === "missing") return;
    if (jsonRef === "malformed")
      writeFileSync(join(tempDir, "linked-project.json"), "{not valid json", "utf8");
    else if (jsonRef !== null)
      writeFileSync(
        join(tempDir, "linked-project.json"),
        JSON.stringify({ ref: jsonRef, name: "test" }),
        "utf8",
      );
  }

  // Case 1: agreement, correct ref
  {
    const dir = join(fixtureRoot, "agree-correct");
    writeFixture(dir, APPROVED_PRODUCTION_PROJECT_REF, APPROVED_PRODUCTION_PROJECT_REF);
    const result = getCliLinkedProjectRef(dir);
    assert(
      result.ref === APPROVED_PRODUCTION_PROJECT_REF,
      "agreement fixture: returns the correct ref",
    );
  }

  // Case 2: disagreement between the two sources
  {
    const dir = join(fixtureRoot, "disagree");
    writeFixture(dir, APPROVED_PRODUCTION_PROJECT_REF, "some-other-project-ref");
    throws(
      () => getCliLinkedProjectRef(dir),
      "refuses when project-ref and linked-project.json disagree",
    );
  }

  // Case 3: missing project-ref file entirely (never linked)
  {
    const dir = join(fixtureRoot, "missing-ref");
    mkdirSync(join(dir, ".temp"), { recursive: true });
    throws(
      () => getCliLinkedProjectRef(dir),
      "refuses when supabase/.temp/project-ref is missing (never linked)",
    );
  }

  // Case 4: missing linked-project.json (partial/legacy link state)
  {
    const dir = join(fixtureRoot, "missing-json");
    writeFixture(dir, APPROVED_PRODUCTION_PROJECT_REF, "missing");
    throws(
      () => getCliLinkedProjectRef(dir),
      "refuses when linked-project.json is missing even though project-ref exists",
    );
  }

  // Case 5: malformed JSON
  {
    const dir = join(fixtureRoot, "malformed-json");
    writeFixture(dir, APPROVED_PRODUCTION_PROJECT_REF, "malformed");
    throws(
      () => getCliLinkedProjectRef(dir),
      "refuses when linked-project.json is not valid JSON",
    );
  }

  // Case 6: agreement, but on the WRONG (non-approved) project entirely
  {
    const dir = join(fixtureRoot, "agree-wrong-project");
    writeFixture(dir, "some-other-linked-project-ref", "some-other-linked-project-ref");
    const supabaseUrl = `https://${APPROVED_PRODUCTION_PROJECT_REF}.supabase.co`;
    throws(
      () => requireProductionIdentityMatch(supabaseUrl, dir),
      "requireProductionIdentityMatch refuses when the CLI is linked to a DIFFERENT (real, self-consistent) project than SUPABASE_URL targets",
    );
  }

  // Case 7: SUPABASE_URL and CLI both wrong, but happen to agree with each other
  {
    const dir = join(fixtureRoot, "agree-both-wrong");
    writeFixture(dir, "some-other-linked-project-ref", "some-other-linked-project-ref");
    const supabaseUrl = "https://some-other-linked-project-ref.supabase.co";
    throws(
      () => requireProductionIdentityMatch(supabaseUrl, dir),
      "requireProductionIdentityMatch refuses even when env and CLI agree with EACH OTHER but not with the approved ref",
    );
  }

  // Case 8: full success - both correct and matching
  {
    const dir = join(fixtureRoot, "full-success");
    writeFixture(dir, APPROVED_PRODUCTION_PROJECT_REF, APPROVED_PRODUCTION_PROJECT_REF);
    const supabaseUrl = `https://${APPROVED_PRODUCTION_PROJECT_REF}.supabase.co`;
    const result = requireProductionIdentityMatch(supabaseUrl, dir);
    assert(
      result.urlRef === APPROVED_PRODUCTION_PROJECT_REF &&
        result.cliRef === APPROVED_PRODUCTION_PROJECT_REF,
      "requireProductionIdentityMatch succeeds only when env ref == CLI ref == approved ref",
    );
  }

  rmSync(fixtureRoot, { recursive: true, force: true });
  console.log("(fixture directory cleaned up)");

  if (process.exitCode) {
    console.error("\nsmoke-multi-tenant-phase2-backfill-safety: FAILED");
  } else {
    console.log("\nsmoke-multi-tenant-phase2-backfill-safety: all checks passed");
  }
}

main().catch((err) => {
  console.error("FAIL: unhandled error:", err);
  process.exitCode = 1;
});
