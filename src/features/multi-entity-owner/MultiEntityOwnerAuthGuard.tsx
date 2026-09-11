import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { ROUTES } from "../../constants/routes";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { MultiEntityOwnerMfaChallengeScreen } from "./MultiEntityOwnerMfaChallengeScreen";
import { MultiEntityOwnerMfaEnrollScreen } from "./MultiEntityOwnerMfaEnrollScreen";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

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
 * Platform Stage 5: gates the Multi-Entity Owner surface. A strict whitelist -
 * `<Outlet />` renders for exactly one state ("authorized" + a server-returned
 * context); every other state, including any unknown one, fails closed.
 *
 *   checking       -> spinner
 *   signed_out     -> /multi-entity/login
 *   mfa_enroll     -> enrollment screen, INLINE (aal1 - no URL can bypass it)
 *   mfa_challenge  -> challenge screen, INLINE
 *   forbidden      -> "not authorized" (aal2, server 401: not / no longer the
 *                     seat holder - replaced, revoked, or a dual principal)
 *   error          -> retry screen
 *   authorized     -> <Outlet />
 *
 * UX ONLY - the server re-verifies aal2 and the seat on every request. The
 * guard additionally re-resolves when the tab becomes visible again, so an
 * unassignment or replacement made while the tab was in the background shows
 * up without a manual reload (the server would refuse a stale request anyway).
 *
 * A top-level guard: never nested under any other principal's guard, and it
 * never reads any other principal's store.
 */
export function MultiEntityOwnerAuthGuard() {
  const status = useMultiEntityOwnerSession((s) => s.status);
  const context = useMultiEntityOwnerSession((s) => s.context);
  const bootstrapped = useMultiEntityOwnerSession((s) => s.bootstrapped);
  const bootstrap = useMultiEntityOwnerSession((s) => s.bootstrap);
  const refreshStatus = useMultiEntityOwnerSession((s) => s.refreshStatus);
  const logout = useMultiEntityOwnerSession((s) => s.logout);
  const loggingOut = useMultiEntityOwnerSession((s) => s.loggingOut);

  useEffect(() => {
    void bootstrap();
    // One-shot per mount - `bootstrap` is a stable store action reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const state = useMultiEntityOwnerSession.getState();
      if (state.status === "authorized") void state.refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (!bootstrapped || status === "checking") {
    return <FullScreenSpinner />;
  }

  if (status === "signed_out") {
    return <Navigate to={ROUTES.multiEntityLogin} replace />;
  }

  if (status === "mfa_enroll") {
    return <MultiEntityOwnerMfaEnrollScreen />;
  }

  if (status === "mfa_challenge") {
    return <MultiEntityOwnerMfaChallengeScreen />;
  }

  if (status === "forbidden") {
    return (
      <BlockedScreen
        title={MULTI_ENTITY_OWNER_TEXT.forbidden.title}
        body={MULTI_ENTITY_OWNER_TEXT.forbidden.body}
        primaryLabel={MULTI_ENTITY_OWNER_TEXT.forbidden.logout}
        primaryLoading={loggingOut}
        onPrimary={() => void logout()}
      />
    );
  }

  if (status === "error") {
    return (
      <BlockedScreen
        title={MULTI_ENTITY_OWNER_TEXT.error.title}
        body={MULTI_ENTITY_OWNER_TEXT.error.body}
        primaryLabel={MULTI_ENTITY_OWNER_TEXT.error.retry}
        onPrimary={() => void refreshStatus()}
        secondaryLabel={MULTI_ENTITY_OWNER_TEXT.error.logout}
        onSecondary={() => void logout()}
      />
    );
  }

  if (status === "authorized" && context) {
    return <Outlet />;
  }

  return <FullScreenSpinner />;
}
