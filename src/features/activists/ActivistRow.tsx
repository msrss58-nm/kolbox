import { nextRankProgress } from "../../lib/ranks";
import { fmtNum, fmtRelative } from "../../lib/utils";
import { RANK_LABELS } from "../../constants/labels";
import type { Activist } from "../../types";
import { ACTIVISTS_TEXT } from "./activists.constants";
import { RankBadge } from "./RankBadge";

export function ActivistRow({
  activist,
  rank,
  onOpen,
}: {
  activist: Activist;
  /** 1-indexed leaderboard position (podium is 1-3, this list starts at 4). */
  rank: number;
  onOpen: () => void;
}) {
  const progress = nextRankProgress(activist.tagCount);

  return (
    <button
      onClick={onOpen}
      className="block w-full border-b border-slate-100 text-start transition-colors last:border-0 hover:bg-slate-50"
    >
      {/* Desktop row */}
      <div className="hidden px-4 py-2.5 md:grid md:grid-cols-[2.5rem_1.2fr_0.8fr_0.9fr_6rem_1fr_0.8fr] md:items-center md:gap-3">
        <span className="text-sm font-bold tabular-nums text-slate-400">{rank}</span>
        <span className="truncate text-sm font-bold text-slate-800">
          {activist.firstName} {activist.lastName}
          <span className="ms-2 text-xs font-medium text-slate-400">
            {fmtNum(activist.tagCount)} {ACTIVISTS_TEXT.tagsSuffix}
          </span>
        </span>
        <span className="truncate text-sm text-slate-600">{activist.area}</span>
        <span className="text-sm tabular-nums text-slate-600" dir="ltr">
          {activist.phone}
        </span>
        <RankBadge tagCount={activist.tagCount} />
        {progress ? (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100">
              <span
                className="block h-full rounded-full bg-primary-500"
                style={{ width: `${progress.pct}%` }}
              />
            </span>
            <span className="text-xs text-slate-400">
              {ACTIVISTS_TEXT.nextRankProgress(
                progress.remaining,
                RANK_LABELS[progress.next],
              )}
            </span>
          </span>
        ) : (
          <span className="text-xs text-amber-600">{ACTIVISTS_TEXT.maxRank}</span>
        )}
        <span className="text-xs text-slate-400">
          {fmtRelative(activist.lastActiveAt)}
        </span>
      </div>

      {/* Mobile card */}
      <div className="flex items-center gap-3 px-4 py-3 md:hidden">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-100 text-sm font-bold text-slate-500">
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-slate-800">
            {activist.firstName} {activist.lastName}
          </p>
          <p className="text-xs text-slate-400">
            {activist.area} · {fmtRelative(activist.lastActiveAt)}
          </p>
        </div>
        <RankBadge tagCount={activist.tagCount} />
        <span className="w-10 text-end font-extrabold tabular-nums text-slate-700">
          {fmtNum(activist.tagCount)}
        </span>
      </div>
    </button>
  );
}
