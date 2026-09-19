import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { PackageX } from "lucide-react";
import { LogoMark } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { COMMON_TEXT } from "../constants/common-text";
import { ROUTES } from "../constants/routes";
import { useElectionDaySession } from "../features/election-day/electionDaySession";
import { useAsyncData } from "../hooks/useAsyncData";
import { APP_SHELL_TEXT } from "./appShell.constants";

/**
 * The module key in `platform_modules` / `election_workspace_modules`. A
 * workspace reaches Voter Management only while the server reports this key
 * among the session's EFFECTIVE modules (entitlement row AND global
 * availability) - the same rule Budget already follows.
 */
const VOTER_MANAGEMENT_MODULE = "voter_management";

/**
 * Gates `/`, `/voters`, `/activists` and `/import` on the trusted
 * server-side workspace session - replacing `AuthGuard`, which gated them on
 * the separate legacy Supabase campaign identity (`profiles`) that this
 * project no longer provisions.
 *
 * Shape deliberately copied from `BudgetGuard`: signed out -> the worker
 * login; a workspace without the module -> a full-page state, never a
 * partially rendered module; a transport failure -> a retry screen, never an
 * implicit grant.
 *
 * FAILS CLOSED. `modules` is optional by contract (the server omits it when
 * the entitlement cannot be read), so an absent, empty or unreadable list is
 * treated as "not entitled". Today `election_day_workspace_worker_modules`
 * reports only `election_day` and `budget`, so this key is never present and
 * the module stays inert until that function is extended by its own
 * migration - which is the intended state: Voter Management has no
 * server-side backend yet.
 *
 * This guard is navigation control, not enforcement. It is the ONLY access
 * control these screens currently have because their data is still
 * per-browser `MockApi`/localStorage with no server surface to authorize.
 * The moment real workspace voter data exists, server-side authorization on
 * every read and write is mandatory and this check must NOT be relied on.
 */
export function VoterManagementGuard() {
  const bootstrap = useElectionDaySession((s) => s.bootstrap);
  const fetchSession = useCallback(() => bootstrap(), [bootstrap]);
  const { data: sessionResult, loading, reload } = useAsyncData(fetchSession);

  if (sessionResult === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }

  // A transport/server failure is not proof of anything - never treat it as
  // either "signed out" (which would bounce a signed-in user out of a
  // working session) or "entitled".
  if (sessionResult.status === "error") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface p-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <LogoMark className="mx-auto size-12" />
          <p className="text-sm text-slate-600">{COMMON_TEXT.networkError}</p>
          <Button onClick={reload} loading={loading}>
            {COMMON_TEXT.retry}
          </Button>
        </div>
      </div>
    );
  }

  // `/` is the Voter Management dashboard, so a signed-out visitor to the bare
  // domain arrives here - send them to the canonical unified entry rather than
  // a principal-specific path. (ElectionDayGuard and BudgetGuard deliberately
  // keep sending signed-out visitors to `/election-day/login`, which renders
  // the same screen; changing those targets would break deep-link expectations
  // for no security or UX gain.)
  if (sessionResult.status !== "authenticated") {
    return <Navigate to={ROUTES.login} replace />;
  }

  if (!sessionResult.user.modules?.includes(VOTER_MANAGEMENT_MODULE)) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface p-6">
        <EmptyState
          icon={PackageX}
          title={APP_SHELL_TEXT.voterManagementUnavailableTitle}
          hint={APP_SHELL_TEXT.voterManagementUnavailableHint}
        />
      </div>
    );
  }

  return <Outlet />;
}
