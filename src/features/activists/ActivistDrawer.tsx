import { useCallback, useMemo } from "react";
import { CalendarDays, MapPin, Pencil, Phone, TrendingUp } from "lucide-react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  CHART_PRIMARY_COLOR,
  CHART_TOOLTIP_STYLE_COMPACT,
  CLASSIFICATION_CHART_COLORS,
} from "../../constants/chart";
import { CLASSIFICATION_LABELS, RANK_LABELS } from "../../constants/labels";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncData } from "../../hooks/useAsyncData";
import { binWeeklyActivity } from "../../lib/activity";
import { nextRankProgress } from "../../lib/ranks";
import { fmtDate, fmtNum, fmtRelative } from "../../lib/utils";
import { api } from "../../services/api";
import type { Activist, ClassificationEvent } from "../../types";
import { ACTIVIST_DRAWER_TEXT } from "./activists.constants";
import { RankBadge } from "./RankBadge";

interface ActivistActivity {
  events: ClassificationEvent[];
  weekly: { label: string; count: number }[];
}

export function ActivistDrawer({
  activist,
  onClose,
  onEdit,
}: {
  activist: Activist | null;
  onClose: () => void;
  onEdit: (a: Activist) => void;
}) {
  if (!activist) return null;
  return (
    <Content key={activist.id} activist={activist} onClose={onClose} onEdit={onEdit} />
  );
}

function Content({
  activist,
  onClose,
  onEdit,
}: {
  activist: Activist;
  onClose: () => void;
  onEdit: (a: Activist) => void;
}) {
  /** Date.now() runs inside the async fetcher (effect phase), never during render. */
  const fetchActivity = useCallback(async (): Promise<ActivistActivity> => {
    const events = await api.getActivistEvents(activist.id);
    return { events, weekly: binWeeklyActivity(events, Date.now()) };
  }, [activist.id]);
  const { data } = useAsyncData(fetchActivity);
  const events = data?.events ?? null;
  const weekly = data?.weekly ?? null;

  const progress = nextRankProgress(activist.tagCount);

  const byClassification = useMemo(() => {
    if (!events) return null;
    const counts = { supporter: 0, potential: 0, opponent: 0 };
    for (const e of events)
      if (e.classification !== "unclassified") counts[e.classification]++;
    return counts;
  }, [events]);

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${activist.firstName} ${activist.lastName}`}
      subtitle={<RankBadge tagCount={activist.tagCount} />}
      footer={
        <Button variant="secondary" className="w-full" onClick={() => onEdit(activist)}>
          <Pencil className="size-4" />
          {ACTIVIST_DRAWER_TEXT.editButton}
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Headline stat + rank progress */}
        <div className="rounded-2xl bg-gradient-l from-primary-600 to-violet-600 p-5 text-white">
          <p className="text-sm text-primary-100">{ACTIVIST_DRAWER_TEXT.totalTags}</p>
          <p className="mt-1 text-4xl font-black tabular-nums">
            {fmtNum(activist.tagCount)}
          </p>
          {progress ? (
            <>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-white"
                  style={{ width: `${progress.pct}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-primary-100">
                {ACTIVIST_DRAWER_TEXT.nextRank(
                  progress.remaining,
                  RANK_LABELS[progress.next],
                )}
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm font-bold">{ACTIVIST_DRAWER_TEXT.maxRank}</p>
          )}
        </div>

        {/* Details */}
        <dl className="space-y-3">
          {[
            {
              icon: MapPin,
              label: ACTIVIST_DRAWER_TEXT.fields.area,
              value: activist.area,
            },
            {
              icon: Phone,
              label: ACTIVIST_DRAWER_TEXT.fields.phone,
              value: activist.phone,
              ltr: true,
            },
            {
              icon: CalendarDays,
              label: ACTIVIST_DRAWER_TEXT.fields.joined,
              value: fmtDate(activist.joinedAt),
            },
            {
              icon: TrendingUp,
              label: ACTIVIST_DRAWER_TEXT.fields.lastActive,
              value: fmtRelative(activist.lastActiveAt),
            },
          ].map(({ icon: Icon, label, value, ltr }) => (
            <div key={label} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-50">
                <Icon className="size-4 text-primary-600" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-slate-400">{label}</dt>
                <dd
                  className="truncate text-sm font-medium text-slate-700 tabular-nums"
                  dir={ltr ? "ltr" : undefined}
                >
                  {value}
                </dd>
              </div>
            </div>
          ))}
        </dl>

        {/* Classification breakdown */}
        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-700">
            {ACTIVIST_DRAWER_TEXT.breakdownTitle}
          </h3>
          {byClassification === null ? (
            <Skeleton className="h-16" />
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(byClassification) as (keyof typeof byClassification)[]).map(
                (c) => (
                  <div key={c} className="rounded-xl bg-slate-50 p-3 text-center">
                    <p
                      className="text-lg font-extrabold tabular-nums"
                      style={{ color: CLASSIFICATION_CHART_COLORS[c] }}
                    >
                      {fmtNum(byClassification[c])}
                    </p>
                    <p className="text-xs text-slate-500">{CLASSIFICATION_LABELS[c]}</p>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Weekly activity */}
        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-700">
            {ACTIVIST_DRAWER_TEXT.activityTitle(APP_CONFIG.weeklyActivityWeeks)}
          </h3>
          <div dir="ltr" className="h-36">
            {weekly === null ? (
              <Skeleton className="h-full" />
            ) : (
              <ResponsiveContainer>
                <BarChart data={weekly} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "#94a3b8", fontFamily: "Heebo" }}
                    tickLine={false}
                    axisLine={{ stroke: "#e2e8f0" }}
                  />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE_COMPACT}
                    formatter={(value) => [
                      fmtNum(Number(value)),
                      ACTIVIST_DRAWER_TEXT.activityTooltipLabel,
                    ]}
                    cursor={{ fill: "#f8fafc" }}
                  />
                  <Bar
                    dataKey="count"
                    fill={CHART_PRIMARY_COLOR}
                    radius={[4, 4, 0, 0]}
                    barSize={20}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
