import { useMemo } from "react";
import { Outlet, useNavigate } from "react-router";
import { toast } from "../components/ui/Toast";
import { COMMON_TEXT } from "../constants/common-text";
import {
  ELECTION_DAY_NAV_SECTION_LABEL,
  NAV_ITEMS,
  ROUTES,
  VOTER_MANAGEMENT_NAV_SECTION_LABEL,
} from "../constants/routes";
import { getVisibleElectionDayNavItems } from "../features/election-day/electionDayNavVisibility";
import { useElectionDaySession } from "../features/election-day/electionDaySession";
import { usePermissions } from "../permissions/usePermissions";
import { AppShell } from "./AppShell";

/** Voter Management's shell - AppShell chrome plus the "יום הבחירות" section
 * built from the SAME `getVisibleElectionDayNavItems` filter `ElectionDayShell`
 * uses, so the two never drift.
 *
 * Legacy-login cutover: the identity here is now the workspace PermissionUser
 * session (the same one Election Day and Budget use), not the retired Supabase
 * campaign user. `VoterManagementGuard` sits ABOVE this shell in the router,
 * so nothing renders here until that session resolved and the workspace was
 * found entitled. */
export function AppLayout() {
  const navigate = useNavigate();
  const sessionUser = useElectionDaySession((s) => s.user);
  const logoutAction = useElectionDaySession((s) => s.logout);
  const { can } = usePermissions();

  const electionDaySections = useMemo(
    () => [
      {
        label: ELECTION_DAY_NAV_SECTION_LABEL,
        items: getVisibleElectionDayNavItems(can),
      },
    ],
    [can],
  );

  // Same contract as the other two shells: a failed DELETE is reported and
  // changes nothing, never reported as a successful sign-out.
  const logout = async () => {
    try {
      await logoutAction();
      navigate(ROUTES.login, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : COMMON_TEXT.genericError);
    }
  };

  return (
    <AppShell
      navItems={NAV_ITEMS}
      navLabel={VOTER_MANAGEMENT_NAV_SECTION_LABEL}
      sections={electionDaySections}
      footer={
        sessionUser
          ? {
              name: sessionUser.name,
              subtitle: VOTER_MANAGEMENT_NAV_SECTION_LABEL,
              onLogout: () => void logout(),
            }
          : undefined
      }
    >
      <Outlet />
    </AppShell>
  );
}
