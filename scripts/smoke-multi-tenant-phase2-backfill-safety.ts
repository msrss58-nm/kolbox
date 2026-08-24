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
 *
 * One exception to "no Docker/Supabase/network required": the
 * invokeSupabaseCli section below does invoke the real, already-locally-
 * cached `supabase` CLI (`--version` only - harmless, read-only, no project
 * targeted) to prove the shell-free Windows invocation fix actually works
 * against the real binary, not just a synthetic probe. The sqlQueryLinkedSync
 * temp-file-transport section extends this same exception with a handful of
 * real calls against the real LINKED Production project - a single-line
 * SELECT, a multi-line SELECT literal embedding Hebrew/quotes, the exact
 * previously-failing checkRpcAcl()-shaped multi-line jsonb_build_object
 * query (against pg_proc, not a business table), and one intentionally
 * malformed query - all pure SELECTs, none read or write a single real
 * table row, all needed because this specific defect (multi-line SQL
 * truncation in `supabase db query --linked`) is a real CLI+Management-API
 * behavior no synthetic probe can stand in for.
 *
 * HISTORICAL CAVEAT (Multi-Tenant Phase 2 Contract, 2026-08-25): the
 * checkRpcAcl()-shaped block's assertion only checks the *shape* of the
 * returned snapshot (`typeof overloadCount === "number"`, `typeof
 * securityDefiner === "boolean"`), not any specific value - so it remains
 * accurate proof of the CLI transport mechanism regardless of what pg_proc
 * currently holds for this function. It was last verified true against
 * Production while `election_day_backfill_historical_workspace` still
 * existed there (pre-Contract). Once a future, separately-authorized step
 * applies the Contract migration (supabase/migrations/20260825000000_
 * multi_tenant_phase2_contract_backfill_rpc_removal.sql) to Production, the
 * function will have zero matching pg_proc rows there, `securityDefiner`
 * will resolve to SQL NULL, and `typeof null === "object"` - only that one
 * assertion will then fail. This is expected and does not indicate a CLI
 * transport regression; this file's own purpose (proving the transport
 * mechanism, not the RPC's continued existence) will still hold. Left
 * unmodified deliberately - this file is historical evidence, not an
 * automated gate (nothing in this repo invokes it automatically), and is
 * never re-run against Production without a human choosing to.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { execFileSync } from "node:child_process";
import {
  resolveNpxInvocation,
  invokeSupabaseCli,
  sqlQueryLinkedSync,
  throwOnQueryOrCleanupFailure,
} from "./lib/supabaseCliQuery";

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

  // ==========================================================================
  // invokeSupabaseCli / resolveNpxInvocation - Windows-safe, shell-free
  // Supabase CLI invocation (fixes the verified `execFileSync("npx", ...)`
  // ENOENT/`.cmd` EINVAL failure on Windows - see the module doc comment).
  // ==========================================================================
  console.log("=== invokeSupabaseCli / resolveNpxInvocation ===");

  // Structural regression guard: neither real caller may reintroduce a bare
  // `execFileSync("npx", ...)` call - both must route through the one
  // shared, shell-free helper. Comments stripped first so this doc comment's
  // own description of the old, broken pattern doesn't self-trigger.
  {
    const src = readFileSync(join(__dirname, "lib", "supabaseCliQuery.ts"), "utf8");
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const execFileSyncCallSites = stripped.match(/execFileSync\(/g) ?? [];
    assert(
      execFileSyncCallSites.length === 1,
      `execFileSync is called exactly once in supabaseCliQuery.ts's actual code (inside invokeSupabaseCli only) - found ${execFileSyncCallSites.length} call site(s)`,
    );
    assert(
      !/execFileSync\(\s*["']npx["']/.test(stripped),
      'no bare execFileSync("npx", ...) call remains anywhere in supabaseCliQuery.ts\'s actual code',
    );
  }

  // resolveNpxInvocation resolves to something real and invokable.
  {
    const { command, prefixArgs } = resolveNpxInvocation();
    assert(
      existsSync(command) || command === "npx",
      `resolveNpxInvocation's command ("${command}") exists on disk or is the bare "npx" fallback`,
    );
    console.log(
      `(resolved: command="${command}", prefixArgs=${JSON.stringify(prefixArgs)})`,
    );
  }

  // The real, already-locally-cached supabase CLI actually runs through the
  // new mechanism - not a synthetic probe. Harmless: --version only, no
  // project targeted, no network fetch needed (already cached this session).
  {
    let ok = true;
    let versionOut = "";
    try {
      versionOut = invokeSupabaseCli(["--version"]).trim();
    } catch (err) {
      ok = false;
      console.error("  (invokeSupabaseCli(['--version']) error:", err, ")");
    }
    assert(
      ok && /^\d+\.\d+\.\d+/.test(versionOut),
      `invokeSupabaseCli(["--version"]) succeeds against the real supabase CLI and returns a version string (got "${versionOut}")`,
    );
  }

  // Argument round-trip / injection safety: dangerous content must reach a
  // child process byte-for-byte, unreinterpreted by any shell. Uses the
  // exact resolved command+prefixArgs (the same mechanism invokeSupabaseCli
  // uses) against a tiny throwaway probe script instead of the real
  // supabase binary, so this isolates the invocation MECHANISM itself.
  {
    const probeDir = mkdtempSync(join(tmpdir(), "kolbox-argv-probe-"));
    const probeScript = join(probeDir, "probe.js");
    writeFileSync(
      probeScript,
      "console.log(JSON.stringify(process.argv.slice(2)));",
      "utf8",
    );
    const { command, prefixArgs } = resolveNpxInvocation();
    // Only the JS-entry path is directly comparable to invokeSupabaseCli's
    // own mechanism (prefixArgs non-empty means command === process.execPath,
    // i.e. `node <probe.js> <args>` is a like-for-like substitution for
    // `node <npx-cli.js> supabase <args>`). If the fallback ("npx", no
    // prefixArgs) is in effect on this machine instead, run the probe via
    // plain `node` directly - still a genuine, meaningful round-trip proof
    // of shell-free argv passthrough, just not exercising the JS-entry path
    // specifically (which isn't in play on this machine in that case).
    const [probeCommand, probePrefixArgs] =
      prefixArgs.length > 0
        ? [command, [] as string[]]
        : [process.execPath, [] as string[]];

    const dangerousArgs = [
      "select 1; DROP TABLE x; --",
      'it\'s "quoted" and `backticked`',
      "%PATH% & echo pwned | rm -rf /",
      'עברית עם רווחים ומרכאות "כן"',
      "newline\ninside\nstring",
      "11111111-1111-1111-1111-111111111111",
      "'; select pg_sleep(0); --",
    ];
    let allRoundTripped = true;
    for (const arg of dangerousArgs) {
      const out = execFileSync(probeCommand, [...probePrefixArgs, probeScript, arg], {
        encoding: "utf8",
        shell: false,
      });
      const roundTripped = (JSON.parse(out) as string[])[0];
      if (roundTripped !== arg) {
        allRoundTripped = false;
        console.error(
          `  MISMATCH for ${JSON.stringify(arg)} -> ${JSON.stringify(roundTripped)}`,
        );
      }
    }
    assert(
      allRoundTripped,
      "every dangerous argument (SQL punctuation, quotes, backticks, cmd.exe metacharacters, Hebrew/Unicode, embedded newlines, UUID-shaped, SQL-comment-shaped) round-trips byte-for-byte through the shell-free invocation mechanism",
    );
    rmSync(probeDir, { recursive: true, force: true });
  }

  // Fails closed: a genuinely bad subcommand must throw (non-zero exit),
  // never resolve to an empty/silent success.
  {
    let threw = false;
    try {
      invokeSupabaseCli(["not-a-real-subcommand-xyz-nonsense"]);
    } catch {
      threw = true;
    }
    assert(threw, "invokeSupabaseCli throws (fails closed) for a nonexistent subcommand");
  }

  // ==========================================================================
  // sqlQueryLinkedSync temp-file transport - multi-line SQL fix (fixes the
  // verified `supabase db query --linked <sql-as-positional-arg>` multi-line
  // truncation/silent-wrong-result bug - see the module doc comment).
  // ==========================================================================
  console.log("=== sqlQueryLinkedSync temp-file transport ===");

  function listTempSqlFiles(): string[] {
    try {
      return readdirSync(tmpdir()).filter(
        (f) => f.startsWith("kolbox-backfill-sql-") && f.endsWith(".sql"),
      );
    } catch {
      return [];
    }
  }

  // Structural regression guard: no positional SQL argv element may return -
  // sqlQueryLinkedSync must invoke --file with a temp path, never a raw sql
  // string as its own argv element, and never opt into shell:true.
  {
    const src = readFileSync(join(__dirname, "lib", "supabaseCliQuery.ts"), "utf8");
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert(
      !/\[\s*"db"\s*,\s*"query"\s*,\s*"--linked"\s*,\s*sql\s*\]/.test(stripped),
      "sqlQueryLinkedSync no longer passes `sql` as a positional argv element to invokeSupabaseCli",
    );
    assert(
      /"--file"/.test(stripped) &&
        /writeFileSync\(/.test(stripped) &&
        /unlinkSync\(/.test(stripped),
      "sqlQueryLinkedSync writes SQL to a temp file and invokes --file, with a matching unlinkSync cleanup",
    );
    assert(
      !/shell:\s*true/.test(stripped),
      "supabaseCliQuery.ts contains no shell:true anywhere",
    );
  }

  // Real, harmless, read-only proof against the live linked Production
  // project: single-line SQL still works, and its temp file is gone after.
  {
    let ok = true;
    let row: { v?: number } | undefined;
    try {
      row = await sqlQueryLinkedSync<{ v: number }>("select 1 as v");
    } catch (err) {
      ok = false;
      console.error("  (single-line sqlQueryLinkedSync error:", err, ")");
    }
    assert(
      ok && row?.v === 1,
      "sqlQueryLinkedSync: single-line SQL still works against real linked Production",
    );
    assert(
      listTempSqlFiles().length === 0,
      "sqlQueryLinkedSync: temp SQL file is removed after a successful call",
    );
  }

  // Real multi-line SQL, embedding Hebrew + quotes + a literal backslash-n in
  // the string content itself - proves multi-line transport AND exact
  // verbatim content preservation (no normalization/collapsing) in one live
  // round trip, plus cleanup after success.
  {
    const hebrewVal = 'עברית עם "מרכאות" ותו newline\\nבתוך המחרוזת';
    const sql = `select\n  '${hebrewVal.replace(/'/g, "''")}' as hebrew_val,\n  2 as marker`;
    let ok = true;
    let row: { hebrew_val?: string; marker?: number } | undefined;
    try {
      row = await sqlQueryLinkedSync<{ hebrew_val: string; marker: number }>(sql);
    } catch (err) {
      ok = false;
      console.error("  (multi-line sqlQueryLinkedSync error:", err, ")");
    }
    assert(
      ok && row?.hebrew_val === hebrewVal && row?.marker === 2,
      "sqlQueryLinkedSync: multi-line SQL with Hebrew/quotes round-trips exactly against real linked Production",
    );
    assert(
      listTempSqlFiles().length === 0,
      "sqlQueryLinkedSync: temp SQL file is removed after a successful multi-line call",
    );
  }

  // throwOnQueryOrCleanupFailure: the fail-closed combination logic, tested
  // directly for all four query/cleanup outcome combinations (pure function,
  // no fs/CLI access - no need to fabricate real filesystem failures).
  {
    let threw = false;
    try {
      throwOnQueryOrCleanupFailure("/tmp/does-not-matter.sql", undefined, undefined);
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "throwOnQueryOrCleanupFailure: query succeeds + cleanup succeeds => does not throw",
    );
  }
  {
    let threw = false;
    let message = "";
    try {
      throwOnQueryOrCleanupFailure(
        "/tmp/does-not-matter.sql",
        new Error("query boom"),
        undefined,
      );
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    assert(
      threw,
      "throwOnQueryOrCleanupFailure: query fails + cleanup succeeds => throws",
    );
    assert(
      message.includes("query boom") && !message.includes("could not be removed"),
      "throwOnQueryOrCleanupFailure: query-only failure message reports the query error, not a spurious cleanup failure",
    );
  }
  {
    let threw = false;
    let message = "";
    try {
      throwOnQueryOrCleanupFailure(
        "/tmp/does-not-matter.sql",
        undefined,
        new Error("cleanup boom"),
      );
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    assert(
      threw,
      "throwOnQueryOrCleanupFailure: query succeeds + cleanup fails => overall failure (caller does NOT receive a successful result)",
    );
    assert(
      message.includes("cleanup boom") && message.includes("succeeded"),
      "throwOnQueryOrCleanupFailure: cleanup-only failure message makes clear the query succeeded but cleanup did not - never silently treated as success",
    );
  }
  {
    let threw = false;
    let message = "";
    try {
      throwOnQueryOrCleanupFailure(
        "/tmp/does-not-matter.sql",
        new Error("query boom"),
        new Error("cleanup boom"),
      );
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    assert(threw, "throwOnQueryOrCleanupFailure: query fails + cleanup fails => throws");
    assert(
      message.includes("query boom") && message.includes("cleanup boom"),
      "throwOnQueryOrCleanupFailure: query-and-cleanup failure reports BOTH facts, neither masking the other",
    );
  }
  {
    // ENOENT is explicitly excluded from being treated as a cleanup failure
    // by sqlQueryLinkedSync's own caller-side check (the file is already
    // gone = already-cleaned) - throwOnQueryOrCleanupFailure itself only
    // ever receives a defined cleanupError for a genuine non-ENOENT failure,
    // so this documents that contract rather than re-testing the ENOENT
    // filter (which lives in sqlQueryLinkedSync, exercised live below).
    let threw = false;
    try {
      throwOnQueryOrCleanupFailure("/tmp/does-not-matter.sql", undefined, undefined);
    } catch {
      threw = true;
    }
    assert(
      !threw,
      "throwOnQueryOrCleanupFailure: an absent (undefined) cleanupError - the ENOENT/already-cleaned case - never triggers a failure",
    );
  }

  // Live proof that a thrown error's message never contains the SQL text
  // itself, even when the query is invalid - the SQL never touches argv or
  // any error path in the --file transport, so a distinctive marker
  // embedded in a deliberately-invalid query must never leak into the
  // thrown message.
  {
    const marker = "KOLBOX_SQL_CONTENT_MARKER_SHOULD_NEVER_LEAK";
    let message = "";
    try {
      await sqlQueryLinkedSync(`select ${marker} this is not valid sql !!!`);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(
      message.length > 0 && !message.includes(marker),
      "sqlQueryLinkedSync: a thrown error's message never contains the SQL text itself, even for an invalid query with a distinctive marker embedded",
    );
  }

  // The exact previously-failing multi-line jsonb_build_object shape that
  // checkRpcAcl() in backfillPreflight.ts constructs (reproduced verbatim
  // here, not imported, since checkRpcAcl is not exported) - proven live
  // against pg_proc, not a business table.
  {
    const RPC_FUNCTION_NAME = "election_day_backfill_historical_workspace";
    const sql = `
      select jsonb_build_object(
        'overloadCount', (select count(*) from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace),
        'securityDefiner', (select prosecdef from pg_proc where proname = '${RPC_FUNCTION_NAME}' and pronamespace = 'public'::regnamespace limit 1)
      ) as snapshot
    `;
    let ok = true;
    let row:
      | { snapshot?: { overloadCount: number; securityDefiner: boolean } }
      | undefined;
    try {
      row = await sqlQueryLinkedSync<{
        snapshot: { overloadCount: number; securityDefiner: boolean };
      }>(sql);
    } catch (err) {
      ok = false;
      console.error("  (checkRpcAcl-shaped sqlQueryLinkedSync error:", err, ")");
    }
    assert(
      ok &&
        typeof row?.snapshot?.overloadCount === "number" &&
        typeof row?.snapshot?.securityDefiner === "boolean",
      "sqlQueryLinkedSync: real checkRpcAcl()-shaped multi-line jsonb_build_object query works against real linked Production",
    );
  }

  // Malformed query must fail closed - never a silent/empty success - and
  // must still clean up its temp file even on failure.
  {
    let threw = false;
    try {
      await sqlQueryLinkedSync("select this is not valid sql !!!");
    } catch {
      threw = true;
    }
    assert(
      threw,
      "sqlQueryLinkedSync throws (fails closed) for a malformed query, not a silent/empty success",
    );
    assert(
      listTempSqlFiles().length === 0,
      "sqlQueryLinkedSync: temp SQL file is removed after a failed call too",
    );
  }

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
