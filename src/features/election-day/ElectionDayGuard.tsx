import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { COMMON_TEXT } from "../../constants/common-text";
import { ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useElectionDaySession } from "./electionDaySession";

function FullScreenSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface">
      <LogoMark className="size-12 animate-pulse" />
    </div>
  );
}

/** Shared by the roster-fetch and session-fetch error branches below so the
 * two independent failures (each with its own retry) don't duplicate this
 * markup/copy. */
function ConnectionErrorScreen({
  onRetry,
  loading,
}: {
  onRetry: () => void;
  loading: boolean;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <LogoMark className="mx-auto size-12" />
        <p className="text-sm text-slate-600">{COMMON_TEXT.networkError}</p>
        <Button onClick={onRetry} loading={loading}>
          {COMMON_TEXT.retry}
        </Button>
      </div>
    </div>
  );
}

/**
 * Gates `/election-day` behind the trusted server-side session
 * (`electionDaySession.ts`'s `bootstrap()`). An unauthenticated visitor
 * always resolves through this session check and, if no valid session
 * exists, is sent to the login screen - there is no longer any
 * unauthenticated bypass.
 *
 * The pre-session, roster-emptiness "bootstrap window" that used to grant
 * open `<Outlet>` access whenever the (legacy, global, cross-workspace-
 * unscoped) PermissionUser roster was empty has been removed: the one thing
 * it existed to unlock (a first-account creation form) was already dead
 * code (`ElectionDayPermissionsPage` rendered a static "setup required"
 * dead-end whenever `isBootstrap` was true, with no reachable call to any
 * create-user RPC), so all that check still did in practice was expose
 * Dashboard/Voters to an unauthenticated browser whenever the global roster
 * happened to be empty - a real, if not currently reachable, exposure in a
 * multi-tenant world where a brand-new workspace legitimately starts with
 * zero PermissionUsers. See CURRENT_STATUS.md for the full analysis. A
 * future first-user path for a new workspace must be Owner-authenticated
 * (Supabase Auth, via the Multi-Tenant pending-access/first-login
 * architecture) - a separate, not-yet-built workstream, not this check.
 *
 * Bootstrap (`GET /api/election-day/session`) happens ONLY here, on this
 * component's mount - never globally. `usePermissions()` is called
 * unconditionally from the main app's `AppLayout`, so triggering a fetch
 * from anywhere reachable outside this guard would fire an Election Day
 * session request on every main-app page for every user, Election Day or
 * not.
 */
export function ElectionDayGuard() {
  const bootstrap = useElectionDaySession((s) => s.bootstrap);
  const fetchSession = useCallback(() => bootstrap(), [bootstrap]);
  const {
    data: sessionResult,
    loading: sessionLoading,
    reload: retrySession,
  } = useAsyncData(fetchSession);

  if (sessionResult === null) {
    return <FullScreenSpinner />;
  }

  if (sessionResult.status === "error") {
    return <ConnectionErrorScreen onRetry={retrySession} loading={sessionLoading} />;
  }

  if (sessionResult.status !== "authenticated") {
    return <Navigate to={ROUTES.electionDayLogin} replace />;
  }

  return <Outlet />;
}
