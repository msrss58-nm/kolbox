import {
  ELECTION_DAY_NAV_ITEMS,
  ELECTION_DAY_ROUTES,
  type NavItem,
} from "../../constants/routes";
import type { Permission } from "../../permissions/types";

/**
 * Single source of truth for which of `ELECTION_DAY_NAV_ITEMS` a session can
 * see - extracted verbatim from `ElectionDayShell.tsx` (UX v3.1) so both the
 * main app sidebar (`AppLayout.tsx`) and Election Day's own shell
 * (`ElectionDayShell.tsx`) filter identically. Mirrors exactly what the
 * retired `ElectionDayNav.tsx` accordion's per-category gating checked, just
 * applied to a route instead of an accordion section. `isBootstrap` widens
 * ONLY the permissions screen (same one deliberate exception as before - see
 * `useElectionDay.ts`'s `addPermissionUser` and CLAUDE.md).
 */
export function getVisibleElectionDayNavItems(
  can: (permission: Permission) => boolean,
  isBootstrap: boolean,
): NavItem[] {
  const showFiles = can("electionDay.import") || can("electionDay.clearData");
  const showPermissions =
    can("electionDay.manageUsers") ||
    can("electionDay.manageRolesAndPermissions") ||
    isBootstrap;
  const showRides = can("electionDay.manageRideCoordinators");
  const showReasons =
    can("electionDay.manageNonVotingReasons") || can("voter.viewVotedStatus");
  const showReports = can("electionDay.export");

  return ELECTION_DAY_NAV_ITEMS.filter((item) => {
    if (item.to === ELECTION_DAY_ROUTES.files) return showFiles;
    if (item.to === ELECTION_DAY_ROUTES.permissions) return showPermissions;
    if (item.to === ELECTION_DAY_ROUTES.rides) return showRides;
    if (item.to === ELECTION_DAY_ROUTES.reasons) return showReasons;
    if (item.to === ELECTION_DAY_ROUTES.reports) return showReports;
    return true; // dashboard + voters: always visible to any signed-in session
  });
}
