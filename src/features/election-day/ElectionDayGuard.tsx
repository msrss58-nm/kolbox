import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { api } from "../../services/api";
import { useElectionDaySession } from "./electionDaySession";

/** Gates `/election-day` behind the local session (see `electionDaySession.ts`)
 * - except while the "ניהול הרשאות משתמשים" roster is still empty, in which
 * case the screen stays open (exactly like before this feature existed) so
 * whoever sets it up can reach the button that adds the first account. */
export function ElectionDayGuard() {
  const fetchPermissionUsers = useCallback(() => api.listPermissionUsers(), []);
  const { data: permissionUsers } = useAsyncData(fetchPermissionUsers);
  const user = useElectionDaySession((s) => s.user);

  if (permissionUsers === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }

  if (permissionUsers.length === 0) return <Outlet />;

  if (!user) return <Navigate to={ROUTES.electionDayLogin} replace />;

  return <Outlet />;
}
