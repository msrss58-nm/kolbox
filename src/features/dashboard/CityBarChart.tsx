import {
  Bar,
  BarChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { CHART_PRIMARY_COLOR, CHART_TOOLTIP_STYLE } from "../../constants/chart";
import { APP_CONFIG } from "../../constants/config";
import { fmtNum } from "../../lib/utils";
import type { CityBreakdown } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";

export function CityBarChart({ cities }: { cities: CityBreakdown[] | null }) {
  const topCities = cities?.slice(0, APP_CONFIG.dashboardTopCitiesCount) ?? [];

  return (
    <Card className="lg:col-span-2">
      <CardTitle>{DASHBOARD_TEXT.charts.cityBarTitle}</CardTitle>
      <div dir="ltr" className="mt-2 h-72">
        {cities ? (
          <ResponsiveContainer>
            <BarChart
              data={topCities}
              layout="vertical"
              margin={{ top: 0, right: 8, left: 44, bottom: 0 }}
              barSize={16}
            >
              {/* reversed: bars anchor on the right, growing leftward (RTL) */}
              <XAxis type="number" hide reversed />
              <YAxis
                type="category"
                dataKey="city"
                orientation="right"
                width={88}
                tick={{ fontSize: 12, fill: "#475569", fontFamily: "Heebo" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                formatter={(value) => [
                  fmtNum(Number(value)),
                  DASHBOARD_TEXT.charts.citySeriesLabel,
                ]}
                cursor={{ fill: "#f8fafc" }}
              />
              <Bar dataKey="supporters" fill={CHART_PRIMARY_COLOR} radius={[4, 0, 0, 4]}>
                <LabelList
                  dataKey="supporters"
                  position="right"
                  formatter={(v) => fmtNum(Number(v))}
                  style={{
                    fontSize: 11,
                    fill: "#64748b",
                    fontVariantNumeric: "tabular-nums",
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Skeleton className="h-full" />
        )}
      </div>
    </Card>
  );
}
