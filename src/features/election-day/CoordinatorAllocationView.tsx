import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { CoordinatorAllocationLive } from "./CoordinatorAllocationLive";
import { resolveCoordinatorAllocationPhase } from "./coordinatorAllocationPhase";
import { CoordinatorAllocationSetup } from "./CoordinatorAllocationSetup";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";
import { useCoordinatorAllocation } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation;

/**
 * Coordinator Allocation Management (Phase 5): the top-level "ניהול הקצאות"
 * view, rendered inline from `ElectionDayFilesPage` (not a separate route -
 * see that file's own comment) when its entry card is opened.
 *
 * Phase derivation goes exclusively through `resolveCoordinatorAllocationPhase`
 * (see that file's own comment for the locked rule and why an earlier
 * version's "any coordinator's totalAssigned > 0" signal was wrong - it
 * flipped to Live the instant a coordinator was linked to a handful of
 * pre-existing Excel assignments, even with hundreds of genuinely
 * unassigned voters still needing Initial Allocation). `unassignedCount` is
 * the only lifecycle signal; there is no separately-persisted "setup
 * complete" flag to drift out of sync with real data.
 */
export function CoordinatorAllocationView({ onBack }: { onBack: () => void }) {
  const electionDay = useElectionDayShell();
  const reasonsById = useMemo(
    () => new Map(electionDay.nonVotingReasons.map((r) => [r.id, r])),
    [electionDay.nonVotingReasons],
  );
  const allocation = useCoordinatorAllocation(electionDay.allContacts, reasonsById);

  const phase = resolveCoordinatorAllocationPhase(
    allocation.unassignedCount,
    allocation.coordinators.length,
  );
  const showLive = phase === "live";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button
            type="button"
            onClick={onBack}
            className="mb-1 flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-700"
          >
            <ArrowRight className="size-4" />
            {text.backToFiles}
          </button>
          <h2 className="text-xl font-extrabold text-slate-800">{text.title}</h2>
          <p className="text-sm text-slate-500">{text.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold text-slate-500">
          <span>
            {text.summary.total}:{" "}
            <span className="tabular-nums text-slate-800">
              {allocation.assignedCount + allocation.unassignedCount}
            </span>
          </span>
          <span>
            {text.summary.assigned}:{" "}
            <span className="tabular-nums text-slate-800">
              {allocation.assignedCount}
            </span>
          </span>
          <span>
            {text.summary.unassigned}:{" "}
            <span className="tabular-nums text-slate-800">
              {allocation.unassignedCount}
            </span>
          </span>
          <span>
            {allocation.coordinators.length === 0
              ? text.summary.noCoordinatorsYet
              : `${text.summary.activeCoordinators}: ${allocation.activeCoordinators.length}`}
          </span>
        </div>
      </div>

      {!allocation.coordinatorsLoaded ? null : showLive ? (
        <CoordinatorAllocationLive
          coordinators={allocation.coordinators}
          activeCoordinators={allocation.activeCoordinators}
          coordinatorStats={allocation.coordinatorStats}
          contacts={electionDay.allContacts}
          total={allocation.assignedCount + allocation.unassignedCount}
          unassignedCount={allocation.unassignedCount}
          manageCoordinators={allocation.manageCoordinators}
          managingCoordinators={allocation.managingCoordinators}
          rebalanceAssignments={allocation.rebalanceAssignments}
          rebalancing={allocation.rebalancing}
          endCoordinatorActivity={allocation.endCoordinatorActivity}
          endingCoordinatorActivity={allocation.endingCoordinatorActivity}
        />
      ) : (
        <CoordinatorAllocationSetup
          coordinators={allocation.coordinators}
          activeCoordinators={allocation.activeCoordinators}
          contacts={electionDay.allContacts}
          unassignedCount={allocation.unassignedCount}
          assignedCount={allocation.assignedCount}
          manageCoordinators={allocation.manageCoordinators}
          managingCoordinators={allocation.managingCoordinators}
          applyInitialAllocation={allocation.applyInitialAllocation}
          applyingInitialAllocation={allocation.applyingInitialAllocation}
        />
      )}

      {/* Security Hardening (Reauth), Phase 2: the shared password-reauth
          prompt for this hook's 4 allocation mutations - rendered once here
          (mirrors `ElectionDayShell.tsx`'s identical pattern for
          `useElectionDay`'s own reauth dialog), reusing
          `AllocationPasswordDialog`'s existing visual pattern. */}
      {allocation.reauthDialog && (
        <AllocationPasswordDialog {...allocation.reauthDialog} />
      )}
    </div>
  );
}
