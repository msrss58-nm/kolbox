import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { CHART_TOOLTIP_STYLE, CLASSIFICATION_CHART_COLORS } from "../../constants/chart";
import { CLASSIFICATION_LABELS, CLASSIFICATIONS } from "../../constants/labels";
import { fmtNum } from "../../lib/utils";
import type { CampaignStats } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";

export function ClassificationDonut({ stats }: { stats: CampaignStats | null }) {
  const donutData = useMemo(
    () =>
      stats
        ? CLASSIFICATIONS.map((c) => ({
            key: c,
            name: CLASSIFICATION_LABELS[c],
            value: stats.byClassification[c],
          }))
        : [],
    [stats],
  );

  return (
    <Card>
      <CardTitle>{DASHBOARD_TEXT.charts.donutTitle}</CardTitle>
      <div dir="ltr" className="relative mx-auto mt-2 h-48 max-w-56">
        {stats ? (
          <>
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={donutData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="68%"
                  outerRadius="100%"
                  paddingAngle={2}
                  strokeWidth={0}
                >
                  {donutData.map((d) => (
                    <Cell key={d.key} fill={CLASSIFICATION_CHART_COLORS[d.key]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  formatter={(value, name) => [fmtNum(Number(value)), String(name)]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
              <div dir="rtl">
                <p className="text-2xl font-extrabold tabular-nums text-slate-800">
                  {Math.round(stats.coveragePct)}%
                </p>
                <p className="text-xs text-slate-400">
                  {DASHBOARD_TEXT.charts.donutCenterHint}
                </p>
              </div>
            </div>
          </>
        ) : (
          <Skeleton className="h-full rounded-full" />
        )}
      </div>
      {stats && (
        <ul className="mt-4 space-y-1.5">
          {donutData.map((d) => (
            <li key={d.key} className="flex items-center gap-2 text-sm">
              <span
                className="size-2.5 rounded-full"
                style={{ background: CLASSIFICATION_CHART_COLORS[d.key] }}
              />
              <span className="text-slate-600">{d.name}</span>
              <span className="ms-auto font-bold tabular-nums text-slate-700">
                {fmtNum(d.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
