import {
  Ban,
  BellRing,
  Car,
  CarFront,
  ChartPie,
  CircleCheckBig,
  Clock,
  Handshake,
  PhoneMissed,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  Cell,
  Legend,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { CHART_TOOLTIP_STYLE_COMPACT } from "../../constants/chart";
import { fmtVotedPct } from "../../lib/utils";
import { PermissionGuard } from "../../permissions/PermissionGuard";
import type { ElectionDayVoter } from "../../types";
import { AttentionAlertsCard } from "./AttentionAlertsCard";
import type { AttentionAlertRow } from "./attentionAlerts";
import { CallAttemptsWatchlistCard } from "./CallAttemptsWatchlistCard";
import type { ClosedReasonBreakdownRow } from "./closedReasonBreakdown";
import { CoordinatorPerformanceTable } from "./CoordinatorPerformanceTable";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayStatTile } from "./ElectionDayStatTile";
import type { CallAttemptsWatchlistRow, FollowUpBreakdown } from "./followUpBreakdown";
import type { NonVotingReasonReportRow } from "./nonVotingReasonReport";
import { NonVotingReasonsReportCard } from "./NonVotingReasonsReportCard";
import { RideCoordinationTable } from "./RideCoordinationTable";
import type { RideStatusBreakdown } from "./rideStatusBreakdown";
import { TurnoutPaceCard } from "./TurnoutPaceCard";
import type { TurnoutPaceResult } from "./turnoutPace";
import type { CoordinatorBreakdown, ElectionDayStats } from "./useElectionDay";

/** Big, prominent voting-turnout bar - the headline number of the page. */
function VotingProgressBar({ stats }: { stats: ElectionDayStats }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 text-sm font-bold text-slate-700">
        <span>📈 {ELECTION_DAY_TEXT.dashboard.votingProgress.title}</span>
        <span className="tabular-nums text-slate-500">{fmtVotedPct(stats.votedPct)}</span>
      </div>
      <div className="relative mt-3 h-4.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${stats.votedPct}%`,
            background: "linear-gradient(90deg, #00a400, #4db8ff)",
          }}
        />
      </div>
      <p className="mt-1.5 text-xs font-semibold text-slate-500">
        {ELECTION_DAY_TEXT.dashboard.votingProgress.progressLabel(
          stats.voted,
          stats.total,
        )}
      </p>
    </Card>
  );
}

function RefreshRow({
  lastUpdatedAt,
  onRefresh,
}: {
  lastUpdatedAt: number | null;
  onRefresh: () => void;
}) {
  const time = lastUpdatedAt
    ? new Date(lastUpdatedAt).toLocaleTimeString("he-IL", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs font-semibold text-slate-400">
      {time && <span>{ELECTION_DAY_TEXT.dashboard.refresh.lastUpdated(time)}</span>}
      <button
        type="button"
        onClick={onRefresh}
        aria-label={ELECTION_DAY_TEXT.dashboard.refresh.label}
        className="grid size-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        <RefreshCw className="size-4" />
      </button>
    </div>
  );
}

function VotingPieChart({ stats }: { stats: ElectionDayStats }) {
  const data = [
    { name: ELECTION_DAY_TEXT.dashboard.votingProgress.voted, value: stats.voted },
    { name: ELECTION_DAY_TEXT.dashboard.votingProgress.notVoted, value: stats.notVoted },
  ];
  const colors = ["#00a400", "#e4e6eb"];

  return (
    <Card className="min-w-0">
      <CardTitle>📊 {ELECTION_DAY_TEXT.dashboard.votingProgress.pieTitle}</CardTitle>
      <div className="mt-2 h-56">
        {stats.total > 0 ? (
          <ResponsiveContainer>
            <RechartsPieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={50}
                outerRadius={75}
                paddingAngle={2}
              >
                {data.map((entry, i) => (
                  <Cell key={entry.name} fill={colors[i]} />
                ))}
              </Pie>
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE_COMPACT} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </RechartsPieChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full" />
        )}
      </div>
    </Card>
  );
}

export function ElectionDayDashboard({
  stats,
  coordinatorBreakdown,
  followUpBreakdown,
  rideStatusBreakdown,
  attentionAlerts,
  turnoutPace,
  lastUpdatedAt,
  onRefresh,
  rideCoordinationQueue,
  onToggleRideCompleted,
  nonVotingReasonReport,
  onOpenReasonReport,
  closedReasonBreakdown,
  closedRemindersToday,
  callAttemptsWatchlist,
  onOpenVoter,
  loaded,
}: {
  stats: ElectionDayStats;
  coordinatorBreakdown: CoordinatorBreakdown[];
  followUpBreakdown: FollowUpBreakdown;
  rideStatusBreakdown: RideStatusBreakdown;
  attentionAlerts: AttentionAlertRow[];
  turnoutPace: TurnoutPaceResult;
  lastUpdatedAt: number | null;
  onRefresh: () => void;
  rideCoordinationQueue: ElectionDayVoter[];
  onToggleRideCompleted: (contact: ElectionDayVoter, completed: boolean) => void;
  nonVotingReasonReport: NonVotingReasonReportRow[];
  onOpenReasonReport: (reasonId: string) => void;
  closedReasonBreakdown: ClosedReasonBreakdownRow[];
  /** Reminder Lifecycle v1 - count of reminders closed today (see
   * `useElectionDay.ts`'s `closedRemindersToday`), feeds row 3's
   * `closedToday` tile (replaces the old `notYetHandled` tile). */
  closedRemindersToday: number;
  /** "בוחרים עם 2+ ניסיונות חיוג" card - same rows the `callAttempts2Plus`
   * KPI tile counts (see `followUpBreakdown.ts`). */
  callAttemptsWatchlist: CallAttemptsWatchlistRow[];
  onOpenVoter: (id: string) => void;
  loaded: boolean;
}) {
  const followUpText = ELECTION_DAY_TEXT.dashboard.followUp;
  const rideStatusText = ELECTION_DAY_TEXT.dashboard.rideStatus;

  if (!loaded) {
    return (
      <div className="mb-6 space-y-4">
        <Skeleton className="h-24 rounded-2xl" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[...Array(4)].map((_, j) => (
              <Skeleton key={j} className="h-20 rounded-2xl" />
            ))}
          </div>
        ))}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 space-y-4">
      <RefreshRow lastUpdatedAt={lastUpdatedAt} onRefresh={onRefresh} />
      <VotingProgressBar stats={stats} />

      {/* Row 1: the 4 headline metrics. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ElectionDayStatTile
          icon={Users}
          tone="purple"
          label={ELECTION_DAY_TEXT.dashboard.votingProgress.totalVoters}
          value={stats.total}
        />
        <ElectionDayStatTile
          icon={CircleCheckBig}
          tone="success"
          label={ELECTION_DAY_TEXT.dashboard.votingProgress.totalVoted}
          value={stats.voted}
        />
        <ElectionDayStatTile
          icon={ChartPie}
          tone="info"
          label={ELECTION_DAY_TEXT.dashboard.votingProgress.votingPct}
          value={fmtVotedPct(stats.votedPct)}
        />
        <ElectionDayStatTile
          icon={Clock}
          tone="warning"
          label={ELECTION_DAY_TEXT.dashboard.worklist.remaining}
          value={stats.remaining}
        />
      </div>

      {/* Row 2: "סה"כ נסגרו" first, then a variable number of per-reason
          tiles - flex-wrap so any number of reasons (including zero) lays
          out cleanly. */}
      <div className="flex flex-wrap gap-3">
        <div className="min-w-28 flex-1 basis-32 sm:max-w-56">
          <ElectionDayStatTile
            icon={CircleCheckBig}
            tone="success"
            label={ELECTION_DAY_TEXT.dashboard.worklist.totalClosed}
            value={stats.closed}
          />
        </div>
        {closedReasonBreakdown.map((row) => (
          <div key={row.reasonId} className="min-w-28 flex-1 basis-32 sm:max-w-56">
            <ElectionDayStatTile
              icon={Ban}
              tone="slate"
              label={row.reasonName}
              value={row.count}
            />
          </div>
        ))}
      </div>

      {/* Row 3: "מה דורש טיפול עכשיו" - see `followUpBreakdown.ts`. */}
      <PermissionGuard permission="voter.viewVotedStatus">
        <div>
          <p className="mb-2 text-xs font-bold text-slate-500">{followUpText.title}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ElectionDayStatTile
              icon={PhoneMissed}
              tone="danger"
              label={followUpText.callAttempts2Plus}
              value={followUpBreakdown.callAttempts2Plus}
            />
            <ElectionDayStatTile
              icon={BellRing}
              tone="success"
              label={followUpText.reminderDue}
              value={followUpBreakdown.reminderDue}
            />
            <ElectionDayStatTile
              icon={Clock}
              tone="purple"
              label={followUpText.reminderWaiting}
              value={followUpBreakdown.reminderWaiting}
            />
            <ElectionDayStatTile
              icon={CircleCheckBig}
              tone="info"
              label={followUpText.closedToday}
              value={closedRemindersToday}
            />
          </div>
        </div>
      </PermissionGuard>

      {/* Row 4: ride pipeline counts - see `rideStatusBreakdown.ts`. */}
      <PermissionGuard permission="voter.viewRideStatus">
        <div>
          <p className="mb-2 text-xs font-bold text-slate-500">{rideStatusText.title}</p>
          <div className="grid grid-cols-3 gap-3">
            <ElectionDayStatTile
              icon={Car}
              tone="warning"
              label={rideStatusText.needsRide}
              value={rideStatusBreakdown.needsRide}
            />
            <ElectionDayStatTile
              icon={Handshake}
              tone="purple"
              label={rideStatusText.arranged}
              value={rideStatusBreakdown.arranged}
            />
            <ElectionDayStatTile
              icon={CarFront}
              tone="success"
              label={rideStatusText.completed}
              value={rideStatusBreakdown.completed}
            />
          </div>
        </div>
      </PermissionGuard>

      <div className="grid gap-4 md:grid-cols-2">
        <PermissionGuard permission="voter.viewCoordinator">
          <CoordinatorPerformanceTable rows={coordinatorBreakdown} />
        </PermissionGuard>
        <TurnoutPaceCard pace={turnoutPace} loaded={loaded} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AttentionAlertsCard rows={attentionAlerts} />
        <VotingPieChart stats={stats} />
        <PermissionGuard permission="voter.viewRideStatus">
          <RideCoordinationTable
            contacts={rideCoordinationQueue}
            onToggleCompleted={onToggleRideCompleted}
          />
        </PermissionGuard>
        <PermissionGuard permission="voter.viewVotedStatus">
          <NonVotingReasonsReportCard
            rows={nonVotingReasonReport}
            onOpenReasonReport={onOpenReasonReport}
          />
        </PermissionGuard>
        <CallAttemptsWatchlistCard
          rows={callAttemptsWatchlist}
          onOpenVoter={onOpenVoter}
        />
      </div>
    </div>
  );
}
