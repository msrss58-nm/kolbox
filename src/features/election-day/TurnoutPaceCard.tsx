import { TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  CHART_AXIS_LINE_COLOR,
  CHART_AXIS_TICK_STYLE,
  CHART_GRID_COLOR,
  CHART_TOOLTIP_STYLE,
} from "../../constants/chart";
import { fmtNum } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { TurnoutPaceResult } from "./turnoutPace";

const text = ELECTION_DAY_TEXT.dashboard.pace;

function PaceChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-2.5 text-center">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-extrabold tabular-nums text-slate-800">{value}</p>
    </div>
  );
}

/** Dashboard "קצב הצבעה" - a real cumulative curve + 3 pace stats built
 * entirely from `votedAt` timestamps (see `turnoutPace.ts`). Deliberately
 * has no turnout-goal dashed reference line - there's no turnout-target
 * concept anywhere else in the app to draw it from. */
export function TurnoutPaceCard({
  pace,
  loaded,
}: {
  pace: TurnoutPaceResult;
  loaded: boolean;
}) {
  const { series, stats } = pace;
  const changeLabel =
    stats.changePct === null
      ? "-"
      : `${stats.changePct >= 0 ? "+" : ""}${Math.round(stats.changePct)}%`;

  return (
    <Card className="md:col-span-2">
      <CardTitle className="flex items-center gap-1.5">
        <TrendingUp className="size-4 text-primary-600" />
        {text.title}
      </CardTitle>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <PaceChip label={text.changeFromPrevHour} value={changeLabel} />
        <PaceChip
          label={text.currentPace}
          value={`${fmtNum(Math.round(stats.currentPacePerHour))} ${text.currentPaceUnit}`}
        />
        <PaceChip label={text.lastHour} value={fmtNum(stats.lastHourCount)} />
      </div>

      <p className="mt-4 text-xs font-semibold text-slate-500">{text.chartTitle}</p>
      <div dir="ltr" className="mt-1 h-56">
        {!loaded ? (
          <Skeleton className="h-full" />
        ) : series.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-slate-400">
            {ELECTION_DAY_TEXT.dashboard.votingProgress.notVoted}
          </div>
        ) : (
          <ResponsiveContainer>
            <AreaChart data={series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="electionDayPaceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--color-primary-500)"
                    stopOpacity={0.3}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--color-primary-500)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="label"
                tick={CHART_AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: CHART_AXIS_LINE_COLOR }}
                minTickGap={16}
              />
              <YAxis
                tick={CHART_AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tickFormatter={(v) => fmtNum(Number(v))}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value) => [fmtNum(Number(value)), text.votedSeries]}
              />
              <Area
                type="monotone"
                dataKey="cumulative"
                stroke="var(--color-primary-500)"
                strokeWidth={2}
                fill="url(#electionDayPaceFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
