import type { RoleRecord } from "./types";

export type RoleCatalogStatus = "idle" | "loading" | "loaded" | "error";

export interface RoleCatalogState {
  status: RoleCatalogStatus;
  /** Always `[]` in every status except `"loaded"` - never a stale list
   * left over from a previous success once a new load starts or fails. */
  roles: RoleRecord[];
  error: string | null;
}

export const INITIAL_ROLE_CATALOG_STATE: RoleCatalogState = {
  status: "idle",
  roles: [],
  error: null,
};

/**
 * Pure, dependency-injected state machine for the role-catalog fetch - no
 * zustand/React/Supabase import, so it is directly Node-testable the same
 * way `computePermissions.ts` is (see `scripts/smoke-role-catalog.ts`).
 * `fetchRoles` is injected so tests can simulate success/failure/call-count
 * without touching the real API/Supabase client; `getState`/`setState` are
 * injected so the same controller can back a zustand store (see
 * `roleCatalogStore.ts`) or a plain in-memory object in a test.
 *
 * Fail-closed by construction: `roles` is only ever non-empty while
 * `status === "loaded"`. A failure leaves `status: "error"` with `roles: []`
 * - it never falls back to a previous success's data, and it never retries
 * on its own (no timer, no loop) - only an explicit `retry()` call attempts
 * again, and `ensureLoaded()`/`retry()` share one in-flight guard so two
 * concurrent callers only ever trigger one network call.
 */
export function createRoleCatalogController(
  fetchRoles: () => Promise<RoleRecord[]>,
  getState: () => RoleCatalogState,
  setState: (next: RoleCatalogState) => void,
) {
  let inFlight: Promise<void> | null = null;

  function run(): Promise<void> {
    if (inFlight) return inFlight;
    setState({ status: "loading", roles: [], error: null });
    inFlight = fetchRoles()
      .then((roles) => {
        setState({ status: "loaded", roles, error: null });
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          roles: [],
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    /** No-ops while already `"loading"` or `"loaded"` - safe to call from
     * every mount site without worrying about duplicate fetches. */
    ensureLoaded: async (): Promise<void> => {
      const { status } = getState();
      if (status === "loading" || status === "loaded") return;
      await run();
    },
    /** Explicit recovery from `"error"` (or a no-op retry from `"idle"`) -
     * never called automatically by this module itself. */
    retry: async (): Promise<void> => {
      const { status } = getState();
      if (status === "loading") return;
      await run();
    },
  };
}
