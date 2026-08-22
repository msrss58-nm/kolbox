import { useState } from "react";
import { ArrowLeftRight, Flag, UserPlus, Users } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { cn } from "../../lib/utils";
import type {
  AllocationAssignment,
  CoordinatorAction,
  EndCoordinatorActivityMode,
} from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import type { CoordinatorAllocationStats } from "./coordinatorAllocationStats";
import { CoordinatorRosterEditor } from "./CoordinatorRosterEditor";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayStatTile } from "./ElectionDayStatTile";
import { EndCoordinatorDialog } from "./EndCoordinatorDialog";
import { RebalanceDialog } from "./RebalanceDialog";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation;

/**
 * Coordinator Allocation Management (Phase 5): the day-of management view -
 * shown once allocation activity exists (see `CoordinatorAllocationPage.tsx`
 * for the exact phase-derivation rule). Stats + coordinator roster with
 * per-row rebalance/end actions, plus an always-available "add coordinator"
 * section that now also allows rename/remove (`allowRename allowRemove`,
 * 2026-08-21) - previously hidden here specifically because the server's old
 * guard was a global activity flag with no reliable per-coordinator signal
 * to gate the UI with; now that the guard is a real per-coordinator
 * predicate, `CoordinatorRosterEditor`'s own row-level eligibility check
 * applies correctly in this view too.
 */
export function CoordinatorAllocationLive({
  coordinators,
  activeCoordinators,
  coordinatorStats,
  contacts,
  total,
  unassignedCount,
  manageCoordinators,
  managingCoordinators,
  rebalanceAssignments,
  rebalancing,
  endCoordinatorActivity,
  endingCoordinatorActivity,
}: {
  coordinators: Coordinator[];
  activeCoordinators: Coordinator[];
  coordinatorStats: CoordinatorAllocationStats[];
  contacts: readonly ElectionDayVoter[];
  total: number;
  unassignedCount: number;
  manageCoordinators: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  managingCoordinators: boolean;
  rebalanceAssignments: (
    sources: AllocationAssignment[],
    destinations: AllocationAssignment[],
    copy: ReauthCopy,
  ) => Promise<unknown>;
  rebalancing: boolean;
  endCoordinatorActivity: (
    coordinatorId: string,
    mode: EndCoordinatorActivityMode,
    targetCoordinatorId: string | null,
    copy: ReauthCopy,
  ) => Promise<unknown>;
  endingCoordinatorActivity: boolean;
}) {
  const [showRoster, setShowRoster] = useState(false);
  const [rebalanceOpen, setRebalanceOpen] = useState(false);
  const [endTarget, setEndTarget] = useState<Coordinator | null>(null);

  const totalRemaining = coordinatorStats.reduce((sum, s) => sum + s.remainingCount, 0);
  const statByCoordinatorId = new Map(coordinatorStats.map((s) => [s.coordinatorId, s]));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ElectionDayStatTile icon={Users} label={text.live.stats.total} value={total} />
        <ElectionDayStatTile
          icon={UserPlus}
          label={text.live.stats.unassigned}
          value={unassignedCount}
          tone={unassignedCount > 0 ? "warning" : "success"}
        />
        <ElectionDayStatTile
          icon={Users}
          label={text.live.stats.activeCoordinators}
          value={activeCoordinators.length}
          tone="primary"
        />
        <ElectionDayStatTile
          icon={Flag}
          label={text.live.stats.remaining}
          value={totalRemaining}
          tone="info"
        />
      </div>

      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <CardTitle>{text.steps.coordinators}</CardTitle>
          <Button size="sm" variant="secondary" onClick={() => setShowRoster((v) => !v)}>
            ➕ {text.live.addCoordinatorButton}
          </Button>
        </div>

        {showRoster && (
          <div className="mb-5 border-b border-slate-100 pb-5">
            <CoordinatorRosterEditor
              coordinators={coordinators}
              contacts={contacts}
              onManage={manageCoordinators}
              busy={managingCoordinators}
              allowRename
              allowRemove
            />
          </div>
        )}

        {coordinators.length === 0 ? (
          <EmptyState
            icon={Users}
            title={text.roster.empty}
            hint={text.roster.emptyHint}
          />
        ) : (
          <>
            <div className="hidden grid-cols-[1fr_120px_120px_100px_auto] gap-2 border-b border-slate-100 pb-2 text-xs font-semibold text-slate-400 md:grid">
              <span>{text.live.columns.coordinator}</span>
              <span>{text.live.columns.totalAssigned}</span>
              <span>{text.live.columns.remaining}</span>
              <span>{text.live.columns.status}</span>
              <span>{text.live.columns.actions}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {coordinators.map((c) => {
                const stats = statByCoordinatorId.get(c.id);
                const isActive = c.status === "active";
                return (
                  <li
                    key={c.id}
                    className="grid grid-cols-2 gap-2 py-3 md:grid-cols-[1fr_120px_120px_100px_auto] md:items-center"
                  >
                    <div className="col-span-2 min-w-0 md:col-span-1">
                      <p className="truncate text-sm font-bold text-slate-800">
                        {c.displayName}
                      </p>
                      {c.linkedAssignmentName !== null && (
                        <p className="truncate text-xs text-slate-400">
                          {text.roster.linkedBadge(c.linkedAssignmentName)}
                        </p>
                      )}
                    </div>
                    <div className="text-sm tabular-nums text-slate-600 md:block">
                      <span className="text-xs text-slate-400 md:hidden">
                        {text.live.columns.totalAssigned}:{" "}
                      </span>
                      {stats?.totalAssigned ?? 0}
                    </div>
                    <div className="text-sm font-bold tabular-nums text-primary-700 md:block">
                      <span className="text-xs font-normal text-slate-400 md:hidden">
                        {text.live.columns.remaining}:{" "}
                      </span>
                      {stats?.remainingCount ?? 0}
                    </div>
                    <div>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-0.5 text-xs font-bold",
                          isActive
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-100 text-slate-500",
                        )}
                      >
                        {isActive ? text.live.statusActive : text.live.statusEnded}
                      </span>
                    </div>
                    {isActive && (
                      <div className="col-span-2 flex flex-wrap gap-2 md:col-span-1 md:justify-end">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setRebalanceOpen(true)}
                        >
                          <ArrowLeftRight className="size-3.5" />
                          {text.live.rebalanceButton}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setEndTarget(c)}
                        >
                          {text.live.endButton}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <RebalanceDialog
        open={rebalanceOpen}
        activeCoordinators={activeCoordinators}
        coordinatorStats={coordinatorStats}
        onSubmit={rebalanceAssignments}
        busy={rebalancing}
        onClose={() => setRebalanceOpen(false)}
      />

      <EndCoordinatorDialog
        coordinator={endTarget}
        activeCoordinators={activeCoordinators}
        coordinatorStats={coordinatorStats}
        onSubmit={endCoordinatorActivity}
        busy={endingCoordinatorActivity}
        onClose={() => setEndTarget(null)}
      />
    </div>
  );
}
