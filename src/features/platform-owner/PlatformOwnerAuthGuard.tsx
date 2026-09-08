import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { PlatformOwnerMfaChallengeScreen } from "./PlatformOwnerMfaChallengeScreen";
import { PlatformOwnerMfaEnrollScreen } from "./PlatformOwnerMfaEnrollScreen";
import { usePlatformOwnerSession } from "./platformOwnerSession";

function FullScreenSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface">
      <LogoMark className="size-12 animate-pulse" />
    </div>
  );
}

function BlockedScreen({
  title,
  body,
  primaryLabel,
  onPrimary,
  primaryLoading,
  secondaryLabel,
  onSecondary,
}: {
  title: string;
  body: string;
  primaryLabel: string;
  onPrimary: () => void;
  primaryLoading?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-sm space-y-6 text-center animate-fade-in">
        <div className="flex justify-center">
          <LogoMark className="size-14" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-extrabold text-slate-800">{title}</h2>
          <p className="text-sm text-slate-500">{body}</p>
        </div>
        <div className="space-y-3">
          <Button
            size="lg"
            className="w-full"
            loading={primaryLoading}
            onClick={onPrimary}
          >
            {primaryLabel}
          </Button>
          {secondaryLabel && onSecondary && (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Platform Stage 2: gates the Platform Owner console. This guard is the ONLY
 * place in the app that can decide the console renders, and it is a strict
 * whitelist - `<Outlet />` is returned for exactly one status
 * ("authorized" + a resolved owner) and every other state, including any
 * future/unknown one, falls through to the fail-closed spinner at the bottom.
 *
 * State machine (resolved by `platformOwnerSession.refreshStatus()`):
 *   checking       -> spinner            (fail closed while in flight)
 *   signed_out     -> /platform/login
 *   mfa_enroll     -> enrollment screen  (aal1: the ONLY thing reachable)
 *   mfa_challenge  -> challenge screen   (aal1: the ONLY thing reachable)
 *   forbidden      -> "not authorized"   (aal2 but the server returned 401 -
 *                                         production signup is OPEN, so any
 *                                         self-enrolled user can reach aal2)
 *   error          -> retry screen       (fail closed)
 *   authorized     -> <Outlet />         (server returned 200)
 *
 * The two `aal1` branches render their screens INLINE rather than redirecting
 * to a route, so there is no URL - `/platform`, `/platform/mfa`, or anything
 * added later under this branch - that can render a child while the session
 * is still at `aal1`. `refreshStatus()` also returns before its privileged
 * fetch on those branches, so an `aal1` session never even calls
 * `GET /api/platform/session`.
 *
 * Deliberately a top-level SIBLING guard: never nested under `AppLayout`,
 * `AuthGuard`, `ElectionDayGuard`, or `OwnerAuthGuard`, and it never reads
 * any of their stores (see `platformOwnerSession.ts`'s doc comment).
 */
export function PlatformOwnerAuthGuard() {
  const status = usePlatformOwnerSession((s) => s.status);
  const owner = usePlatformOwnerSession((s) => s.owner);
  const bootstrapped = usePlatformOwnerSession((s) => s.bootstrapped);
  const bootstrap = usePlatformOwnerSession((s) => s.bootstrap);
  const refreshStatus = usePlatformOwnerSession((s) => s.refreshStatus);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);

  useEffect(() => {
    void bootstrap();
    // Runs once per guard mount - `bootstrap` is a stable store action
    // reference, matching `OwnerAuthGuard`'s own one-shot pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!bootstrapped || status === "checking") {
    return <FullScreenSpinner />;
  }

  if (status === "signed_out") {
    return <Navigate to={ROUTES.platformLogin} replace />;
  }

  if (status === "mfa_enroll") {
    return <PlatformOwnerMfaEnrollScreen />;
  }

  if (status === "mfa_challenge") {
    return <PlatformOwnerMfaChallengeScreen />;
  }

  if (status === "forbidden") {
    return (
      <BlockedScreen
        title={PLATFORM_OWNER_TEXT.forbidden.title}
        body={PLATFORM_OWNER_TEXT.forbidden.body}
        primaryLabel={PLATFORM_OWNER_TEXT.forbidden.logout}
        primaryLoading={loggingOut}
        onPrimary={() => void logout()}
      />
    );
  }

  if (status === "error") {
    return (
      <BlockedScreen
        title={PLATFORM_OWNER_TEXT.error.title}
        body={PLATFORM_OWNER_TEXT.error.body}
        primaryLabel={PLATFORM_OWNER_TEXT.error.retry}
        onPrimary={() => void refreshStatus()}
        secondaryLabel={PLATFORM_OWNER_TEXT.error.logout}
        onSecondary={() => void logout()}
      />
    );
  }

  if (status === "authorized" && owner) {
    return <Outlet />;
  }

  // Fail closed - never render the console on an unexpected state.
  return <FullScreenSpinner />;
}
