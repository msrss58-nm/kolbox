import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { ROUTES } from "../../constants/routes";
import { useOwnerSession } from "./ownerSession";

function FullScreenSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface">
      <LogoMark className="size-12 animate-pulse" />
    </div>
  );
}

/**
 * Phase 3C Roles Mutations: gates the Owner-only route tree behind
 * `useOwnerSession`'s LIVE bootstrap (never a locally-cached session alone -
 * see `ownerSession.ts`'s `bootstrap()`). Mirrors `ElectionDayGuard.tsx`'s
 * structure, but for a completely independent identity - this guard never
 * reads `useElectionDaySession`/`AuthGuard`'s state, and neither of those
 * reads this one's.
 */
export function OwnerAuthGuard() {
  const owner = useOwnerSession((s) => s.owner);
  const bootstrapped = useOwnerSession((s) => s.bootstrapped);
  const bootstrap = useOwnerSession((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
    // Runs once per guard mount - `bootstrap` is a stable store action
    // reference, matching `ElectionDayGuard`'s own one-shot session-fetch
    // pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bootstrapped) {
    return <FullScreenSpinner />;
  }

  if (!owner) {
    return <Navigate to={ROUTES.electionDayOwnerLogin} replace />;
  }

  return <Outlet />;
}
