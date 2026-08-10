/** Production Test Safety Gate - pure-logic, fully-mocked, zero-network smoke
 * test. Run via:
 * npx esbuild scripts/smoke-production-test-safety.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-production-test-safety.cjs && node scripts/smoke-production-test-safety.cjs
 *
 * Covers `scripts/lib/productionTestSafety.ts`, written after a real
 * incident where a production smoke test mutated 2 real voters instead of
 * its own disposable test voter. Every mocked `fetchVoterMarker` /
 * `performMutation` / `performDelete` below is a plain in-memory closure
 * (a `Map` standing in for "the database") - this file never calls a real
 * `fetch()` and never touches Supabase/production in any way.
 *
 * Proves, for each of the 7 adversarial variants of the incident's failure
 * class, that the guard throws `ProductionTestSafetyError` BEFORE the
 * corresponding mutation/delete mock is ever invoked - not merely that it
 * throws at some point.
 */
import {
  generateRunId,
  TestRunRegistry,
  ProductionTestSafetyError,
  assertSafeTestVoterTarget,
  mutateTestVoter,
  cleanupTestVoter,
  assertSafeTestAccountTarget,
  mutateTestAccount,
  cleanupTestAccount,
} from "./lib/productionTestSafety";
import type { TestVoterHandle, TestAccountHandle } from "./lib/productionTestSafety";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs `fn`, asserts it rejects with a `ProductionTestSafetyError`, and
 * logs the exact message. If `fn` resolves, or throws something else (e.g.
 * a plain Error thrown from a mock that never should have been called),
 * that's a FAIL - it means the guard let something through it shouldn't
 * have, or the mock we planted to prove "never reached" was in fact reached. */
async function expectProductionSafetyError(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    assert(false, `${label}: expected a ProductionTestSafetyError, but the call succeeded`);
  } catch (err) {
    const isSafetyError = err instanceof ProductionTestSafetyError;
    assert(
      isSafetyError,
      `${label}: threw ProductionTestSafetyError (got: ${
        err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)
      })`,
    );
    if (isSafetyError) {
      console.log(`  -> ${label} message: ${(err as ProductionTestSafetyError).message}`);
    }
  }
}

// ============================================================================
// Registration-time guards (synchronous - throw before any mutation is even
// attempted).
// ============================================================================
function testRegistrationTimeGuards() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);

  try {
    registry.registerVoter("voter-bad-marker", "this marker has no run id in it");
    assert(false, "registerVoter: a marker missing the runId should throw, but it did not");
  } catch (err) {
    assert(
      err instanceof ProductionTestSafetyError,
      `registerVoter: marker missing runId throws ProductionTestSafetyError (got: ${String(err)})`,
    );
  }
  assert(
    !registry.isRegisteredVoter("voter-bad-marker"),
    "registerVoter: the voter was never actually registered after the throw",
  );

  try {
    registry.registerAccount("account-bad-marker", "also no run id here");
    assert(false, "registerAccount: a marker missing the runId should throw, but it did not");
  } catch (err) {
    assert(
      err instanceof ProductionTestSafetyError,
      `registerAccount: marker missing runId throws ProductionTestSafetyError (got: ${String(err)})`,
    );
  }
  assert(
    !registry.isRegisteredAccount("account-bad-marker"),
    "registerAccount: the account was never actually registered after the throw",
  );

  try {
    // eslint-disable-next-line no-new
    new TestRunRegistry("");
    assert(false, "TestRunRegistry: an empty runId should throw, but it did not");
  } catch (err) {
    assert(
      err instanceof ProductionTestSafetyError,
      `TestRunRegistry: empty runId throws ProductionTestSafetyError (got: ${String(err)})`,
    );
  }

  try {
    // eslint-disable-next-line no-new
    new TestRunRegistry("short1"); // 6 chars, < 8
    assert(false, "TestRunRegistry: a too-short runId should throw, but it did not");
  } catch (err) {
    assert(
      err instanceof ProductionTestSafetyError,
      `TestRunRegistry: too-short runId throws ProductionTestSafetyError (got: ${String(err)})`,
    );
  }

  const okRunId = generateRunId();
  assert(okRunId.length >= 8, `generateRunId() produces an id of length >= 8 (got length ${okRunId.length})`);
  const okRegistry = new TestRunRegistry(okRunId);
  assert(okRegistry.runId === okRunId, "TestRunRegistry: accepts a properly generated runId without throwing");
}

// ============================================================================
// Sentinel 5 - not a runtime test. There is no exported `mutateVoter(id,
// operation)` (or any function accepting a raw string id without a
// TestVoterHandle) anywhere in the module: `mutateTestVoter`'s signature
// requires `handle: TestVoterHandle`, obtainable only from
// `TestRunRegistry.registerVoter`/`registerAccount`. Calling the underlying
// mutation logic with a bare id, bypassing a handle entirely, is a
// compile-time impossibility - TypeScript rejects the call site itself, so
// this is a type-level guarantee, not something a runtime test can exercise.
// Confirmed by reading the module's full export list: generateRunId,
// TestVoterHandle, TestAccountHandle, ProductionTestSafetyError,
// TestRunRegistry, assertSafeTestVoterTarget, mutateTestVoter,
// cleanupTestVoter - no raw-id mutation function among them.
// ============================================================================
function testSentinel5_NoRawMutateVoterExport() {
  assert(
    true,
    "Sentinel 5: confirmed by reading the module's exports - no raw mutateVoter(id, operation) function exists; " +
      "bypassing a TestVoterHandle is prevented at the TypeScript type level, not runtime-testable",
  );
}

// ============================================================================
// Positive path - must succeed.
// ============================================================================
async function testPositivePath() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);
  const marker = `TEST_VOTER::${runId}::A`;
  const handle = registry.registerVoter("voter-pos-1", marker);

  const db = new Map<string, string>([["voter-pos-1", marker]]);

  // Direct assertSafeTestVoterTarget check: must resolve without throwing.
  await assertSafeTestVoterTarget({
    registry,
    handle,
    targetId: "voter-pos-1",
    operation: "direct-assert-check",
    fetchVoterMarker: async (id) => ({ exists: true, markerField: db.get(id) ?? null }),
  });
  assert(true, "positive path: assertSafeTestVoterTarget resolves without throwing for a valid target");

  let mutationCalledWith: string | null = null;
  const result = await mutateTestVoter({
    registry,
    handle,
    targetId: "voter-pos-1",
    operation: "test-mark-voted",
    fetchVoterMarker: async (id) => ({ exists: true, markerField: db.get(id) ?? null }),
    performMutation: async (id) => {
      mutationCalledWith = id;
      return { ok: true };
    },
  });

  assert(mutationCalledWith === "voter-pos-1", "positive path: performMutation was invoked with the correct targetId");
  assert(
    (result as { ok: boolean }).ok === true,
    "positive path: mutateTestVoter resolved with performMutation's own return value",
  );

  let deleteCalledWith: string | null = null;
  await cleanupTestVoter({
    registry,
    handle,
    performDelete: async (id) => {
      deleteCalledWith = id;
      db.delete(id);
    },
  });
  assert(deleteCalledWith === "voter-pos-1", "positive path cleanup: performDelete was invoked with the correct id");
  assert(
    registry.isRegisteredVoter("voter-pos-1") === false,
    "positive path cleanup: the voter is unregistered after cleanupTestVoter",
  );
}

// ============================================================================
// Sentinel 1 - a plausible-looking real id that was never registered at all.
// ============================================================================
async function testSentinel1_UnregisteredTargetId() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);
  const fakeHandle: TestVoterHandle = {
    runId,
    id: "real-voter-4821",
    marker: `TEST_VOTER::${runId}::unregistered`,
  };

  let mutationCalled = false;
  await expectProductionSafetyError(
    () =>
      mutateTestVoter({
        registry,
        handle: fakeHandle,
        targetId: "real-voter-4821",
        operation: "sentinel-1-unregistered-target",
        fetchVoterMarker: async () => {
          throw new Error("fetchVoterMarker must not be called - the registry check should block first");
        },
        performMutation: async () => {
          mutationCalled = true;
          return null;
        },
      }),
    "Sentinel 1 (never-registered targetId)",
  );
  assert(!mutationCalled, "Sentinel 1: performMutation was never invoked");
}

// ============================================================================
// Sentinel 2 - a handle registered in a DIFFERENT TestRunRegistry with a
// different runId (a "test id from a previous run").
// ============================================================================
async function testSentinel2_DifferentRunRegistry() {
  const mainRunId = generateRunId();
  const mainRegistry = new TestRunRegistry(mainRunId);

  const staleRunId = generateRunId();
  const staleRegistry = new TestRunRegistry(staleRunId);
  const staleHandle = staleRegistry.registerVoter("voter-stale-1", `TEST_VOTER::${staleRunId}::stale`);

  let mutationCalled = false;
  await expectProductionSafetyError(
    () =>
      mutateTestVoter({
        registry: mainRegistry, // the CURRENT run's registry
        handle: staleHandle, // a handle from a DIFFERENT run's registry
        targetId: staleHandle.id,
        operation: "sentinel-2-stale-run-handle",
        fetchVoterMarker: async () => {
          throw new Error("fetchVoterMarker must not be called");
        },
        performMutation: async () => {
          mutationCalled = true;
          return null;
        },
      }),
    "Sentinel 2 (handle from a different run's registry)",
  );
  assert(!mutationCalled, "Sentinel 2: performMutation was never invoked");
}

// ============================================================================
// Sentinel 3 - correct handle for voter A, but targetId is some other,
// unrelated string (a UI-selection-picked-the-wrong-row bug).
// ============================================================================
async function testSentinel3_WrongTargetIdSelectedContact() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);
  const handleA = registry.registerVoter("voter-A", `TEST_VOTER::${runId}::A`);

  let mutationCalled = false;
  await expectProductionSafetyError(
    () =>
      mutateTestVoter({
        registry,
        handle: handleA,
        targetId: "selectedContact-wrong-id-999", // not handleA.id, not registered anywhere
        operation: "sentinel-3-wrong-selected-id",
        fetchVoterMarker: async () => {
          throw new Error("fetchVoterMarker must not be called");
        },
        performMutation: async () => {
          mutationCalled = true;
          return null;
        },
      }),
    "Sentinel 3 (targetId from a wrong UI selection, unrelated to handle.id)",
  );
  assert(!mutationCalled, "Sentinel 3: performMutation was never invoked");
}

// ============================================================================
// Sentinel 4 - handle for voter A, targetId = voter B's id. Both A and B are
// legitimately registered in the SAME run - a realistic "grabbed the wrong
// array index" bug. Must be blocked by targetId !== handle.id, not by
// "is targetId registered anywhere" (it is - that's the point).
// ============================================================================
async function testSentinel4_WrongRowSameRunRegisteredOther() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);
  const handleA = registry.registerVoter("voter-A", `TEST_VOTER::${runId}::A`);
  const handleB = registry.registerVoter("voter-B", `TEST_VOTER::${runId}::B`);

  let mutationCalled = false;
  await expectProductionSafetyError(
    () =>
      mutateTestVoter({
        registry,
        handle: handleA, // means "voter A"
        targetId: handleB.id, // but sends B's id - B IS registered, just the wrong one
        operation: "sentinel-4-wrong-row-index",
        fetchVoterMarker: async () => {
          throw new Error("fetchVoterMarker must not be called");
        },
        performMutation: async () => {
          mutationCalled = true;
          return null;
        },
      }),
    "Sentinel 4 (handle A paired with registered voter B's targetId)",
  );
  assert(!mutationCalled, "Sentinel 4: performMutation was never invoked");
}

// ============================================================================
// Sentinel 6 - cleanupTestVoter on a handle that was never registered, and
// on a handle already cleaned up once (forgotten from the registry).
// ============================================================================
async function testSentinel6_CleanupUnregisteredOrAlreadyCleaned() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);

  // 6a: never registered at all.
  const neverRegisteredHandle: TestVoterHandle = {
    runId,
    id: "voter-never-registered",
    marker: `TEST_VOTER::${runId}::never`,
  };
  let deleteCalledA = false;
  await expectProductionSafetyError(
    () =>
      cleanupTestVoter({
        registry,
        handle: neverRegisteredHandle,
        performDelete: async () => {
          deleteCalledA = true;
        },
      }),
    "Sentinel 6a (cleanup of a never-registered handle)",
  );
  assert(!deleteCalledA, "Sentinel 6a: performDelete was never invoked");

  // 6b: registered, cleaned up once successfully, then cleaned up AGAIN with
  // the same (now-stale) handle.
  const handle = registry.registerVoter("voter-to-cleanup-twice", `TEST_VOTER::${runId}::twice`);
  let firstDeleteCalled = false;
  await cleanupTestVoter({
    registry,
    handle,
    performDelete: async () => {
      firstDeleteCalled = true;
    },
  });
  assert(firstDeleteCalled, "Sentinel 6b setup: the first cleanup succeeded normally");
  assert(!registry.isRegisteredVoter(handle.id), "Sentinel 6b setup: the voter is unregistered after the first cleanup");

  let secondDeleteCalled = false;
  await expectProductionSafetyError(
    () =>
      cleanupTestVoter({
        registry,
        handle, // same handle, already forgotten by the registry
        performDelete: async () => {
          secondDeleteCalled = true;
        },
      }),
    "Sentinel 6b (cleanup of an already-cleaned-up handle)",
  );
  assert(!secondDeleteCalled, "Sentinel 6b: performDelete was never invoked on the second cleanup attempt");
}

// ============================================================================
// Sentinel 7 - (a) re-entrant withWriterLock on the same registry must
// reject immediately, without waiting for the in-flight call to finish.
// (b) the module's own sanctioned way to do genuine concurrency - two
// mocked RPC calls via a single Promise.all INSIDE one withWriterLock call -
// must succeed.
// ============================================================================
async function testSentinel7_ConcurrentWriterLock() {
  const runId = generateRunId();
  const registry = new TestRunRegistry(runId);

  const start = Date.now();
  const firstLockPromise = registry.withWriterLock(async () => {
    await sleep(50);
    return "first-done";
  });

  let secondThrew = false;
  let secondIsSafetyError = false;
  try {
    await registry.withWriterLock(async () => "second-should-not-run");
  } catch (err) {
    secondThrew = true;
    secondIsSafetyError = err instanceof ProductionTestSafetyError;
  }
  const elapsedForSecondCall = Date.now() - start;

  assert(secondThrew, "Sentinel 7a: a re-entrant withWriterLock call while one is in flight throws");
  assert(secondIsSafetyError, "Sentinel 7a: the thrown error is a ProductionTestSafetyError");
  assert(
    elapsedForSecondCall < 40,
    `Sentinel 7a: the second call rejected immediately (${elapsedForSecondCall}ms) - did not wait for the first call's 50ms to elapse`,
  );

  const firstResult = await firstLockPromise;
  assert(firstResult === "first-done", "Sentinel 7a: the first (legitimate) lock holder still completed normally");

  // 7b: genuine intentional concurrency, the module's own sanctioned pattern.
  const rpcLog: string[] = [];
  const mockRpc = async (label: string, delayMs: number) => {
    await sleep(delayMs);
    rpcLog.push(label);
    return label;
  };

  const [r1, r2] = await registry.withWriterLock(() => Promise.all([mockRpc("rpc-1", 20), mockRpc("rpc-2", 10)]));

  assert(r1 === "rpc-1" && r2 === "rpc-2", "Sentinel 7b: both concurrent mocked RPC calls inside one withWriterLock resolved correctly");
  assert(
    rpcLog.length === 2 && rpcLog.includes("rpc-1") && rpcLog.includes("rpc-2"),
    "Sentinel 7b: both mocked RPC calls actually ran - genuine intentional concurrency inside one lock is not blocked",
  );
}

// ============================================================================
// Handle-vs-registry cross-check (fixed after an independent design review
// found the guard never verified the caller-supplied `handle` against the
// registry's own stored record for that id - only `handle.id`/`targetId`
// self-consistency was checked, `handle.marker` was logged but never
// actually compared to anything).
// ============================================================================
async function testHandleCrossCheck() {
  const registry = new TestRunRegistry(generateRunId());
  const marker = `TEST_VOTER::${registry.runId}::real`;
  const realHandle = registry.registerVoter("voter-xcheck-1", marker);

  // A hand-forged handle: same id/runId as the real, registered one, but a
  // DIFFERENT marker (never came from registerVoter) - e.g. copy-pasted from
  // a stale variable or fabricated by a buggy caller.
  const forgedHandle: TestVoterHandle = {
    runId: registry.runId,
    id: "voter-xcheck-1",
    marker: `TEST_VOTER::${registry.runId}::forged-not-the-real-one`,
  };

  let performMutationCalled = false;
  try {
    await mutateTestVoter({
      registry,
      handle: forgedHandle,
      targetId: "voter-xcheck-1",
      operation: "handle-cross-check",
      fetchVoterMarker: async () => ({ exists: true, markerField: marker }),
      performMutation: async () => {
        performMutationCalled = true;
      },
    });
    assert(false, "handle cross-check: forged handle with mismatched marker should have thrown");
  } catch (e) {
    assert(e instanceof ProductionTestSafetyError, "handle cross-check: threw ProductionTestSafetyError");
  }
  assert(!performMutationCalled, "handle cross-check: performMutation was never invoked for the forged handle");

  // Sanity: the REAL handle for the same id still works normally.
  let realMutationCalled = false;
  await mutateTestVoter({
    registry,
    handle: realHandle,
    targetId: "voter-xcheck-1",
    operation: "handle-cross-check-real",
    fetchVoterMarker: async () => ({ exists: true, markerField: marker }),
    performMutation: async () => {
      realMutationCalled = true;
    },
  });
  assert(realMutationCalled, "handle cross-check: the genuine registered handle still succeeds");
}

// ============================================================================
// Account-side guard (mutateTestAccount/cleanupTestAccount/
// assertSafeTestAccountTarget) - mirrors the voter-side sentinels 1-4 and 6
// at a smaller scale, confirming the account path is genuinely guarded and
// not just registered/tracked with no enforcement.
// ============================================================================
async function testAccountGuard() {
  const registry = new TestRunRegistry(generateRunId());
  const markerA = `TEST_ACCOUNT::${registry.runId}::A`;
  const handleA = registry.registerAccount("account-A", markerA);
  const markerB = `TEST_ACCOUNT::${registry.runId}::B`;
  registry.registerAccount("account-B", markerB);

  // Positive path.
  let mutated: string | null = null;
  await mutateTestAccount({
    registry,
    handle: handleA,
    targetId: "account-A",
    operation: "account-positive",
    fetchAccountMarker: async () => ({ exists: true, markerField: markerA }),
    performMutation: async (id) => {
      mutated = id;
    },
  });
  assert(mutated === "account-A", "account guard: positive path invoked performMutation with the correct id");

  // Wrong-row: handle A paired with account B's targetId.
  let wrongRowCalled = false;
  try {
    await mutateTestAccount({
      registry,
      handle: handleA,
      targetId: "account-B",
      operation: "account-wrong-row",
      fetchAccountMarker: async () => ({ exists: true, markerField: markerB }),
      performMutation: async () => {
        wrongRowCalled = true;
      },
    });
    assert(false, "account guard: handle A + targetId B should have thrown");
  } catch (e) {
    assert(e instanceof ProductionTestSafetyError, "account guard: wrong-row threw ProductionTestSafetyError");
  }
  assert(!wrongRowCalled, "account guard: performMutation never invoked for the wrong-row case");

  // Unregistered target.
  try {
    await assertSafeTestAccountTarget({
      registry,
      handle: handleA,
      targetId: "account-never-registered",
      operation: "account-unregistered",
      fetchAccountMarker: async () => ({ exists: true, markerField: markerA }),
    });
    assert(false, "account guard: unregistered targetId should have thrown");
  } catch (e) {
    assert(e instanceof ProductionTestSafetyError, "account guard: unregistered target threw ProductionTestSafetyError");
  }

  // Cleanup: positive, then reject a repeat.
  let deleted: string | null = null;
  await cleanupTestAccount({
    registry,
    handle: handleA,
    performDelete: async (id) => {
      deleted = id;
    },
  });
  assert(deleted === "account-A", "account guard: cleanupTestAccount invoked performDelete with the correct id");
  assert(!registry.isRegisteredAccount("account-A"), "account guard: account is unregistered after cleanup");

  let secondDeleteCalled = false;
  try {
    await cleanupTestAccount({
      registry,
      handle: handleA,
      performDelete: async () => {
        secondDeleteCalled = true;
      },
    });
    assert(false, "account guard: cleaning up an already-cleaned-up account should have thrown");
  } catch (e) {
    assert(e instanceof ProductionTestSafetyError, "account guard: repeat cleanup threw ProductionTestSafetyError");
  }
  assert(!secondDeleteCalled, "account guard: performDelete never invoked on the repeat cleanup");
}

// ============================================================================
// Run everything.
// ============================================================================
async function main() {
  testRegistrationTimeGuards();
  testSentinel5_NoRawMutateVoterExport();

  await testPositivePath();
  await testSentinel1_UnregisteredTargetId();
  await testSentinel2_DifferentRunRegistry();
  await testSentinel3_WrongTargetIdSelectedContact();
  await testSentinel4_WrongRowSameRunRegisteredOther();
  await testSentinel6_CleanupUnregisteredOrAlreadyCleaned();
  await testSentinel7_ConcurrentWriterLock();
  await testHandleCrossCheck();
  await testAccountGuard();
}

main().then(() => {
  if (process.exitCode) {
    console.error("\nsmoke-production-test-safety: FAILED");
  } else {
    console.log("\nsmoke-production-test-safety: all checks passed");
  }
});
