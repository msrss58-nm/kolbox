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
 * applied to a route instead of an accordion section. No `isBootstrap`
 * widening anymore - the legacy unauthenticated bootstrap window
 * (`ElectionDayGuard.tsx`'s empty-roster bypass) was removed since it had no
 * reachable create-first-user path left to unlock (`ElectionDayPermissionsPage`
 * already dead-ended on it) and only left an unauthenticated-browsing
 * exposure - see CURRENT_STATUS.md.
 */
export function getVisibleElectionDayNavItems(
  can: (permission: Permission) => boolean,
): NavItem[] {
  const showFiles = can("electionDay.import") || can("electionDay.clearData");
  const showPermissions =
    can("electionDay.manageUsers") || can("electionDay.manageRolesAndPermissions");
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
