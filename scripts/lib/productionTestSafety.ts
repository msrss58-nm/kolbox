/**
 * Production Test Safety Gate — single source of truth for every script that
 * may mutate `election_day_voters` (or any other real-data table) against a
 * live Supabase project during a smoke test.
 *
 * ROOT INCIDENT this module exists to prevent: during a parallel Reminder
 * Lifecycle v1 production smoke test, a Playwright script mutated 2 REAL
 * voters instead of its own disposable test voter. The exact mechanism was
 * never fully pinned down (most likely a stale "current contact" reference
 * picked up from the page after a navigation/reload, or a DOM-order/name
 * lookup that resolved to the wrong row) — the point is that *some* value
 * that was not the test voter's own known id ended up going out over the
 * wire in an RPC/PATCH call. This module makes that class of bug structurally
 * harder to reintroduce: every mutation must be called through
 * `mutateTestVoter`, which takes a `TestVoterHandle` obtained only from
 * `registerTestVoter` on a `TestRunRegistry` created this run, and asserts
 * (with a hard throw, no fallback) that the id about to be sent is exactly
 * the registered id, that the registry actually knows this id, and that the
 * row still carries this run's unique marker in the DB right now.
 *
 * This module is intentionally framework-free and dependency-free (plain
 * TypeScript, no Supabase client, no Playwright) so it can be unit-tested
 * with fully injected/mocked I/O and never needs network access itself.
 */

/** One production test run's unique identity. Every test voter/account this
 * run creates must carry this string somewhere in an already-existing,
 * human-inspectable field (never a new DB column invented for this purpose)
 * so a fresh read of the row can independently re-prove "this really is
 * mine" without trusting only the in-memory registry. */
export function generateRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `smk${Date.now()}${rand}`;
}

export interface TestVoterHandle {
  readonly runId: string;
  readonly id: string;
  /** The exact string written into an existing, already-queryable field
   * (e.g. `first_name`) that both contains `runId` and is what a live
   * re-fetch is checked against in `assertSafeTestVoterTarget`. */
  readonly marker: string;
}

export interface TestAccountHandle {
  readonly runId: string;
  readonly id: string;
  readonly marker: string;
}

/** Thrown by every guard/registration function in this module. Never caught
 * and silently downgraded to a warning/skip anywhere in this module — a
 * script that wants different behavior must do so explicitly at its own call
 * site, never inside the guard itself. */
export class ProductionTestSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionTestSafetyError";
  }
}

/**
 * Per-run registry of every test voter/account this run has created. A
 * fresh `TestRunRegistry` must be constructed once per script invocation —
 * never reused across runs (a stale registry from a previous process is
 * exactly the "test id from a previous run" adversarial case this module is
 * built to reject). The registry itself is the thing `isRegisteredVoter`
 * checks against — requirement 1 of the safety model ("target voter id
 * exists in an in-memory Set/Map of test voters created in this run").
 */
export class TestRunRegistry {
  readonly runId: string;
  private readonly voters = new Map<string, TestVoterHandle>();
  private readonly accounts = new Map<string, TestAccountHandle>();
  /** In-process single-writer lock (requirement: "אין Promise.all של writers
   * על test voters שונים בלי guard מרכזי"). This only enforces the
   * discipline within one Node process/registry instance — it cannot stop a
   * genuinely separate OS process (a different subagent's own script) from
   * writing concurrently. Cross-process single-writer discipline is a
   * protocol requirement documented in CLAUDE.md, not something this module
   * can mechanically enforce — see this file's own header comment and the
   * "MUTATION LOCK" section of the docs update for the full reasoning. */
  private writing = false;

  constructor(runId: string) {
    if (!runId || runId.length < 8) {
      throw new ProductionTestSafetyError(
        `TestRunRegistry: refusing a missing/too-short runId ("${runId}") - use generateRunId().`,
      );
    }
    this.runId = runId;
  }

  /** Registers a test voter this run created. `marker` must be the exact
   * value written into the row's own identifying field (e.g. `first_name`)
   * and must contain this registry's `runId` - a marker that doesn't prove
   * run-ownership is refused outright, never silently accepted. */
  registerVoter(id: string, marker: string): TestVoterHandle {
    requireNonEmpty(id, "registerVoter: id");
    requireMarkerBelongsToRun(marker, this.runId, "registerVoter");
    const handle: TestVoterHandle = { runId: this.runId, id, marker };
    this.voters.set(id, handle);
    return handle;
  }

  registerAccount(id: string, marker: string): TestAccountHandle {
    requireNonEmpty(id, "registerAccount: id");
    requireMarkerBelongsToRun(marker, this.runId, "registerAccount");
    const handle: TestAccountHandle = { runId: this.runId, id, marker };
    this.accounts.set(id, handle);
    return handle;
  }

  isRegisteredVoter(id: string): boolean {
    return this.voters.has(id);
  }

  isRegisteredAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  getVoterHandle(id: string): TestVoterHandle | undefined {
    return this.voters.get(id);
  }

  getAccountHandle(id: string): TestAccountHandle | undefined {
    return this.accounts.get(id);
  }

  allVoterIds(): readonly string[] {
    return [...this.voters.keys()];
  }

  allAccountIds(): readonly string[] {
    return [...this.accounts.keys()];
  }

  /** Removes a voter from the registry - call only after a verified successful
   * DELETE, so a later accidental re-use of the same handle fails loudly
   * (`isRegisteredVoter` becomes false) instead of silently "succeeding" on
   * an already-deleted row. */
  forgetVoter(id: string): void {
    this.voters.delete(id);
  }

  forgetAccount(id: string): void {
    this.accounts.delete(id);
  }

  /** Acquires the in-process single-writer lock for the duration of `fn`.
   * A second concurrent call while one is already in flight is a hard
   * failure, not a queued wait - concurrency *tests* must be modeled as a
   * single writer process issuing genuinely parallel HTTP requests (e.g. via
   * `Promise.all` of two RPC calls), not as two callers both going through
   * this lock at once. */
  async withWriterLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.writing) {
      throw new ProductionTestSafetyError(
        "TestRunRegistry: another mutation is already in flight on this registry - single-writer discipline violated. " +
          "If you intend a genuine concurrency test, issue both HTTP requests yourself inside one withWriterLock call " +
          "(e.g. via Promise.all of two fetch() calls), not as two separate withWriterLock calls.",
      );
    }
    this.writing = true;
    try {
      return await fn();
    } finally {
      this.writing = false;
    }
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new ProductionTestSafetyError(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

function requireMarkerBelongsToRun(marker: string, runId: string, label: string): void {
  requireNonEmpty(marker, `${label}: marker`);
  if (!marker.includes(runId)) {
    throw new ProductionTestSafetyError(
      `${label}: marker "${marker}" does not contain this run's id "${runId}" - refusing to register. ` +
        "Every test voter/account marker must embed the run id so a live re-fetch can independently prove ownership.",
    );
  }
}

/**
 * The pre-write guard (requirement: "לפני כל mutation ... assertSafeTestVoterTarget").
 * Verifies, in order, and throws on the FIRST failure with no fallback:
 *
 * 1. `targetId === handle.id` - the id about to go out over the wire must be
 *    byte-identical to the handle's own id. This is the single check that
 *    would have caught the actual incident (whatever stale/wrong id was
 *    used, it was not the test voter's own handle.id).
 * 2. `registry.isRegisteredVoter(targetId)` - the id must exist in this
 *    run's own in-memory registry, never a bare id trusted from elsewhere.
 * 3. `handle.runId === registry.runId` - the handle itself must belong to
 *    THIS registry instance, not a handle accidentally carried over from a
 *    different run/registry.
 * 4. A live re-fetch (`fetchVoterMarker`, injected by the caller so this
 *    module never needs its own Supabase client) confirms the row still
 *    exists and its marker field still contains this run's id - catching
 *    both "the row was already deleted" and "this id now points at
 *    something that isn't actually this run's test voter" (e.g. a real
 *    voter that happens to share an id through some other bug).
 *
 * Every check is logged (runId/expected id/actual target id/marker/operation)
 * BEFORE the PASS/FAIL outcome is known, so a thrown error's surrounding
 * console output always shows exactly what was being attempted.
 */
export async function assertSafeTestVoterTarget(params: {
  registry: TestRunRegistry;
  handle: TestVoterHandle;
  targetId: string;
  operation: string;
  fetchVoterMarker: (id: string) => Promise<{ exists: boolean; markerField: string | null }>;
}): Promise<void> {
  const { registry, handle, targetId, operation, fetchVoterMarker } = params;

  console.log(
    JSON.stringify({
      guard: "assertSafeTestVoterTarget",
      runId: registry.runId,
      expectedId: handle.id,
      actualTargetId: targetId,
      marker: handle.marker,
      operation,
    }),
  );

  if (targetId !== handle.id) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: targetId "${targetId}" !== handle.id "${handle.id}" - ` +
        "HARD STOP, no fallback. The id about to be sent does not match the registered test voter's own id.",
    );
  }

  if (handle.runId !== registry.runId) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: handle.runId "${handle.runId}" !== registry.runId "${registry.runId}" - ` +
        "this handle belongs to a different run's registry.",
    );
  }

  if (!registry.isRegisteredVoter(targetId)) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: id "${targetId}" is not registered in this run's TestRunRegistry - ` +
        "every mutation target must have been created and registered in this exact run.",
    );
  }

  // Cross-check the caller-supplied `handle` against the registry's OWN
  // stored record for this id - without this, a caller could construct a
  // TestVoterHandle-shaped object by hand (never having called
  // registerVoter) as long as its `id` happened to already be a genuinely
  // registered voter, and the checks above alone would not catch that the
  // `handle` itself was never actually vouched for by the registry. This
  // makes "the handle must come from registry.registerVoter" a real,
  // enforced invariant instead of just a documented convention.
  const stored = registry.getVoterHandle(targetId);
  if (!stored || stored.marker !== handle.marker) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: the supplied handle (marker "${handle.marker}") does not match ` +
        `this registry's own stored record for id "${targetId}" (stored marker "${stored?.marker ?? "<none>"}") - ` +
        "the handle was not obtained from this registry's registerVoter, or is stale/forged. Refusing to mutate.",
    );
  }

  const live = await fetchVoterMarker(targetId);
  if (!live.exists) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: id "${targetId}" no longer exists in the database (already deleted?) - refusing to mutate.`,
    );
  }
  if (!live.markerField || !live.markerField.includes(registry.runId)) {
    throw new ProductionTestSafetyError(
      `assertSafeTestVoterTarget[${operation}]: live marker field "${live.markerField}" for id "${targetId}" does not ` +
        `contain this run's id "${registry.runId}" - the row no longer proves it belongs to this test run. Refusing to mutate.`,
    );
  }
}

/**
 * The ONLY sanctioned way to mutate a test voter. There is deliberately no
 * `mutateVoter(id, operation)` exported anywhere in this module - a caller
 * cannot pass a raw arbitrary id, it must go through a `TestVoterHandle`
 * obtained from `TestRunRegistry.registerVoter`, and must separately state
 * the `targetId` it is about to send so `assertSafeTestVoterTarget` can catch
 * any divergence between "the id I meant" and "the id I'm about to send".
 * Runs under the registry's single-writer lock.
 */
export async function mutateTestVoter<T>(params: {
  registry: TestRunRegistry;
  handle: TestVoterHandle;
  targetId: string;
  operation: string;
  fetchVoterMarker: (id: string) => Promise<{ exists: boolean; markerField: string | null }>;
  performMutation: (id: string) => Promise<T>;
}): Promise<T> {
  return params.registry.withWriterLock(async () => {
    await assertSafeTestVoterTarget(params);
    return params.performMutation(params.targetId);
  });
}

/**
 * Guard-protected cleanup (requirement: "cleanup גם הוא חייב להיות
 * guard-protected... אין DELETE לפי prefix בלבד בלי לבדוק IDs שנוצרו בריצה").
 * Only deletes ids that are actually registered in this run's registry;
 * an id not found in the registry is a hard failure, never a silent skip.
 * On success, forgets the voter from the registry so a later accidental
 * reuse of the same handle is caught by `assertSafeTestVoterTarget`'s
 * `isRegisteredVoter` check instead of silently no-op'ing against an
 * already-deleted row.
 */
export async function cleanupTestVoter(params: {
  registry: TestRunRegistry;
  handle: TestVoterHandle;
  performDelete: (id: string) => Promise<void>;
}): Promise<void> {
  const { registry, handle, performDelete } = params;
  if (!registry.isRegisteredVoter(handle.id)) {
    throw new ProductionTestSafetyError(
      `cleanupTestVoter: id "${handle.id}" is not registered in this run's TestRunRegistry - ` +
        "refusing to delete an id this run does not recognize as its own.",
    );
  }
  await registry.withWriterLock(async () => {
    await performDelete(handle.id);
  });
  registry.forgetVoter(handle.id);
}

/**
 * Account-side mirror of `assertSafeTestVoterTarget` - same 4-step shape
 * (targetId===handle.id, handle.runId===registry.runId, registry membership,
 * handle-vs-registry cross-check, live re-fetch), applied to
 * `TestAccountHandle`/`isRegisteredAccount`/`getAccountHandle` instead of
 * the voter equivalents. Exists so a script that needs to guard a mutation
 * against a test `PermissionUser` (e.g. a password reset, a role change) has
 * the same one sanctioned path voters already have, instead of being tempted
 * to hand-roll the equivalent logic ad hoc.
 */
export async function assertSafeTestAccountTarget(params: {
  registry: TestRunRegistry;
  handle: TestAccountHandle;
  targetId: string;
  operation: string;
  fetchAccountMarker: (id: string) => Promise<{ exists: boolean; markerField: string | null }>;
}): Promise<void> {
  const { registry, handle, targetId, operation, fetchAccountMarker } = params;

  console.log(
    JSON.stringify({
      guard: "assertSafeTestAccountTarget",
      runId: registry.runId,
      expectedId: handle.id,
      actualTargetId: targetId,
      marker: handle.marker,
      operation,
    }),
  );

  if (targetId !== handle.id) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: targetId "${targetId}" !== handle.id "${handle.id}" - ` +
        "HARD STOP, no fallback. The id about to be sent does not match the registered test account's own id.",
    );
  }

  if (handle.runId !== registry.runId) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: handle.runId "${handle.runId}" !== registry.runId "${registry.runId}" - ` +
        "this handle belongs to a different run's registry.",
    );
  }

  if (!registry.isRegisteredAccount(targetId)) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: id "${targetId}" is not registered in this run's TestRunRegistry - ` +
        "every mutation target must have been created and registered in this exact run.",
    );
  }

  const stored = registry.getAccountHandle(targetId);
  if (!stored || stored.marker !== handle.marker) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: the supplied handle (marker "${handle.marker}") does not match ` +
        `this registry's own stored record for id "${targetId}" (stored marker "${stored?.marker ?? "<none>"}") - ` +
        "the handle was not obtained from this registry's registerAccount, or is stale/forged. Refusing to mutate.",
    );
  }

  const live = await fetchAccountMarker(targetId);
  if (!live.exists) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: id "${targetId}" no longer exists in the database (already deleted?) - refusing to mutate.`,
    );
  }
  if (!live.markerField || !live.markerField.includes(registry.runId)) {
    throw new ProductionTestSafetyError(
      `assertSafeTestAccountTarget[${operation}]: live marker field "${live.markerField}" for id "${targetId}" does not ` +
        `contain this run's id "${registry.runId}" - the row no longer proves it belongs to this test run. Refusing to mutate.`,
    );
  }
}

/** Account-side mirror of `mutateTestVoter` - see its doc comment. */
export async function mutateTestAccount<T>(params: {
  registry: TestRunRegistry;
  handle: TestAccountHandle;
  targetId: string;
  operation: string;
  fetchAccountMarker: (id: string) => Promise<{ exists: boolean; markerField: string | null }>;
  performMutation: (id: string) => Promise<T>;
}): Promise<T> {
  return params.registry.withWriterLock(async () => {
    await assertSafeTestAccountTarget(params);
    return params.performMutation(params.targetId);
  });
}

/** Account-side mirror of `cleanupTestVoter` - see its doc comment. */
export async function cleanupTestAccount(params: {
  registry: TestRunRegistry;
  handle: TestAccountHandle;
  performDelete: (id: string) => Promise<void>;
}): Promise<void> {
  const { registry, handle, performDelete } = params;
  if (!registry.isRegisteredAccount(handle.id)) {
    throw new ProductionTestSafetyError(
      `cleanupTestAccount: id "${handle.id}" is not registered in this run's TestRunRegistry - ` +
        "refusing to delete an id this run does not recognize as its own.",
    );
  }
  await registry.withWriterLock(async () => {
    await performDelete(handle.id);
  });
  registry.forgetAccount(handle.id);
}
