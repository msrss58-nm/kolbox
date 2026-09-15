import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { CHART_AXIS_LINE_COLOR, CHART_AXIS_TICK_STYLE, CHART_GRID_COLOR, CHART_TOOLTIP_STYLE } from "../../constants/chart";
import { BUDGET_TEXT } from "./budget.constants";
import type { BudgetDashboard } from "./budgetClient";
import { formatAgorot } from "./budgetMoney";

const t = BUDGET_TEXT.dashboard;

/** Budget Stage 6 charts. Every value is the server's integer agorot figure
 * (get_dashboard.charts) - nothing is summed or derived here; stacked bars
 * show committed and actual side by side. Tooltips show the exact amount. */
export const BUDGET_CHART_COLORS = {
  committed: "#f59e0b",
  actual: "#6366f1",
  plan: "#94a3b8",
  budget: "#cbd5e1",
} as const;
type SeriesKey = keyof typeof BUDGET_CHART_COLORS;

const compact = new Intl.NumberFormat("he-IL", { notation: "compact", maximumFractionDigits: 1 });
const tickMoney = (v: number) => compact.format(v / 100);
const tooltipFormatter = (value: unknown, name: unknown): [string, string] => [
  formatAgorot(Number(value)),
  t.series[String(name)] ?? String(name),
];
const monthLabel = (m: string) => `${m.slice(5, 7)}/${m.slice(2, 4)}`;
type Clickable = { payload?: { id?: string } };

function ChartCard({ title, testId, empty, height, series, hint, children }: {
  title: string;
  testId: string;
  empty: boolean;
  height: number;
  series: SeriesKey[];
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <Card className="h-full">
        <CardTitle>{title}</CardTitle>
        {empty ? (
          <p className="py-10 text-center text-sm text-slate-500" data-testid="chart-empty">{t.charts.empty}</p>
        ) : (
          <>
            <div className="mt-2 flex flex-wrap gap-4">
              {series.map((s) => (
                <span key={s} className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                  <span className="size-2.5 rounded-sm" style={{ background: BUDGET_CHART_COLORS[s] }} />
                  {t.series[s]}
                </span>
              ))}
            </div>
            <div dir="ltr" className="mt-2" style={{ height }}>
              {children}
            </div>
            {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
          </>
        )}
      </Card>
    </div>
  );
}

export function CategoryChart({ rows, onSelect }: {
  rows: BudgetDashboard["charts"]["byCategory"];
  onSelect: (id: string) => void;
}) {
  const data = rows.filter((r) => r.committed !== 0 || r.actual !== 0);
  return (
    <ChartCard title={t.charts.byCategory} testId="chart-category" empty={data.length === 0}
      height={Math.max(160, data.length * 38 + 40)} series={["actual", "committed"]} hint={t.charts.clickHint}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_COLOR} horizontal={false} />
          <XAxis type="number" reversed tickFormatter={tickMoney} tick={CHART_AXIS_TICK_STYLE} tickLine={false}
            axisLine={{ stroke: CHART_AXIS_LINE_COLOR }} />
          <YAxis type="category" dataKey="name" orientation="right" width={112} tick={CHART_AXIS_TICK_STYLE}
            tickLine={false} axisLine={false} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={tooltipFormatter} cursor={{ fill: "#f8fafc" }} />
          <Bar dataKey="actual" stackId="u" fill={BUDGET_CHART_COLORS.actual} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
          <Bar dataKey="committed" stackId="u" fill={BUDGET_CHART_COLORS.committed} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function SourceChart({ rows, onSelect }: {
  rows: BudgetDashboard["charts"]["bySource"];
  onSelect: (id: string) => void;
}) {
  return (
    <ChartCard title={t.charts.bySource} testId="chart-source"
      empty={rows.every((r) => r.budget === 0 && r.committed === 0 && r.actual === 0)}
      height={Math.max(160, rows.length * 46 + 40)} series={["budget", "actual", "committed"]} hint={t.charts.clickHint}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={CHART_GRID_COLOR} horizontal={false} />
          <XAxis type="number" reversed tickFormatter={tickMoney} tick={CHART_AXIS_TICK_STYLE} tickLine={false}
            axisLine={{ stroke: CHART_AXIS_LINE_COLOR }} />
          <YAxis type="category" dataKey="name" orientation="right" width={112} tick={CHART_AXIS_TICK_STYLE}
            tickLine={false} axisLine={false} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={tooltipFormatter} cursor={{ fill: "#f8fafc" }} />
          <Bar dataKey="budget" stackId="b" fill={BUDGET_CHART_COLORS.budget} />
          <Bar dataKey="actual" stackId="u" fill={BUDGET_CHART_COLORS.actual} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
          <Bar dataKey="committed" stackId="u" fill={BUDGET_CHART_COLORS.committed} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function PlanChart({ rows, onSelect }: {
  rows: BudgetDashboard["charts"]["byCategory"];
  onSelect: (id: string) => void;
}) {
  return (
    <ChartCard title={t.charts.planVsActual} testId="chart-plan" empty={rows.length === 0}
      height={Math.max(160, rows.length * 46 + 40)} series={["plan", "actual", "committed"]} hint={t.charts.clickHint}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 4, left: 4, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={CHART_GRID_COLOR} horizontal={false} />
          <XAxis type="number" reversed tickFormatter={tickMoney} tick={CHART_AXIS_TICK_STYLE} tickLine={false}
            axisLine={{ stroke: CHART_AXIS_LINE_COLOR }} />
          <YAxis type="category" dataKey="name" orientation="right" width={112} tick={CHART_AXIS_TICK_STYLE}
            tickLine={false} axisLine={false} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={tooltipFormatter} cursor={{ fill: "#f8fafc" }} />
          <Bar dataKey="plan" stackId="p" fill={BUDGET_CHART_COLORS.plan} />
          <Bar dataKey="actual" stackId="u" fill={BUDGET_CHART_COLORS.actual} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
          <Bar dataKey="committed" stackId="u" fill={BUDGET_CHART_COLORS.committed} cursor="pointer"
            onClick={(d: Clickable) => d.payload?.id && onSelect(d.payload.id)} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function TimeChart({ rows }: { rows: BudgetDashboard["charts"]["overTime"] }) {
  return (
    <ChartCard title={t.charts.overTime} testId="chart-time" empty={rows.length === 0} height={240}
      series={["actual", "committed"]}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_COLOR} vertical={false} />
          <XAxis dataKey="month" reversed tickFormatter={monthLabel} tick={CHART_AXIS_TICK_STYLE} tickLine={false}
            axisLine={{ stroke: CHART_AXIS_LINE_COLOR }} minTickGap={12} />
          <YAxis orientation="right" tickFormatter={tickMoney} tick={CHART_AXIS_TICK_STYLE} tickLine={false} axisLine={false} width={52} />
          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={tooltipFormatter} labelFormatter={(m) => monthLabel(String(m))}
            cursor={{ fill: "#f8fafc" }} />
          <Bar dataKey="actual" stackId="u" fill={BUDGET_CHART_COLORS.actual} />
          <Bar dataKey="committed" stackId="u" fill={BUDGET_CHART_COLORS.committed} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
