import { create } from "zustand";
import { api } from "../services/api";
import {
  createRoleCatalogController,
  INITIAL_ROLE_CATALOG_STATE,
  type RoleCatalogState,
} from "./roleCatalogController";

interface RoleCatalogStore extends RoleCatalogState {
  ensureLoaded: () => Promise<void>;
  retry: () => Promise<void>;
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
    () => api.listElectionDayRoles(),
    () => get(),
    (next) => set(next),
  );

  return {
    ...INITIAL_ROLE_CATALOG_STATE,
    ensureLoaded: controller.ensureLoaded,
    retry: controller.retry,
  };
});
