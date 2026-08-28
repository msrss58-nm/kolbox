import { useMemo } from "react";
import { Outlet, useNavigate } from "react-router";
import { ROLE_LABELS } from "../constants/labels";
import { ELECTION_DAY_NAV_SECTION_LABEL, NAV_ITEMS, ROUTES } from "../constants/routes";
import { useAuth } from "../features/auth/authStore";
import { useSyncActivistProfile } from "../features/auth/useSyncActivistProfile";
import { getVisibleElectionDayNavItems } from "../features/election-day/electionDayNavVisibility";
import { usePermissions } from "../permissions/usePermissions";
import { AppShell } from "./AppShell";

/** Main app shell - AppShell chrome + Supabase auth identity, plus (UX v3.1)
 * an "יום הבחירות" section built from the SAME `getVisibleElectionDayNavItems`
 * filter `ElectionDayShell` uses, so the two never drift. Election Day still
 * has its own shell (`ElectionDayShell`) with its own nav/identity - the two
 * don't share a mounted layout (see router.tsx). */
export function AppLayout() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const navigate = useNavigate();
  useSyncActivistProfile(user);
  const { can } = usePermissions();

  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.managerOnly || user?.role === "manager"),
    [user?.role],
  );

  const electionDaySections = useMemo(
    () => [
      {
        label: ELECTION_DAY_NAV_SECTION_LABEL,
        items: getVisibleElectionDayNavItems(can),
      },
    ],
    [can],
  );

  const doLogout = async () => {
    await signOut();
    void navigate(ROUTES.login, { replace: true });
  };

  return (
    <AppShell
      navItems={navItems}
      sections={electionDaySections}
      footer={
        user
          ? {
              name: user.name,
              subtitle: user.role ? ROLE_LABELS[user.role] : "",
              onLogout: () => void doLogout(),
            }
          : undefined
      }
    >
      <Outlet />
    </AppShell>
  );
}
