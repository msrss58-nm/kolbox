import { create } from "zustand";
import { fetchTrustedRoles } from "../features/election-day/electionDayTrustedRolesClient";
import {
  createRoleCatalogController,
  INITIAL_ROLE_CATALOG_STATE,
  type RoleCatalogState,
} from "./roleCatalogController";
import { normalizeRoleRecord } from "./roleRecordMapper";

// Phase 3C Roles: role-catalog READ cut over to the trusted, session-derived
// v3 path (`electionDayTrustedRolesClient.ts` + `api/election-day/roles.ts`
// + `election_day_list_roles_v3`) - mirrors `useRoleManagement.ts`'s own
// cutover exactly. A non-"ok" result throws so this fetcher's error contract
// matches the legacy `api.listElectionDayRoles()` call it replaces (which
// threw via `unwrapArray` on an RPC error) - `createRoleCatalogController`'s
// existing loading/error handling is unchanged. Row validation (permissions/
// scope_type fail-closed handling via `normalizeRoleRecord`) is unchanged.
async function fetchRolesTrusted() {
  const result = await fetchTrustedRoles();
  if (result.status !== "ok") {
    throw new Error(result.status);
  }
  return result.rows.map(normalizeRoleRecord);
}

interface RoleCatalogStore extends RoleCatalogState {
  ensureLoaded: () => Promise<void>;
  retry: () => Promise<void>;
  /** Always refetches, even while already `"loaded"` - see
   * `roleCatalogController.ts`'s `reload` for why (Phase 2 role mutations). */
  reload: () => Promise<void>;
}

/**
 * The live `election_day_roles` catalog (Dynamic Roles & Permissions,
 * Phase 1) - fetched once and cached for the tab's lifetime, not per
 * component. `usePermissions()` is the only reader. Kept as its own store
 * (rather than folded into `electionDaySession`) so a role-catalog fetch
 * never blocks on or couples to login itself; `electionDaySession.login()`
 * still kicks off `ensureLoaded()` proactively so an interactive login has
 * the catalog in flight immediately rather than waiting for the first
 * `usePermissions()` mount.
 *
 * Thin wrapper around `createRoleCatalogController` (the actual pure state
 * machine) - this file's only job is supplying the real `api` singleton and
 * zustand's `get`/`set` as that controller's injected dependencies.
 */
export const useRoleCatalogStore = create<RoleCatalogStore>((set, get) => {
  const controller = createRoleCatalogController(
    fetchRolesTrusted,
    () => get(),
    (next) => set(next),
  );

  return {
    ...INITIAL_ROLE_CATALOG_STATE,
    ensureLoaded: controller.ensureLoaded,
    retry: controller.retry,
    reload: controller.reload,
  };
});
