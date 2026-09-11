import { useState } from "react";
import { CalendarClock, ChevronRight, RefreshCw, ShieldOff } from "lucide-react";
import { Link, useParams } from "react-router";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { ROUTES } from "../../constants/routes";
import { formatDateTime } from "../platform-owner/multiEntityFormat";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { formatClock } from "./multiEntityAggregateFormat";
import {
  MultiEntityDashboardSkeleton,
  MultiEntityLoadError,
} from "./MultiEntityDashboardStates";
import { MultiEntityMetrics } from "./MultiEntityMetrics";
import { MultiEntityOwnerPageHeader } from "./MultiEntityOwnerPageHeader";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";
import {
  MultiEntityStatusBadge,
  MultiEntityWithheldNotice,
} from "./MultiEntityWorkspaceCard";
import { useMultiEntityWorkspaceAggregate } from "./useMultiEntityAggregates";

const text = MULTI_ENTITY_OWNER_TEXT;

const backLinkClass =
  "inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary-700 hover:bg-primary-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500";

/**
 * Platform Stage 7: one assigned workspace in focus
 * (`/multi-entity/workspaces/:workspaceId`), read from the Stage 6
 * single-workspace aggregate endpoint - the same numbers as its dashboard
 * card, nothing more. The id in the URL is UNTRUSTED: the server authorizes
 * it on every read, and an unassigned or nonexistent id is the same
 * "not available" state (403 from the server; a malformed id never leaves the
 * browser).
 */
export function MultiEntityOwnerWorkspacePage() {
  const { workspaceId = "" } = useParams();
  const context = useMultiEntityOwnerSession((s) => s.context);
  const refreshStatus = useMultiEntityOwnerSession((s) => s.refreshStatus);
  const { result, loading } = useMultiEntityWorkspaceAggregate(workspaceId);
  const [refreshing, setRefreshing] = useState(false);

  if (!context) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const workspace = result?.status === "ok" ? result.workspace : null;

  let content;
  if (result === null) {
    content = <MultiEntityDashboardSkeleton />;
  } else if (result.status === "not_assigned") {
    content = (
      <Card data-testid="workspace-not-available">
        <EmptyState
          icon={ShieldOff}
          title={text.detail.notAssigned.title}
          hint={text.detail.notAssigned.body}
          dense
          action={
            <Link to={ROUTES.multiEntityHome} className={backLinkClass}>
              {text.detail.back}
            </Link>
          }
        />
      </Card>
    );
  } else if (!workspace) {
    content = (
      <MultiEntityLoadError
        onRetry={() => void refresh()}
        retrying={refreshing || loading}
      />
    );
  } else {
    content = (
      <Card
        className="space-y-4"
        data-testid="workspace-detail"
        data-status={workspace.status}
      >
        <div className="flex flex-wrap items-center gap-3">
          <MultiEntityStatusBadge status={workspace.status} />
          <p className="flex items-center gap-1.5 text-sm text-slate-500">
            <CalendarClock
              className="size-4 shrink-0 text-slate-400"
              aria-hidden="true"
            />
            {text.home.endsAtLabel}: {formatDateTime(workspace.electionEndAt)}
          </p>
        </div>
        {workspace.status === "reported" && workspace.metrics ? (
          <MultiEntityMetrics metrics={workspace.metrics} headingLevel="h2" />
        ) : workspace.status === "reported" ? null : (
          <MultiEntityWithheldNotice status={workspace.status} />
        )}
      </Card>
    );
  }

  return (
    <div className="min-h-dvh bg-surface">
      <MultiEntityOwnerPageHeader />
      <main
        className="mx-auto max-w-3xl space-y-4 px-4 py-6 md:px-6 md:py-8"
        aria-busy={loading || refreshing}
      >
        <Link
          to={ROUTES.multiEntityHome}
          className={backLinkClass}
          data-testid="back-to-dashboard"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
          {text.detail.back}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="min-w-0 break-words text-2xl font-extrabold text-slate-800">
            {workspace?.name ?? text.detail.title}
          </h1>
          <div className="flex items-center gap-2">
            <p
              className="text-xs text-slate-400"
              aria-live="polite"
              data-testid="last-updated"
            >
              {result?.status === "ok"
                ? text.home.lastUpdated(formatClock(result.fetchedAt))
                : ""}
            </p>
            <Button
              variant="secondary"
              onClick={() => void refresh()}
              loading={refreshing}
              className="shrink-0"
              aria-label={text.home.refresh}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{text.home.refresh}</span>
            </Button>
          </div>
        </div>
        {content}
        <p className="text-center text-xs text-slate-400">{text.home.privacyNote}</p>
      </main>
    </div>
  );
}
