import { hasPermission } from "../../src/permissions/hasPermission";
import type { Permission } from "../../src/permissions/types";

/**
 * Stage 2 voting-role UI harness - swapped in for the real
 * `src/permissions/usePermissions.ts` ONLY inside `vite.harness.config.ts`
 * (a custom resolveId hook, active only when Vite is run with that config -
 * never in `npm run dev`/`npm run build`). Every real component under test
 * (`ElectionDayPage` and everything it renders) is imported completely
 * unmodified; only the permission SOURCE is pinned to "voting" here, via
 * the same `hasPermission`/`PERMISSIONS_BY_ROLE` engine the real app uses -
 * this is not a second, hand-maintained permission list.
 *
 * "voting" cannot be reached through the real app yet (no DatabaseRole
 * maps to it until the Stage 4 migration - see `resolveEffectiveRole.ts`),
 * so this harness is the only way to exercise voting's real, rendered UI
 * before that migration exists.
 */
export function usePermissions() {
  return {
    role: "voting" as const,
    can: (permission: Permission) => hasPermission("voting", permission),
  };
}
