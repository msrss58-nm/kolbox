import { useCallback } from "react";
import { Navigate, Outlet } from "react-router";
import { Lock, PackageX } from "lucide-react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { COMMON_TEXT } from "../../constants/common-text";
import { ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { BUDGET_TEXT } from "./budget.constants";
import { useBudgetSession } from "./budgetSession";

/**
 * Gates `/budget/*` on the server's Budget session op: a signed-out visitor
 * goes to the worker login; a workspace without Budget, or a role without
 * budget.view, gets a full-page state - never a partially rendered module.
 * The server re-checks everything on every request regardless.
 */
export function BudgetGuard() {
  const load = useBudgetSession((s) => s.load);
  const fetchStatus = useCallback(() => load(), [load]);
  const { data: status, loading, reload } = useAsyncData(fetchStatus);

  if (status === null) {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }
  if (status === "unauthenticated") {
    return <Navigate to={ROUTES.electionDayLogin} replace />;
  }
  if (status === "unavailable" || status === "forbidden") {
    const unavailable = status === "unavailable";
    return (
      <div className="grid min-h-dvh place-items-center bg-surface p-6">
        <EmptyState
          icon={unavailable ? PackageX : Lock}
          title={unavailable ? BUDGET_TEXT.guard.unavailableTitle : BUDGET_TEXT.guard.forbiddenTitle}
          hint={unavailable ? BUDGET_TEXT.guard.unavailableHint : BUDGET_TEXT.guard.forbiddenHint}
        />
      </div>
    );
  }
  if (status !== "ready") {
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
  return <Outlet />;
}
