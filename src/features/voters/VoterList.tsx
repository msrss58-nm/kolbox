import { SearchX } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import type { Classification, Voter } from "../../types";
import { VOTERS_TEXT } from "./voters.constants";
import { VoterRow } from "./VoterRow";

/**
 * Renders one page of voters (bounded by the page-size selector, max 100
 * rows) - no virtualization needed since pagination already caps how much
 * is ever mounted at once.
 */
export function VoterList({
  voters,
  selected,
  onToggleSelect,
  onOpen,
  onClassify,
  showResetFilters,
  onResetFilters,
}: {
  voters: Voter[] | null;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClassify: (voter: Voter, c: Classification) => void;
  showResetFilters: boolean;
  onResetFilters: () => void;
}) {
  if (voters === null) {
    return (
      <div className="space-y-2 bg-white p-4 ring-1 ring-slate-100">
        {[...Array(10)].map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }

  if (voters.length === 0) {
    return (
      <div className="bg-white ring-1 ring-slate-100">
        <EmptyState
          icon={SearchX}
          title={VOTERS_TEXT.empty.title}
          hint={VOTERS_TEXT.empty.hint}
          action={
            showResetFilters && (
              <Button variant="secondary" size="sm" onClick={onResetFilters}>
                {VOTERS_TEXT.empty.clearFilters}
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="bg-white ring-1 ring-slate-100">
      {voters.map((voter) => (
        <VoterRow
          key={voter.id}
          voter={voter}
          selected={selected.has(voter.id)}
          onToggleSelect={() => onToggleSelect(voter.id)}
          onOpen={() => onOpen(voter.id)}
          onClassify={(c) => onClassify(voter, c)}
        />
      ))}
    </div>
  );
}
