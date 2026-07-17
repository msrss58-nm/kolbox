import { Crown } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { cn, fmtNum } from "../../lib/utils";
import type { Activist } from "../../types";
import { ACTIVISTS_TEXT } from "./activists.constants";
import { RankBadge } from "./RankBadge";

const PODIUM_STYLES = [
  {
    ring: "ring-amber-300",
    medal: "bg-amber-400 text-amber-950",
    order: "order-2 md:-mt-4",
  },
  { ring: "ring-slate-200", medal: "bg-slate-300 text-slate-700", order: "order-1" },
  { ring: "ring-orange-200", medal: "bg-orange-300 text-orange-900", order: "order-3" },
] as const;

export function PodiumCard({
  activist,
  place,
  onOpen,
}: {
  activist: Activist;
  /** 0-indexed: 0 = gold. */
  place: 0 | 1 | 2;
  onOpen: () => void;
}) {
  const style = PODIUM_STYLES[place];
  return (
    <button onClick={onOpen} className={cn("text-start", style.order)}>
      <Card
        className={cn(
          "relative flex flex-col items-center gap-2 p-6 ring-2 transition-transform hover:-translate-y-0.5",
          style.ring,
        )}
      >
        {place === 0 && (
          <Crown className="absolute -top-3 size-6 rotate-12 text-amber-400" />
        )}
        <span
          className={cn(
            "grid size-12 place-items-center rounded-full text-lg font-black",
            style.medal,
          )}
        >
          {place + 1}
        </span>
        <p className="text-lg font-extrabold text-slate-800">
          {activist.firstName} {activist.lastName}
        </p>
        <p className="text-xs text-slate-400">{activist.area}</p>
        <div className="mt-1 flex items-center gap-2">
          <RankBadge tagCount={activist.tagCount} />
          <span className="text-xl font-black tabular-nums text-slate-800">
            {fmtNum(activist.tagCount)}
          </span>
          <span className="text-xs text-slate-400">{ACTIVISTS_TEXT.tagsSuffix}</span>
        </div>
      </Card>
    </button>
  );
}
