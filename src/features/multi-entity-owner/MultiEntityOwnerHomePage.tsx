import { useState } from "react";
import { Building2, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { formatClock } from "./multiEntityAggregateFormat";
import {
  MultiEntityDashboardSkeleton,
  MultiEntityLoadError,
} from "./MultiEntityDashboardStates";
import { MultiEntityOwnerPageHeader } from "./MultiEntityOwnerPageHeader";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";
import { MultiEntitySummaryCard } from "./MultiEntitySummaryCard";
import { MultiEntityWorkspaceCard } from "./MultiEntityWorkspaceCard";
import { useMultiEntityAggregates } from "./useMultiEntityAggregates";

const text = MULTI_ENTITY_OWNER_TEXT.home;

/**
 * Platform Stage 7: the Multi-Entity Owner's LIVE dashboard (`/multi-entity`).
 *
 * Rendered only under `MultiEntityOwnerAuthGuard`, i.e. after the server's own
 * 200 for the seat. Its only data source is the Stage 6 aggregate endpoint:
 * a server-summed overview of the workspaces that release numbers, then every
 * currently assigned workspace in the server's order, each marked `reported`
 * (counts), `suppressed` (fewer than 10 contacts) or `ended` (election over) -
 * the last two with NO numbers. Nothing here is persisted, recomputed from
 * hidden rows, or shown as zero when the server withheld it. Historical /
 * post-election figures are not part of this live view.
 *
 * "Refresh" re-runs the full server resolution of the seat; the aggregate
 * read follows it (see useMultiEntityAggregates), so an unassignment
 * disappears and a seat replacement drops to the guard's "forbidden" screen.
 */
export function MultiEntityOwnerHomePage() {
  const context = useMultiEntityOwnerSession((s) => s.context);
  const refreshStatus = useMultiEntityOwnerSession((s) => s.refreshStatus);
  const { result, loading } = useMultiEntityAggregates();
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

  const aggregates = result?.status === "ok" ? result.aggregates : null;
  const failed = result !== null && result.status !== "ok";
  const count = aggregates ? aggregates.workspaces.length : context.workspaces.length;

  let content;
  if (failed) {
    content = (
      <MultiEntityLoadError
        onRetry={() => void refresh()}
        retrying={refreshing || loading}
      />
    );
  } else if (!aggregates) {
    content = <MultiEntityDashboardSkeleton />;
  } else if (aggregates.workspaces.length === 0) {
    content = (
      <Card>
        <EmptyState
          icon={Building2}
          title={text.emptyTitle}
          hint={text.emptyHint}
          dense
        />
      </Card>
    );
  } else {
    content = (
      <>
        <MultiEntitySummaryCard totals={aggregates.totals} />
        <section aria-labelledby="me-workspace-list-title" className="space-y-3">
          <h2 id="me-workspace-list-title" className="font-bold text-slate-800">
            {text.listTitle}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2" data-testid="workspace-list">
            {aggregates.workspaces.map((w) => (
              <li key={w.workspaceId} className="min-w-0">
                <MultiEntityWorkspaceCard workspace={w} />
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  }

  return (
    <div className="min-h-dvh bg-surface">
      <MultiEntityOwnerPageHeader />

      <main
        className="mx-auto max-w-5xl space-y-4 px-4 py-6 md:px-6 md:py-8"
        aria-busy={loading || refreshing}
      >
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-extrabold text-slate-800">{text.title}</h1>
            <p className="text-sm text-slate-500">{text.subtitle}</p>
            <p className="text-sm text-slate-500" data-testid="workspace-count">
              {text.count(count)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <p
              className="text-xs text-slate-400"
              aria-live="polite"
              data-testid="last-updated"
            >
              {result?.status === "ok"
                ? text.lastUpdated(formatClock(result.fetchedAt))
                : ""}
            </p>
            <Button
              variant="secondary"
              onClick={() => void refresh()}
              loading={refreshing}
              className="shrink-0"
              aria-label={text.refresh}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">{text.refresh}</span>
            </Button>
          </div>
        </div>

        {content}

        <p className="text-center text-xs text-slate-400">{text.privacyNote}</p>
      </main>
    </div>
  );
}
