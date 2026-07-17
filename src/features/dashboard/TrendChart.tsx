import {
  CartesianGrid,
  Line,
  LineChart,
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
  CLASSIFICATION_CHART_COLORS,
} from "../../constants/chart";
import { CLASSIFICATION_LABELS } from "../../constants/labels";
import { fmtNum } from "../../lib/utils";
import type { Classification, TrendPoint } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";

const TREND_SERIES: Classification[] = ["supporter", "potential", "opponent"];

const fmtDayMonth = (date: string) => {
  const d = new Date(date);
  return `${d.getDate()}.${d.getMonth() + 1}`;
};

function TrendLegend() {
  return (
    <div className="mt-2 flex flex-wrap gap-4">
      {TREND_SERIES.map((c) => (
        <span
          key={c}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-500"
        >
          <span
            className="h-0.5 w-4 rounded-full"
            style={{ background: CLASSIFICATION_CHART_COLORS[c] }}
          />
          {CLASSIFICATION_LABELS[c]}
        </span>
      ))}
    </div>
  );
}

export function TrendChart({ trend }: { trend: TrendPoint[] | null }) {
  return (
    <Card className="lg:col-span-2">
      <CardTitle>{DASHBOARD_TEXT.charts.trendTitle}</CardTitle>
      <TrendLegend />
      <div dir="ltr" className="mt-2 h-64">
        {trend ? (
          <ResponsiveContainer>
            <LineChart data={trend} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke={CHART_GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={fmtDayMonth}
                tick={CHART_AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: CHART_AXIS_LINE_COLOR }}
                minTickGap={24}
              />
              <YAxis
                tick={CHART_AXIS_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => fmtNum(Number(v))}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelFormatter={(d) => fmtDayMonth(String(d))}
                formatter={(value, name) => [
                  fmtNum(Number(value)),
                  CLASSIFICATION_LABELS[name as Classification],
                ]}
              />
              {TREND_SERIES.map((c) => (
                <Line
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stroke={CLASSIFICATION_CHART_COLORS[c]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full" />
        )}
      </div>
    </Card>
  );
}
