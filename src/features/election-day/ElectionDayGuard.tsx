import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { api } from "../../services/api";
import { useElectionDaySession } from "./electionDaySession";

/** Passed to `ElectionDayShell` via `<Outlet context>` - this guard is the
 * single source of truth for whether the roster-empty bootstrap window is
 * active, so the shell never has to re-derive it from its own data fetch. */
export interface ElectionDayOutletContext {
  isBootstrap: boolean;
}

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

  // `isBootstrap` is a narrow exception for reaching the "add first account"
  // button only, not an elevated role - it's false the moment either a real
  // account exists or someone is signed in, and `usePermissions` still
  // resolves this session to `role: null` / zero permissions regardless.
  const isBootstrap = permissionUsers.length === 0 && user === null;

  if (permissionUsers.length === 0)
    return <Outlet context={{ isBootstrap } satisfies ElectionDayOutletContext} />;

  if (!user) return <Navigate to={ROUTES.electionDayLogin} replace />;

  return <Outlet context={{ isBootstrap: false } satisfies ElectionDayOutletContext} />;
}
