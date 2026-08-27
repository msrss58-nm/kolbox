import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { COMMON_TEXT } from "../../constants/common-text";
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
 * Gates `/election-day` behind the trusted server-side session (Phase 3B
 * Step 2/3 - `electionDaySession.ts`'s `bootstrap()`, replacing the
 * pre-Phase-3B synchronous localStorage read) - except while the "ניהול
 * הרשאות משתמשים" roster is still empty, in which case the screen stays
 * open (exactly like before this feature existed) so whoever sets it up can
 * reach the button that adds the first account.
 *
 * Bootstrap (`GET /api/election-day/session`) happens ONLY here, on this
 * component's mount - never globally. `usePermissions()` is called
 * unconditionally from the main app's `AppLayout`, so triggering a fetch
 * from anywhere reachable outside this guard would fire an Election Day
 * session request on every main-app page for every user, Election Day or
 * not.
 */
export function ElectionDayGuard() {
  const fetchPermissionUsers = useCallback(() => api.listPermissionUsers(), []);
  const {
    data: permissionUsers,
    error: rosterError,
    loading: rosterLoading,
    reload: retryRoster,
  } = useAsyncData(fetchPermissionUsers);

  const bootstrap = useElectionDaySession((s) => s.bootstrap);
  const fetchSession = useCallback(() => bootstrap(), [bootstrap]);
  const {
    data: sessionResult,
    loading: sessionLoading,
    reload: retrySession,
  } = useAsyncData(fetchSession);

  // `user` is read only for the roster-empty `isBootstrap` computation
  // below - every actual route-access decision past that point uses
  // `sessionResult.status` (this call's own fresh result), never `user`
  // directly, so a stale in-memory `user` can never grant route access
  // while bootstrap is unresolved or errored (Phase 3B Step 2/3).
  const user = useElectionDaySession((s) => s.user);

  // Wait for the roster fetch to settle - successful data OR an explicit
  // error. An errored fetch must never be read as "still loading" (which
  // spun forever before this fix) nor fall through to the empty-roster
  // check below (which would wrongly grant the bootstrap exception on a
  // transient RPC failure instead of a genuinely empty roster).
  if (permissionUsers === null && !rosterError) {
    return <FullScreenSpinner />;
  }

  if (rosterError) {
    return <ConnectionErrorScreen onRetry={retryRoster} loading={rosterLoading} />;
  }

  if (!permissionUsers) {
    // Unreachable given the two branches above (the roster has settled
    // successfully at this point) - narrows the type explicitly rather than
    // relying on the compiler to connect facts across the compound
    // condition above. No protected route access is granted from here.
    return <FullScreenSpinner />;
  }

  // Only now wait for the session fetch too - matches the pre-existing
  // combined gate's behavior (both fetches settle before any routing
  // decision), just split so a roster error surfaces immediately instead of
  // being masked behind a still-pending session fetch.
  if (sessionResult === null) {
    return <FullScreenSpinner />;
  }

  // Roster-empty bootstrap is checked BEFORE the session-error gate below -
  // deliberately unconditional on session transport state. An empty roster
  // is itself proof no legitimate `PermissionUser` session can exist right
  // now (there is no row for one to resolve against), so a transient
  // session-GET failure must never block the one legitimate use case this
  // exception exists for: creating the very first account, possibly over a
  // flaky connection. `isBootstrap` reads the shared `user` field directly
  // (not `sessionResult.status`) so it still reads `true` on a genuinely
  // fresh tab even while `sessionResult.status === "error"` - it only reads
  // `false` here if `user` is stale-non-null from an earlier successful
  // bootstrap in this same tab, which never blocks the Outlet itself.
  if (permissionUsers.length === 0) {
    return (
      <Outlet
        context={{ isBootstrap: user === null } satisfies ElectionDayOutletContext}
      />
    );
  }

  if (sessionResult.status === "error") {
    return <ConnectionErrorScreen onRetry={retrySession} loading={sessionLoading} />;
  }

  if (sessionResult.status !== "authenticated") {
    return <Navigate to={ROUTES.electionDayLogin} replace />;
  }

  return <Outlet context={{ isBootstrap: false } satisfies ElectionDayOutletContext} />;
}
