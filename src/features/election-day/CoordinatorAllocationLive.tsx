import { useState } from "react";
import { Flag, UserPlus, Users } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import type {
  AllocationAssignment,
  CoordinatorAction,
  EndCoordinatorActivityMode,
} from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { CoordinatorLiveRow } from "./CoordinatorLiveRow";
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
 * for the exact phase-derivation rule). Stats + a main "אחראים" table whose
 * rows carry every per-coordinator action together (`העבר הקצאות`/
 * `סיום פעילות`/`הסר אחראי`, plus rename/phone/link management -
 * `CoordinatorLiveRow.tsx`), and a separate, always-available "➕ הוסף אחראי"
 * panel that does ONLY one thing: add a new coordinator (UX fix, 2026-08-22
 * - `הסר אחראי` and the rest of existing-coordinator management used to live
 * inside that add panel, which was conceptually wrong: adding a coordinator
 * and managing an existing one are different actions). `allowRename
 * allowRemove` (2026-08-21) reflect the server's real per-coordinator guard,
 * not the old global activity flag that made hiding these conservatively
 * necessary here.
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
              onCancelAdd={() => setShowRoster(false)}
              showExistingCoordinators={false}
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
              {coordinators.map((c) => (
                <CoordinatorLiveRow
                  key={c.id}
                  coordinator={c}
                  contacts={contacts}
                  allCoordinators={coordinators}
                  onManage={manageCoordinators}
                  busy={managingCoordinators}
                  stats={statByCoordinatorId.get(c.id)}
                  onRebalanceClick={() => setRebalanceOpen(true)}
                  onEndClick={() => setEndTarget(c)}
                />
              ))}
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
