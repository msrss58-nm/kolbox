import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

export function VotedBadge({ voted }: { voted: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs",
        voted
          ? "bg-emerald-500 font-extrabold text-white shadow-sm shadow-emerald-500/30"
          : "bg-slate-100 font-semibold text-slate-500",
      )}
    >
      {voted ? `✓ ${ELECTION_DAY_TEXT.voted.voted}` : ELECTION_DAY_TEXT.voted.notVoted}
    </span>
  );
}
