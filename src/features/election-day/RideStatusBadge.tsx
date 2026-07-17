import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

export function RideStatusBadge({ arranged }: { arranged: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        arranged
          ? "bg-supporter-soft text-emerald-800"
          : "bg-unclassified-soft text-slate-500",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          arranged ? "bg-supporter" : "bg-unclassified",
        )}
      />
      {arranged
        ? ELECTION_DAY_TEXT.status.arranged
        : ELECTION_DAY_TEXT.status.notArranged}
    </span>
  );
}
