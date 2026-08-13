import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import type { AllocationAssignment } from "../../services/api";
import type { Coordinator } from "../../types";
import type { CoordinatorAllocationStats } from "./coordinatorAllocationStats";
import { isValidQuantityRaw, validateRebalance } from "./coordinatorAllocationValidation";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.rebalance;

function QuantityInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (raw: string) => void;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={text.quantityAriaLabel}
      value={value}
      placeholder="0"
      onChange={(e) => {
        if (isValidQuantityRaw(e.target.value)) onChange(e.target.value);
      }}
      className="h-10 w-20 rounded-lg bg-white px-3 text-center text-sm tabular-nums ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
    />
  );
}

/**
 * Coordinator Allocation Management (Phase 5): "העברת הקצאות" - multi-source,
 * multi-destination mid-day rebalance. A coordinator with a positive source
 * quantity is removed from the destination list entirely (not just
 * disabled), which is what structurally rules out picking the same
 * coordinator on both sides - no separate same-coordinator check needed.
 * Never selects voter ids - only `{coordinatorId, quantity}` pairs, same
 * contract as initial allocation.
 */
export function RebalanceDialog({
  open,
  activeCoordinators,
  coordinatorStats,
  onSubmit,
  busy,
  onClose,
}: {
  open: boolean;
  activeCoordinators: Coordinator[];
  coordinatorStats: CoordinatorAllocationStats[];
  onSubmit: (
    sources: AllocationAssignment[],
    destinations: AllocationAssignment[],
    copy: ReauthCopy,
  ) => Promise<unknown>;
  busy: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"form" | "preview">("form");
  const [sourceRaw, setSourceRaw] = useState<Record<string, string>>({});
  const [destRaw, setDestRaw] = useState<Record<string, string>>({});

  const statsById = new Map(coordinatorStats.map((s) => [s.coordinatorId, s]));

  const reset = () => {
    setStep("form");
    setSourceRaw({});
    setDestRaw({});
  };
  const handleClose = () => {
    reset();
    onClose();
  };

  const sourceEntries = activeCoordinators.map((c) => {
    const quantity = Number(sourceRaw[c.id] || "0");
    return {
      coordinatorId: c.id,
      displayName: c.displayName,
      remaining: statsById.get(c.id)?.remainingCount ?? 0,
      raw: sourceRaw[c.id] ?? "",
      quantity,
    };
  });
  const sourcesSelected = sourceEntries.filter((e) => e.quantity > 0);

  const destinationCandidates = activeCoordinators.filter(
    (c) => Number(sourceRaw[c.id] || "0") === 0,
  );
  const destEntries = destinationCandidates.map((c) => ({
    coordinatorId: c.id,
    displayName: c.displayName,
    raw: destRaw[c.id] ?? "",
    quantity: Number(destRaw[c.id] || "0"),
  }));
  const destinationsSelected = destEntries.filter((e) => e.quantity > 0);

  const sourceTotal = sourcesSelected.reduce((sum, e) => sum + e.quantity, 0);
  const destTotal = destinationsSelected.reduce((sum, e) => sum + e.quantity, 0);

  const validation = validateRebalance(
    sourceEntries.map((e) => ({
      coordinatorId: e.coordinatorId,
      quantity: e.quantity,
      remaining: e.remaining,
    })),
    destEntries.map((e) => ({ coordinatorId: e.coordinatorId, quantity: e.quantity })),
  );
  const canContinue = validation.valid;

  const submitSummary = (
    <div className="space-y-1.5">
      {sourcesSelected.map((e) => (
        <div key={e.coordinatorId} className="flex justify-between">
          <span>- {e.displayName}</span>
          <span className="tabular-nums font-semibold">{e.quantity}</span>
        </div>
      ))}
      <div className="border-t border-slate-200 pt-1.5" />
      {destinationsSelected.map((e) => (
        <div key={e.coordinatorId} className="flex justify-between">
          <span>+ {e.displayName}</span>
          <span className="tabular-nums font-semibold">{e.quantity}</span>
        </div>
      ))}
    </div>
  );

  const handleSubmit = async () => {
    const sources = sourcesSelected.map((e) => ({
      coordinatorId: e.coordinatorId,
      quantity: e.quantity,
    }));
    const destinations = destinationsSelected.map((e) => ({
      coordinatorId: e.coordinatorId,
      quantity: e.quantity,
    }));
    const result = await onSubmit(sources, destinations, {
      title: text.title,
      summary: submitSummary,
      confirmLabel: text.confirmButton,
    });
    if (result !== undefined) handleClose();
    return result;
  };

  if (!open) return null;

  return (
    <>
      <Modal open={step === "form"} onClose={handleClose} title={text.title} wide>
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-bold text-slate-700">{text.sourcesTitle}</h3>
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {sourceEntries.map((e) => (
                <li
                  key={e.coordinatorId}
                  className="flex items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-700">
                      {e.displayName}
                    </p>
                    <p className="text-xs text-slate-400">
                      {ELECTION_DAY_TEXT.coordinatorAllocation.live.remainingLabel(
                        e.remaining,
                      )}
                    </p>
                    {e.quantity > e.remaining && (
                      <p className="text-xs font-semibold text-opponent">
                        {text.sourceExceedsRemaining}
                      </p>
                    )}
                  </div>
                  <QuantityInput
                    value={e.raw}
                    onChange={(raw) =>
                      setSourceRaw((prev) => ({ ...prev, [e.coordinatorId]: raw }))
                    }
                  />
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-bold text-slate-700">
              {text.destinationsTitle}
            </h3>
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {destEntries.map((e) => (
                <li
                  key={e.coordinatorId}
                  className="flex items-center justify-between gap-2 px-3 py-2.5"
                >
                  <span className="truncate text-sm font-semibold text-slate-700">
                    {e.displayName}
                  </span>
                  <QuantityInput
                    value={e.raw}
                    onChange={(raw) =>
                      setDestRaw((prev) => ({ ...prev, [e.coordinatorId]: raw }))
                    }
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold">
            <span className="text-slate-600">{text.transferringTotal(sourceTotal)}</span>
            <span className="text-slate-600">{text.receivingTotal(destTotal)}</span>
          </div>
          {!validation.valid && validation.reason === "MISMATCH" && (
            <p className="text-sm font-semibold text-opponent">{text.mismatch}</p>
          )}
          {!validation.valid && validation.reason === "SAME_COORDINATOR" && (
            <p className="text-sm font-semibold text-opponent">
              {text.sameCoordinatorBothSides}
            </p>
          )}
          {!validation.valid && validation.reason === "SOURCE_EXCEEDS_REMAINING" && (
            <p className="text-sm font-semibold text-opponent">
              {text.sourceExceedsRemaining}
            </p>
          )}
          {!validation.valid && validation.reason === "NO_SOURCE" && (
            <p className="text-xs text-slate-400">{text.noSource}</p>
          )}
          {!validation.valid && validation.reason === "NO_DESTINATION" && (
            <p className="text-xs text-slate-400">{text.noDestination}</p>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              className="flex-1"
              disabled={!canContinue}
              onClick={() => setStep("preview")}
            >
              {text.previewTitle}
            </Button>
            <Button variant="secondary" onClick={handleClose}>
              {text.cancelButton}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={step === "preview"}
        onClose={() => setStep("form")}
        title={text.previewTitle}
      >
        <div className="space-y-4">
          <div>
            <h3 className="mb-1.5 text-xs font-bold text-slate-400">
              {text.previewFromLabel}
            </h3>
            <ul className="space-y-1">
              {sourcesSelected.map((e) => (
                <li key={e.coordinatorId} className="flex justify-between text-sm">
                  <span>{e.displayName}</span>
                  <span className="tabular-nums font-semibold">{e.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1.5 text-xs font-bold text-slate-400">
              {text.previewToLabel}
            </h3>
            <ul className="space-y-1">
              {destinationsSelected.map((e) => (
                <li key={e.coordinatorId} className="flex justify-between text-sm">
                  <span>{e.displayName}</span>
                  <span className="tabular-nums font-semibold">{e.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-sm font-bold text-slate-700">
            {text.previewTotal(sourceTotal)}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep("form")}>
              {text.backButton}
            </Button>
            <Button
              className="flex-1"
              loading={busy}
              disabled={busy}
              onClick={() => void handleSubmit()}
            >
              {text.confirmButton}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
