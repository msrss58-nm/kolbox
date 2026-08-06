import { useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import { usePermissions } from "../../permissions/usePermissions";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { NonVotingReasonReportRow } from "./nonVotingReasonReport";

const text = ELECTION_DAY_TEXT.nonVotingReasonsReport;

/**
 * Reason -> coordinator -> voter drill-down opened from
 * `NonVotingReasonsReportCard`. Lightweight by design - not the main
 * `ElectionDayList`/`ElectionDayRow` machinery (no column permissions, no
 * sort/pagination), just a clickable breakdown + a clickable voter list that
 * hands off to the same single-contact modal every other surface uses
 * (`onOpenVoter` - the caller closes this modal and opens that one).
 *
 * The by-coordinator section is gated on `voter.viewCoordinator`: without
 * it, the voter list below is shown flat, ungrouped - same
 * graceful-degradation pattern `CoordinatorBarCard` already uses elsewhere.
 */
export function NonVotingReasonDrillDownModal({
  open,
  onClose,
  row,
  onOpenVoter,
}: {
  open: boolean;
  onClose: () => void;
  row: NonVotingReasonReportRow | null;
  onOpenVoter: (id: string) => void;
}) {
  const { can } = usePermissions();
  const showCoordinatorBreakdown = can("voter.viewCoordinator");
  const [selectedCoordinator, setSelectedCoordinator] = useState<string | null>(null);

  // Render-phase reset (no effect needed) - a fresh row means any
  // previously-selected coordinator no longer applies. Both sides of the
  // comparison must be normalized the same way (`?? null`) - comparing the
  // raw `row?.reasonId` (`string | undefined`) against `trackedRowId`
  // (`string | null`) is never `undefined === null`, so with `row === null`
  // (the modal's default closed state) that comparison never converges and
  // re-renders forever ("Too many re-renders").
  const [trackedRowId, setTrackedRowId] = useState<string | null>(row?.reasonId ?? null);
  const currentRowId = row?.reasonId ?? null;
  if (currentRowId !== trackedRowId) {
    setTrackedRowId(currentRowId);
    if (selectedCoordinator !== null) setSelectedCoordinator(null);
  }

  if (!row) return null;

  const voters =
    showCoordinatorBreakdown && selectedCoordinator !== null
      ? row.voters.filter((v) => (v.coordinator || "") === selectedCoordinator)
      : row.voters;

  return (
    <Modal open={open} onClose={onClose} title={text.drillDownTitle(row.reasonName)} wide>
      <div className="space-y-4">
        {showCoordinatorBreakdown && row.byCoordinator.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-700">
                {text.byCoordinatorTitle}
              </h3>
              {selectedCoordinator !== null && (
                <button
                  type="button"
                  onClick={() => setSelectedCoordinator(null)}
                  className="flex items-center gap-1 text-xs font-semibold text-primary-600 hover:underline"
                >
                  <ChevronRight className="size-3.5" />
                  {text.backToAllCoordinators}
                </button>
              )}
            </div>
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {row.byCoordinator.map(({ coordinator, count }) => (
                <li key={coordinator || "__none__"}>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedCoordinator((prev) =>
                        prev === coordinator ? null : coordinator,
                      )
                    }
                    className={cn(
                      "flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-slate-50",
                      selectedCoordinator === coordinator &&
                        "bg-primary-50 hover:bg-primary-50",
                    )}
                  >
                    <span className="min-w-0 truncate font-semibold text-slate-700">
                      {coordinator || text.noCoordinator}
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-slate-400">
                      {text.rowCount(count)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          {voters.length === 0 ? (
            <EmptyState icon={Users} title={text.voterListEmpty} />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {voters.map((voter) => (
                <li key={voter.id}>
                  <button
                    type="button"
                    onClick={() => onOpenVoter(voter.id)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate font-semibold text-slate-700">
                      {voter.firstName} {voter.lastName}
                    </span>
                    <span className="min-w-0 shrink-0 truncate text-xs text-slate-400">
                      {[voter.city, voter.phone].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
