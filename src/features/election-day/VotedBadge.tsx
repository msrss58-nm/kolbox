import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

export function VotedBadge({ voted }: { voted: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        voted ? "bg-[#e7f3ff] text-[#1877f2]" : "bg-slate-100 text-slate-500",
      )}
    >
      {voted ? `✓ ${ELECTION_DAY_TEXT.voted.voted}` : ELECTION_DAY_TEXT.voted.notVoted}
    </span>
  );
}
