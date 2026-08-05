import { computePermissions } from "../../src/permissions/computePermissions";
import { BUILT_IN_ROLE_SEED } from "../fixtures/electionDayRoles";

/**
 * Voting-role UI harness - swapped in for the real
 * `src/permissions/usePermissions.ts` ONLY inside `vite.harness.config.ts`
 * (a custom resolveId hook, active only when Vite is run with that config -
 * never in `npm run dev`/`npm run build`). Every real component under test
 * (`ElectionDayPage` and everything it renders) is imported completely
 * unmodified; only the permission SOURCE is pinned to "voting" here, via
 * the same `computePermissions`/`BUILT_IN_ROLE_SEED` engine the real app
 * uses (Dynamic Roles & Permissions Phase 1 - the seed mirrors the live DB
 * catalog) - this is not a second, hand-maintained permission list.
 */
export function usePermissions() {
  return computePermissions("voting", "loaded", BUILT_IN_ROLE_SEED);
}
