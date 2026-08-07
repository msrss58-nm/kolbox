import { useMemo } from "react";
import { Outlet, useNavigate } from "react-router";
import { ROLE_LABELS } from "../constants/labels";
import { NAV_ITEMS, ROUTES } from "../constants/routes";
import { useAuth } from "../features/auth/authStore";
import { useSyncActivistProfile } from "../features/auth/useSyncActivistProfile";
import { AppShell } from "./AppShell";

/** Main app shell - AppShell chrome + Supabase auth identity. Election Day
 * has its own shell (`ElectionDayShell`) with its own nav/identity - the two
 * no longer share a mounted layout (see router.tsx). */
export function AppLayout() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const navigate = useNavigate();
  useSyncActivistProfile(user);

  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.managerOnly || user?.role === "manager"),
    [user?.role],
  );

  const doLogout = async () => {
    await signOut();
    void navigate(ROUTES.login, { replace: true });
  };

  return (
    <AppShell
      navItems={navItems}
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
