import { ListX } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { NonVotingReasonReportRow } from "./nonVotingReasonReport";

const text = ELECTION_DAY_TEXT.nonVotingReasonsReport;

/**
 * Dashboard report card: one clickable row per non-voting reason currently
 * in use, reason name + total count - opens the reason -> coordinator ->
 * voter drill-down (`NonVotingReasonDrillDownModal`) on click. Mirrors
 * `CoordinatorBarCard`'s placement/styling in `ElectionDayDashboard.tsx`.
 */
export function NonVotingReasonsReportCard({
  rows,
  onOpenReasonReport,
}: {
  rows: NonVotingReasonReportRow[];
  onOpenReasonReport: (reasonId: string) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardTitle>🗳️ {text.cardTitle}</CardTitle>
      {rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState icon={ListX} title={text.empty} />
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={row.reasonId}>
              <button
                type="button"
                onClick={() => onOpenReasonReport(row.reasonId)}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-1 py-2 text-start hover:bg-slate-50"
              >
                <span className="min-w-0 truncate text-sm font-semibold text-slate-700">
                  {row.reasonName}
                </span>
                <span className="shrink-0 text-xs font-semibold text-slate-400">
                  {text.rowCount(row.total)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
