import { RANK_LABELS } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { getRank } from "../../lib/ranks";
import type { ActivistRank } from "../../types";

/** Rank tiers get progressively warmer/bolder colors. */
const rankStyles: Record<ActivistRank, string> = {
  turai: "bg-slate-100 text-slate-500",
  rabat: "bg-slate-100 text-slate-600",
  samal: "bg-sky-100 text-sky-700",
  rasar: "bg-primary-100 text-primary-700",
  segen: "bg-violet-100 text-violet-700",
  seren: "bg-fuchsia-100 text-fuchsia-700",
  aluf: "bg-amber-100 text-amber-700",
};

export function RankBadge({
  tagCount,
  className,
}: {
  tagCount: number;
  className?: string;
}) {
  const rank = getRank(tagCount);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold",
        rankStyles[rank],
        className,
      )}
    >
      {RANK_LABELS[rank]}
    </span>
  );
}
