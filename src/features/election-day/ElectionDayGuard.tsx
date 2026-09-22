import { useCallback } from "react";
import { Navigate, Outlet, useOutletContext } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { COMMON_TEXT } from "../../constants/common-text";
import { ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { EmptyState } from "../../components/ui/EmptyState";
import { PackageX } from "lucide-react";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDaySession } from "./electionDaySession";

/** The entitlement key this shell requires. */
const ELECTION_DAY_MODULE = "election_day";

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

/**
 * The `election_day` entitlement, checked around the module's OWN screens
 * only - deliberately NOT around the shell.
 *
 * A worker can never reach these without the entitlement (`login()` itself
 * refuses with MODULE_NOT_ENABLED), but an Election Owner's session resolves
 * independently of any module: the Owner must still reach their
 * administration sections in a workspace that is entitled to nothing, which
 * is exactly why this gate sits inside the shell rather than in front of it.
 * Same fail-closed treatment of an absent `modules` as VoterManagementGuard;
 * navigation metadata only - every request is re-authorized server-side.
 */
export function ElectionDayModuleGate() {
  const user = useElectionDaySession((s) => s.user);
  // This gate sits BETWEEN the shell and its screens, so it must pass the
  // shell's own outlet context straight through - every Election Day screen
  // reads it with `useOutletContext()`, and swallowing it here would hand
  // them `undefined`.
  const shellContext = useOutletContext<unknown>();
  if (!user?.modules?.includes(ELECTION_DAY_MODULE)) {
    return (
      <div className="grid min-h-[60vh] place-items-center p-6">
        <EmptyState
          icon={PackageX}
          title={ELECTION_DAY_TEXT.session.errors.moduleNotEnabled}
        />
      </div>
    );
  }
  return <Outlet context={shellContext} />;
}

/**
 * `/election-day` itself. The module's dashboard when the workspace is
 * entitled to it; otherwise the Owner's administration area, which is the
 * only thing there is to show. One redirect, no duplicated navigation.
 */
export function ElectionDayIndexRedirect() {
  const user = useElectionDaySession((s) => s.user);
  const entitled = user?.modules?.includes(ELECTION_DAY_MODULE) ?? false;
  return <Navigate to={entitled ? "dashboard" : "owner/users"} replace />;
}
