import { Card } from "../../components/ui/Card";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { MultiEntityMetrics } from "./MultiEntityMetrics";
import type { MultiEntityAggregateTotals } from "./multiEntityOwnerClient";

const text = MULTI_ENTITY_OWNER_TEXT.summary;

/**
 * Platform Stage 7: the cross-workspace overview. Shows the server's `totals`
 * EXACTLY as returned (summed from released workspaces only) - nothing is
 * recomputed here, and withheld workspaces only appear as a count of how
 * many were left out. With no released workspace at all there is no summary:
 * a notice replaces what would otherwise be a misleading row of zeros.
 */
export function MultiEntitySummaryCard({
  totals,
}: {
  totals: MultiEntityAggregateTotals;
}) {
  const excluded = totals.suppressedWorkspaceCount + totals.endedWorkspaceCount;
  return (
    <Card className="space-y-3" data-testid="summary">
      <div className="space-y-1">
        <h2 className="font-bold text-slate-800">{text.title}</h2>
        <p className="text-sm text-slate-500" data-testid="summary-basis">
          {text.basis(totals.reportedWorkspaceCount, totals.workspaceCount)}
        </p>
        {excluded > 0 && (
          <p className="text-xs text-slate-500" data-testid="summary-excluded">
            {text.excluded(totals.suppressedWorkspaceCount, totals.endedWorkspaceCount)}
          </p>
        )}
      </div>
      {totals.reportedWorkspaceCount > 0 ? (
        <MultiEntityMetrics metrics={totals.metrics} headingLevel="h3" />
      ) : (
        <p
          className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600"
          data-testid="summary-empty"
        >
          {text.noReportable}
        </p>
      )}
    </Card>
  );
}
