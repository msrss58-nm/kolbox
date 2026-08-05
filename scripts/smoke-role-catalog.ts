/** Dynamic Roles & Permissions Phase 1 - role catalog state machine smoke
 * test. Run via: npx esbuild scripts/smoke-role-catalog.ts --bundle --format=cjs --outfile=scripts/smoke-role-catalog.cjs && node scripts/smoke-role-catalog.cjs
 *
 * `createRoleCatalogController` (`src/permissions/roleCatalogController.ts`)
 * is a pure, dependency-injected state machine - no zustand/React/Supabase
 * import - so it's exercised here directly with a fake `fetchRoles` and a
 * plain in-memory state object standing in for zustand's get/set. Proves:
 * idle/loading/loaded/error transitions, the in-flight guard (two
 * concurrent callers -> exactly one network call), retry-after-error
 * recovery, and that a failure never self-schedules another attempt (no
 * timer/loop anywhere in the controller).
 */
import {
  createRoleCatalogController,
  INITIAL_ROLE_CATALOG_STATE,
  type RoleCatalogState,
} from "../src/permissions/roleCatalogController";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function makeHarness() {
  let state: RoleCatalogState = { ...INITIAL_ROLE_CATALOG_STATE };
  const getState = () => state;
  const setState = (next: RoleCatalogState) => {
    state = next;
  };
  return { getState, setState };
}

async function run() {
  // ---- success path: idle -> loading -> loaded ---------------------------
  {
    const { getState, setState } = makeHarness();
    let calls = 0;
    const controller = createRoleCatalogController(
      async () => {
        calls++;
        return [...BUILT_IN_ROLE_SEED];
      },
      getState,
      setState,
    );
    assert(getState().status === "idle", "fresh controller starts idle");
    const pending = controller.ensureLoaded();
    assert(getState().status === "loading", "ensureLoaded() synchronously flips to loading");
    assert(getState().roles.length === 0, "roles stay [] while loading, never stale data");
    await pending;
    assert(getState().status === "loaded", "a successful fetch resolves to loaded");
    assert(getState().roles.length === BUILT_IN_ROLE_SEED.length, "loaded state carries the fetched roles");
    assert(calls === 1, "exactly one fetch call for a single ensureLoaded()");

    // ensureLoaded() again while already loaded -> no extra fetch
    await controller.ensureLoaded();
    assert(calls === 1, 'ensureLoaded() while "loaded" does not re-fetch');
  }

  // ---- failure path: idle -> loading -> error, roles stay [] -------------
  {
    const { getState, setState } = makeHarness();
    let calls = 0;
    const controller = createRoleCatalogController(
      async () => {
        calls++;
        throw new Error("network down");
      },
      getState,
      setState,
    );
    await controller.ensureLoaded();
    assert(getState().status === "error", "a failed fetch resolves to error, never stays loading forever");
    assert(getState().roles.length === 0, "roles are [] on error - never a stale/partial list");
    assert(getState().error === "network down", "the error message is captured");
    assert(calls === 1, "exactly one fetch attempt - no automatic retry loop");

    // ensureLoaded() again while "error" -> per contract, ensureLoaded only
    // skips while loading/loaded, so this DOES attempt again - proving a
    // single failure doesn't permanently lock the catalog, while still
    // requiring an explicit call (this one) rather than firing on its own.
    await controller.ensureLoaded();
    assert(calls === 2, "ensureLoaded() from \"error\" attempts again (not a permanent lock) - but only because it was called again, not automatically");
  }

  // ---- retry() explicitly recovers from error -----------------------------
  {
    const { getState, setState } = makeHarness();
    let calls = 0;
    let shouldFail = true;
    const controller = createRoleCatalogController(
      async () => {
        calls++;
        if (shouldFail) throw new Error("network down");
        return [...BUILT_IN_ROLE_SEED];
      },
      getState,
      setState,
    );
    await controller.ensureLoaded();
    assert(getState().status === "error", "initial fetch fails as expected");

    shouldFail = false;
    await controller.retry();
    assert(getState().status === "loaded", "retry() after a fixed failure resolves to loaded");
    assert(getState().roles.length === BUILT_IN_ROLE_SEED.length, "retry() carries the fetched roles once successful");
    assert(calls === 2, "retry() performs exactly one additional fetch");
  }

  // ---- in-flight guard: two concurrent callers -> exactly one network call --
  {
    const { getState, setState } = makeHarness();
    let calls = 0;
    let resolveFetch: (roles: typeof BUILT_IN_ROLE_SEED) => void = () => {};
    const controller = createRoleCatalogController(
      () => {
        calls++;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
      getState,
      setState,
    );
    const first = controller.ensureLoaded();
    const second = controller.ensureLoaded(); // concurrent, before the first resolves
    assert(calls === 1, "two concurrent ensureLoaded() calls trigger exactly one network call");
    resolveFetch([...BUILT_IN_ROLE_SEED]);
    await Promise.all([first, second]);
    assert(getState().status === "loaded", "both concurrent callers observe the eventual loaded state");
    assert(calls === 1, "still exactly one network call after both callers resolved");
  }

  // ---- retry() while already loading is a no-op (no second call) ---------
  {
    const { getState, setState } = makeHarness();
    let calls = 0;
    let resolveFetch: (roles: typeof BUILT_IN_ROLE_SEED) => void = () => {};
    const controller = createRoleCatalogController(
      () => {
        calls++;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
      getState,
      setState,
    );
    const first = controller.ensureLoaded();
    await controller.retry(); // while status is "loading"
    assert(calls === 1, 'retry() while "loading" does not trigger a second concurrent call');
    resolveFetch([...BUILT_IN_ROLE_SEED]);
    await first;
    assert(getState().status === "loaded", "sanity: the original call still completes normally");
  }

  if (process.exitCode) {
    console.error("\nsmoke-role-catalog: FAILED");
  } else {
    console.log("\nsmoke-role-catalog: all checks passed");
  }
}

void run();
