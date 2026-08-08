import { Users } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { fmtVotedPct } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { CoordinatorBreakdown } from "./useElectionDay";

const text = ELECTION_DAY_TEXT.dashboard.performance;

function VotedPctBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-11 shrink-0 tabular-nums text-slate-600">
        {fmtVotedPct(pct)}
      </span>
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-primary-500 transition-all duration-500"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

/** Dashboard "ביצועי אחראים" - one row per coordinator (see the extended
 * `CoordinatorBreakdown` in `useElectionDay.ts`) plus a bolded totals row.
 * Replaces the previous `CoordinatorBarCard`'s bar chart + plain table with
 * a single richer table, matching the source design. */
export function CoordinatorPerformanceTable({ rows }: { rows: CoordinatorBreakdown[] }) {
  const totals = rows.reduce(
    (acc, r) => ({
      total: acc.total + r.total,
      voted: acc.voted + r.voted,
      closed: acc.closed + r.closed,
      remaining: acc.remaining + r.remaining,
    }),
    { total: 0, voted: 0, closed: 0, remaining: 0 },
  );
  const totalsVotedPct = totals.total ? (totals.voted / totals.total) * 100 : 0;

  return (
    <Card>
      <CardTitle>{text.title}</CardTitle>
      {rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState icon={Users} title={text.empty} />
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-xs text-slate-400">
                <th className="pb-1.5 text-start font-semibold">
                  {text.columns.coordinator}
                </th>
                <th className="pb-1.5 text-start font-semibold">
                  {text.columns.votedPct}
                </th>
                <th className="pb-1.5 text-start font-semibold">{text.columns.open}</th>
                <th className="pb-1.5 text-start font-semibold">{text.columns.closed}</th>
                <th className="pb-1.5 text-start font-semibold">{text.columns.voted}</th>
                <th className="pb-1.5 text-start font-semibold">
                  {text.columns.assigned}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.coordinator}>
                  <td className="py-1.5 font-semibold text-slate-700">
                    {row.coordinator}
                  </td>
                  <td className="py-1.5">
                    <VotedPctBar pct={row.votedPct} />
                  </td>
                  <td className="py-1.5 tabular-nums text-slate-600">{row.remaining}</td>
                  <td className="py-1.5 tabular-nums text-slate-600">{row.closed}</td>
                  <td className="py-1.5 tabular-nums text-slate-600">{row.voted}</td>
                  <td className="py-1.5 tabular-nums text-slate-600">{row.total}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 font-bold text-slate-800">
                <td className="pt-1.5">{text.totalsRow}</td>
                <td className="pt-1.5">
                  <VotedPctBar pct={totalsVotedPct} />
                </td>
                <td className="pt-1.5 tabular-nums">{totals.remaining}</td>
                <td className="pt-1.5 tabular-nums">{totals.closed}</td>
                <td className="pt-1.5 tabular-nums">{totals.voted}</td>
                <td className="pt-1.5 tabular-nums">{totals.total}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
