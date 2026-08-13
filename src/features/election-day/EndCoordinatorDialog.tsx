import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import type { EndCoordinatorActivityMode } from "../../services/api";
import type { Coordinator } from "../../types";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { computeEqualSplit } from "./coordinatorAllocationEqualSplit";
import type { CoordinatorAllocationStats } from "./coordinatorAllocationStats";
import {
  isEndBlockedByLastActive,
  isValidEndTransferTarget,
} from "./coordinatorAllocationValidation";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.end;

/**
 * Coordinator Allocation Management (Phase 5): "סיום פעילות" - ends one
 * active coordinator's day, moving whatever they still have remaining
 * either to one chosen target or split equally among the other active
 * coordinators. The last-active+remaining>0 block
 * (`LAST_ACTIVE_COORDINATOR`) is enforced client-side too (no RPC call at
 * all in that state, per the Phase 5 spec) - remaining===0 is always
 * allowed, including for the last active coordinator, since the server's
 * own guard only fires when there's something left to move (see the
 * mapper's Hebrew text for that code).
 */
export function EndCoordinatorDialog({
  coordinator,
  activeCoordinators,
  coordinatorStats,
  onSubmit,
  busy,
  onClose,
}: {
  coordinator: Coordinator | null;
  activeCoordinators: Coordinator[];
  coordinatorStats: CoordinatorAllocationStats[];
  onSubmit: (
    password: string,
    coordinatorId: string,
    mode: EndCoordinatorActivityMode,
    targetCoordinatorId: string | null,
  ) => Promise<unknown>;
  busy: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<EndCoordinatorActivityMode>("transfer");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Render-phase reset on target change (mirrors ResetPasswordDialog.tsx's
  // `trackedUserId` pattern) - a fresh coordinator means any previously
  // chosen mode/target no longer applies.
  const [trackedId, setTrackedId] = useState<string | null>(coordinator?.id ?? null);
  const currentId = coordinator?.id ?? null;
  if (currentId !== trackedId) {
    setTrackedId(currentId);
    setMode("transfer");
    setTargetId(null);
    setConfirmOpen(false);
  }

  if (!coordinator) return null;

  const remaining =
    coordinatorStats.find((s) => s.coordinatorId === coordinator.id)?.remainingCount ?? 0;
  const otherActive = activeCoordinators.filter((c) => c.id !== coordinator.id);
  const blocked = isEndBlockedByLastActive(remaining, otherActive.length);
  const equalSplitPreview = computeEqualSplit(
    remaining,
    otherActive.map((c) => c.id),
  );

  const handleClose = () => {
    setConfirmOpen(false);
    onClose();
  };

  const canConfirm =
    remaining === 0 ||
    (mode === "transfer"
      ? isValidEndTransferTarget(targetId, coordinator.id)
      : otherActive.length > 0);

  const handleSubmit = async (password: string) => {
    const effectiveMode: EndCoordinatorActivityMode =
      remaining === 0 ? "equal_split" : mode;
    const effectiveTarget =
      remaining === 0 || effectiveMode === "equal_split" ? null : targetId;
    const result = await onSubmit(
      password,
      coordinator.id,
      effectiveMode,
      effectiveTarget,
    );
    if (result !== undefined) handleClose();
    return result;
  };

  const targetName = otherActive.find((c) => c.id === targetId)?.displayName ?? "";
  const confirmSummary =
    remaining === 0
      ? text.zeroRemainingNote
      : mode === "transfer"
        ? text.confirmTransferSummary(remaining, coordinator.displayName, targetName)
        : text.confirmEqualSummary(remaining, otherActive.length);

  return (
    <>
      <Modal open={!confirmOpen} onClose={handleClose} title={text.title}>
        <div className="space-y-5">
          <div>
            <p className="text-sm font-bold text-slate-800">{coordinator.displayName}</p>
            <p className="text-xs text-slate-500">{text.remainingLabel(remaining)}</p>
          </div>

          {blocked && (
            <p className="rounded-xl bg-opponent-soft px-3.5 py-3 text-sm font-semibold text-opponent">
              {text.lastActiveBlocked}
            </p>
          )}

          {!blocked && remaining === 0 && (
            <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-sm text-slate-600">
              {text.zeroRemainingNote}
            </p>
          )}

          {!blocked && remaining > 0 && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setMode("transfer")}
                className={cn(
                  "w-full rounded-2xl p-4 text-start ring-2 transition",
                  mode === "transfer"
                    ? "bg-primary-50 ring-primary-500"
                    : "bg-white ring-slate-200 hover:bg-slate-50",
                )}
              >
                <p className="font-bold text-slate-800">{text.optionTransferTitle}</p>
                <p className="mt-1 text-sm text-slate-500">
                  {text.optionTransferDescription}
                </p>
                {mode === "transfer" && (
                  <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                    {otherActive.length === 0 ? (
                      <p className="text-xs font-semibold text-opponent">
                        {text.noValidTarget}
                      </p>
                    ) : (
                      <select
                        value={targetId ?? ""}
                        onChange={(e) => setTargetId(e.target.value || null)}
                        className="h-10 w-full rounded-lg bg-white px-3 text-sm ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
                      >
                        <option value="" disabled>
                          {text.targetLabel}
                        </option>
                        {otherActive.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.displayName}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </button>

              <button
                type="button"
                onClick={() => setMode("equal_split")}
                className={cn(
                  "w-full rounded-2xl p-4 text-start ring-2 transition",
                  mode === "equal_split"
                    ? "bg-primary-50 ring-primary-500"
                    : "bg-white ring-slate-200 hover:bg-slate-50",
                )}
              >
                <p className="font-bold text-slate-800">{text.optionEqualTitle}</p>
                <p className="mt-1 text-sm text-slate-500">
                  {text.optionEqualDescription}
                </p>
                {mode === "equal_split" && (
                  <ul className="mt-3 space-y-1">
                    {otherActive.map((c) => (
                      <li key={c.id} className="flex justify-between text-sm">
                        <span>{c.displayName}</span>
                        <span className="tabular-nums font-semibold">
                          {equalSplitPreview.get(c.id) ?? 0}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              className="flex-1"
              disabled={blocked || !canConfirm}
              onClick={() => setConfirmOpen(true)}
            >
              {text.confirmButton}
            </Button>
            <Button variant="secondary" onClick={handleClose}>
              {text.cancelButton}
            </Button>
          </div>
        </div>
      </Modal>

      <AllocationPasswordDialog
        open={confirmOpen}
        title={text.title}
        summary={confirmSummary}
        confirmLabel={text.confirmButton}
        busy={busy}
        onConfirm={handleSubmit}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
