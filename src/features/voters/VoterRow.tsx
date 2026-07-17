import { ClassificationBadge } from "../../components/ui/Badge";
import { cn } from "../../lib/utils";
import type { Classification, Voter } from "../../types";
import { ClassifySegment } from "./ClassifySegment";

export function VoterRow({
  voter,
  selected,
  onToggleSelect,
  onOpen,
  onClassify,
}: {
  voter: Voter;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onClassify: (c: Classification) => void;
}) {
  return (
    <div
      className={cn(
        "border-b border-slate-100 transition-colors last:border-b-0",
        selected ? "bg-primary-50" : "hover:bg-slate-50",
      )}
    >
      {/* Desktop row */}
      <div className="hidden px-4 py-2 md:grid md:grid-cols-[2rem_1.4fr_0.7fr_1.1fr_0.9fr_7rem_13rem] md:items-center md:gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          className="size-4 accent-primary-600"
          aria-label={`בחירת ${voter.firstName} ${voter.lastName}`}
        />
        <button onClick={onOpen} className="min-w-0 text-start">
          <p className="truncate text-sm font-bold text-slate-800 hover:text-primary-700">
            {voter.firstName} {voter.lastName}
          </p>
          <p className="text-xs tabular-nums text-slate-400">{voter.nationalId}</p>
        </button>
        <span className="truncate text-sm text-slate-600">{voter.city}</span>
        <span className="truncate text-sm text-slate-600">
          {voter.street} {voter.houseNumber}
        </span>
        <span className="text-sm tabular-nums text-slate-600" dir="ltr">
          {voter.phone ?? "-"}
        </span>
        <ClassificationBadge classification={voter.classification} />
        <ClassifySegment value={voter.classification} onChange={onClassify} size="sm" />
      </div>

      {/* Mobile card */}
      <div className="space-y-2.5 px-4 py-3 md:hidden">
        <button
          onClick={onOpen}
          className="flex w-full items-start justify-between gap-2 text-start"
        >
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-800">
              {voter.firstName} {voter.lastName}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {voter.city} · {voter.street} {voter.houseNumber}
              {voter.phone && (
                <>
                  {" · "}
                  <span dir="ltr" className="tabular-nums">
                    {voter.phone}
                  </span>
                </>
              )}
            </p>
          </div>
          <ClassificationBadge classification={voter.classification} />
        </button>
        <ClassifySegment value={voter.classification} onChange={onClassify} />
      </div>
    </div>
  );
}
