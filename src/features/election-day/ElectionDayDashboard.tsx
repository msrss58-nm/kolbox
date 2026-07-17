import type { ReactNode } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { CHART_TOOLTIP_STYLE_COMPACT } from "../../constants/chart";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { CoordinatorBreakdown, ElectionDayStats } from "./useElectionDay";

/** Big, prominent voting-turnout bar - the headline number of the page. */
function VotingProgressBar({ stats }: { stats: ElectionDayStats }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 text-sm font-bold text-slate-700">
        <span>📈 {ELECTION_DAY_TEXT.dashboard.votingProgress.title}</span>
        <span className="tabular-nums text-slate-500">{stats.votedPct}%</span>
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

function StatCard({
  label,
  value,
  suffix = "",
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <Card className="p-3.5 text-center">
      <h3 className="text-xs font-semibold text-slate-500">{label}</h3>
      <p className="mt-1.5 text-2xl font-extrabold tabular-nums text-primary-600">
        {value}
        {suffix}
      </p>
    </Card>
  );
}

function VotingPieChart({ stats }: { stats: ElectionDayStats }) {
  const data = [
    { name: ELECTION_DAY_TEXT.dashboard.votingProgress.voted, value: stats.voted },
    { name: ELECTION_DAY_TEXT.dashboard.votingProgress.notVoted, value: stats.notVoted },
  ];
  const colors = ["#00a400", "#e4e6eb"];

  return (
    <Card>
      <CardTitle>📊 {ELECTION_DAY_TEXT.dashboard.votingProgress.pieTitle}</CardTitle>
      <div className="mt-2 h-56">
        {stats.total > 0 ? (
          <ResponsiveContainer>
            <PieChart>
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
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full" />
        )}
      </div>
    </Card>
  );
}

function CoordinatorBarCard({ rows }: { rows: CoordinatorBreakdown[] }) {
  return (
    <Card>
      <CardTitle>👔 {ELECTION_DAY_TEXT.dashboard.byCoordinator}</CardTitle>
      <div className="mt-2 h-52">
        <ResponsiveContainer>
          <BarChart data={rows} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <XAxis
              dataKey="coordinator"
              tick={{ fontSize: 11, fill: "#64748b", fontFamily: "Heebo" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
            />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE_COMPACT} />
            <Bar
              dataKey="voted"
              name={ELECTION_DAY_TEXT.dashboard.votingProgress.voted}
              fill="#00a400"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="total"
              name={ELECTION_DAY_TEXT.dashboard.votingProgress.totalVoters}
              fill="#1877f2"
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-400">
            <th className="pb-1.5 text-start font-semibold">
              {ELECTION_DAY_TEXT.coordinatorFilter.label}
            </th>
            <th className="pb-1.5 text-start font-semibold">
              {ELECTION_DAY_TEXT.dashboard.totalContacts}
            </th>
            <th className="pb-1.5 text-start font-semibold">
              {ELECTION_DAY_TEXT.dashboard.votingProgress.voted}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.coordinator}>
              <td className="py-1.5 font-semibold text-slate-700">{row.coordinator}</td>
              <td className="py-1.5 tabular-nums text-slate-600">{row.total}</td>
              <td className="py-1.5 tabular-nums text-slate-600">{row.voted}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function ElectionDayDashboard({
  stats,
  coordinatorBreakdown,
  loaded,
  children,
}: {
  stats: ElectionDayStats;
  coordinatorBreakdown: CoordinatorBreakdown[];
  loaded: boolean;
  children: ReactNode;
}) {
  if (!loaded) {
    return (
      <div className="mb-6 grid gap-4 lg:grid-cols-[3fr_1.2fr]">
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-2xl" />
          <div className="grid grid-cols-3 gap-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-2xl" />
            ))}
          </div>
          {children}
        </div>
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[3fr_1.2fr]">
      <div className="space-y-4">
        <VotingProgressBar stats={stats} />
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label={ELECTION_DAY_TEXT.dashboard.votingProgress.totalVoters}
            value={stats.total}
          />
          <StatCard
            label={ELECTION_DAY_TEXT.dashboard.votingProgress.totalVoted}
            value={stats.voted}
          />
          <StatCard
            label={ELECTION_DAY_TEXT.dashboard.votingProgress.votingPct}
            value={stats.votedPct}
            suffix="%"
          />
        </div>
        {children}
      </div>

      <div className="space-y-4">
        <VotingPieChart stats={stats} />
        {coordinatorBreakdown.length > 0 && (
          <CoordinatorBarCard rows={coordinatorBreakdown} />
        )}
      </div>
    </div>
  );
}
