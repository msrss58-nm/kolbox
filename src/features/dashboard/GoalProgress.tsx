import { Flag } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { fmtNum } from "../../lib/utils";
import type { CampaignStats } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";

export function GoalProgress({ stats }: { stats: CampaignStats | null }) {
  const supporters = stats?.byClassification.supporter ?? 0;
  const goalPct = stats ? Math.min(100, Math.round((supporters / stats.goal) * 100)) : 0;

  return (
    <Card className="mt-3 animate-fade-in-up">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Flag className="size-4 text-primary-500" />
          {DASHBOARD_TEXT.goal.prefix} {stats ? fmtNum(stats.goal) : "…"}{" "}
          {DASHBOARD_TEXT.goal.suffix}
        </CardTitle>
        <span className="text-sm font-bold tabular-nums text-primary-700">
          {stats ? `${fmtNum(supporters)} (${goalPct}%)` : ""}
        </span>
      </div>
      <div
        className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuenow={goalPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={DASHBOARD_TEXT.goal.ariaLabel}
      >
        <div
          className="h-full rounded-full bg-gradient-to-l from-primary-500 to-violet-500 transition-all duration-1000"
          style={{ width: `${goalPct}%` }}
        />
      </div>
    </Card>
  );
}
