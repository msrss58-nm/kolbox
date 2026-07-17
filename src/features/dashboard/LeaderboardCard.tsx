import { Link } from "react-router";
import { ChevronLeft, Trophy } from "lucide-react";
import { Badge } from "../../components/ui/Badge";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { RANK_LABELS } from "../../constants/labels";
import { ROUTES } from "../../constants/routes";
import { getRank } from "../../lib/ranks";
import { cn, fmtNum } from "../../lib/utils";
import type { Activist } from "../../types";
import { DASHBOARD_TEXT } from "./dashboard.constants";

const LEADERBOARD_SIZE = 5;

const medalStyles = [
  "bg-amber-400 text-amber-950", // gold
  "bg-slate-300 text-slate-700", // silver
  "bg-orange-300 text-orange-900", // bronze
];

export function LeaderboardCard({ activists }: { activists: Activist[] | null }) {
  const top = activists?.slice(0, LEADERBOARD_SIZE) ?? null;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Trophy className="size-4 text-amber-500" />
          {DASHBOARD_TEXT.leaderboard.title}
        </CardTitle>
        <Link
          to={ROUTES.activists}
          className="flex items-center gap-0.5 text-xs font-semibold text-primary-600 hover:text-primary-700"
        >
          {DASHBOARD_TEXT.leaderboard.seeAll}
          <ChevronLeft className="size-3.5" />
        </Link>
      </div>
      {top === null ? (
        <div className="mt-4 space-y-2.5">
          {[...Array(LEADERBOARD_SIZE)].map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <ol className="mt-4 space-y-1">
          {top.map((a, i) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-slate-50"
            >
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full text-xs font-extrabold",
                  medalStyles[i] ?? "bg-slate-100 text-slate-500",
                )}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-700">
                  {a.firstName} {a.lastName}
                </p>
                <p className="text-xs text-slate-400">{a.area}</p>
              </div>
              <Badge>{RANK_LABELS[getRank(a.tagCount)]}</Badge>
              <span className="w-12 text-end text-sm font-extrabold tabular-nums text-slate-700">
                {fmtNum(a.tagCount)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
