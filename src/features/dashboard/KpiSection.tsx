import { HelpCircle, Megaphone, Target, ThumbsDown, ThumbsUp, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "../../components/ui/Skeleton";
import type { CampaignStats } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";
import { KpiCard, type KpiTone } from "./KpiCard";

interface KpiDescriptor {
  key: string;
  icon: LucideIcon;
  label: string;
  tone?: KpiTone;
  getValue: (stats: CampaignStats) => number;
  suffix?: string;
  getSub?: (stats: CampaignStats) => string | undefined;
}

/** One config entry per tile - add/remove a KPI here, nowhere else. */
const KPI_DESCRIPTORS: KpiDescriptor[] = [
  {
    key: "total",
    icon: Users,
    label: DASHBOARD_TEXT.kpi.totalVoters,
    getValue: (s) => s.totalVoters,
  },
  {
    key: "supporters",
    icon: ThumbsUp,
    label: DASHBOARD_TEXT.kpi.supporters,
    tone: "supporter",
    getValue: (s) => s.byClassification.supporter,
    getSub: (s) => DASHBOARD_TEXT.kpi.weeklyDelta(s.classificationsLast7Days),
  },
  {
    key: "potentials",
    icon: HelpCircle,
    label: DASHBOARD_TEXT.kpi.potentials,
    tone: "potential",
    getValue: (s) => s.byClassification.potential,
  },
  {
    key: "opponents",
    icon: ThumbsDown,
    label: DASHBOARD_TEXT.kpi.opponents,
    tone: "opponent",
    getValue: (s) => s.byClassification.opponent,
  },
  {
    key: "coverage",
    icon: Target,
    label: DASHBOARD_TEXT.kpi.coverage,
    tone: "primary",
    getValue: (s) => Math.round(s.coveragePct),
    suffix: "%",
  },
  {
    key: "activeActivists",
    icon: Megaphone,
    label: DASHBOARD_TEXT.kpi.activeActivists,
    getValue: (s) => s.activeActivists,
    getSub: () => DASHBOARD_TEXT.kpi.activeActivistsSub,
  },
];

export function KpiSection({ stats }: { stats: CampaignStats | null }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {stats
        ? KPI_DESCRIPTORS.map((kpi) => (
            <KpiCard
              key={kpi.key}
              icon={kpi.icon}
              label={kpi.label}
              value={kpi.getValue(stats)}
              suffix={kpi.suffix}
              tone={kpi.tone}
              sub={kpi.getSub?.(stats)}
            />
          ))
        : KPI_DESCRIPTORS.map((kpi) => (
            <Skeleton key={kpi.key} className="h-[88px] rounded-2xl" />
          ))}
    </div>
  );
}
