import { ArrowLeft, CheckCircle2, Clock, History, Percent, Users } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { fmtRelative } from "../../lib/utils";
import type { RideStatusEvent } from "../../types";
import { KpiCard } from "../dashboard/KpiCard";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { RideStatusBadge } from "./RideStatusBadge";
import type { CoordinatorBreakdown, ElectionDayStats } from "./useElectionDay";

const RECENT_ACTIVITY_SIZE = 5;

function CoordinatorProgressRow({ row }: { row: CoordinatorBreakdown }) {
  const pct = row.total ? Math.round((row.arranged / row.total) * 100) : 0;
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate font-semibold text-slate-700">{row.coordinator}</span>
        <span className="shrink-0 tabular-nums text-slate-500">
          {row.arranged}/{row.total}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-gradient-to-l from-primary-500 to-violet-500 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** One log line: who, the before→after status change (kept even after a
 * later toggle reverts it - see `RideStatusEvent`), and when. Laid out as
 * three equal-width tracks so the transition sits genuinely centered
 * instead of everything bunched against one edge. */
function ActivityLogRow({ event }: { event: RideStatusEvent }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate font-semibold text-slate-700">{event.contactName}</p>
        <p className="truncate text-xs text-slate-400">{event.coordinator}</p>
      </div>
      <div className="flex items-center gap-1.5 justify-self-center">
        <RideStatusBadge arranged={event.from} />
        <ArrowLeft className="size-3.5 shrink-0 text-slate-300" />
        <RideStatusBadge arranged={event.to} />
      </div>
      <span className="justify-self-end text-xs text-slate-400">
        {fmtRelative(event.at)}
      </span>
    </li>
  );
}

function RecentActivityCard({ events }: { events: RideStatusEvent[] }) {
  const recent = events.slice(0, RECENT_ACTIVITY_SIZE);

  return (
    <Card>
      <CardTitle className="flex items-center gap-2">
        <History className="size-4 text-primary-500" />
        {ELECTION_DAY_TEXT.dashboard.recentActivity.title}
      </CardTitle>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">
          {ELECTION_DAY_TEXT.dashboard.recentActivity.empty}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100">
          {recent.map((event) => (
            <ActivityLogRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ElectionDayDashboard({
  stats,
  coordinatorBreakdown,
  events,
  loaded,
}: {
  stats: ElectionDayStats;
  coordinatorBreakdown: CoordinatorBreakdown[];
  events: RideStatusEvent[];
  loaded: boolean;
}) {
  return (
    <div className="mb-6 space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loaded ? (
          <>
            <KpiCard
              icon={Users}
              label={ELECTION_DAY_TEXT.dashboard.totalContacts}
              value={stats.total}
            />
            <KpiCard
              icon={CheckCircle2}
              label={ELECTION_DAY_TEXT.dashboard.arranged}
              value={stats.arranged}
              tone="supporter"
            />
            <KpiCard
              icon={Clock}
              label={ELECTION_DAY_TEXT.dashboard.remaining}
              value={stats.remaining}
              tone="potential"
            />
            <KpiCard
              icon={Percent}
              label={ELECTION_DAY_TEXT.dashboard.coveragePct}
              value={stats.coveragePct}
              suffix="%"
              tone="primary"
            />
          </>
        ) : (
          [...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-2xl" />
          ))
        )}
      </div>

      {loaded && (
        <div className="grid gap-4 md:grid-cols-2">
          {coordinatorBreakdown.length > 0 && (
            <Card>
              <CardTitle>{ELECTION_DAY_TEXT.dashboard.byCoordinator}</CardTitle>
              <div className="mt-1 divide-y divide-slate-100">
                {coordinatorBreakdown.map((row) => (
                  <CoordinatorProgressRow key={row.coordinator} row={row} />
                ))}
              </div>
            </Card>
          )}

          <RecentActivityCard events={events} />
        </div>
      )}
    </div>
  );
}
