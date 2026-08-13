import { useMemo, useState } from "react";
import { Card, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/utils";
import type { AllocationAssignment, CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { computeEqualSplit } from "./coordinatorAllocationEqualSplit";
import {
  isValidQuantityRaw,
  manualAllocationStatus,
} from "./coordinatorAllocationValidation";
import { CoordinatorRosterEditor } from "./CoordinatorRosterEditor";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation;

type Step = "coordinators" | "method" | "preview" | "confirm";
const STEPS: Step[] = ["coordinators", "method", "preview", "confirm"];

type Method = "equal" | "manual";

/**
 * Coordinator Allocation Management (Phase 5): the one-time initial-setup
 * flow ("today's coordinators" -> distribution method -> preview ->
 * password confirm) shown while there is no allocation activity yet - see
 * `CoordinatorAllocationPage.tsx`'s comment for the exact phase-derivation
 * rule that decides when this unmounts in favor of the live management
 * view. All quantities here are a client-side preview only - the server
 * (`election_day_apply_initial_allocation`) recounts `unassignedCount`
 * itself and rejects a stale total via `ALLOCATION_COUNT_MISMATCH`.
 */
export function CoordinatorAllocationSetup({
  coordinators,
  activeCoordinators,
  contacts,
  unassignedCount,
  assignedCount,
  manageCoordinators,
  managingCoordinators,
  applyInitialAllocation,
  applyingInitialAllocation,
}: {
  coordinators: Coordinator[];
  activeCoordinators: Coordinator[];
  contacts: readonly ElectionDayVoter[];
  unassignedCount: number;
  assignedCount: number;
  manageCoordinators: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  managingCoordinators: boolean;
  applyInitialAllocation: (
    assignments: AllocationAssignment[],
    copy: ReauthCopy,
  ) => Promise<unknown>;
  applyingInitialAllocation: boolean;
}) {
  const [step, setStep] = useState<Step>("coordinators");
  const [method, setMethod] = useState<Method>("equal");
  const [manualRaw, setManualRaw] = useState<Record<string, string>>({});

  const activeIds = useMemo(
    () => activeCoordinators.map((c) => c.id),
    [activeCoordinators],
  );

  const equalSplit = useMemo(
    () => computeEqualSplit(unassignedCount, activeIds),
    [unassignedCount, activeIds],
  );

  const manualEntries = useMemo(
    () =>
      activeCoordinators.map((c) => {
        const raw = manualRaw[c.id] ?? "";
        const quantity = raw === "" ? 0 : Number(raw);
        return { coordinatorId: c.id, displayName: c.displayName, raw, quantity };
      }),
    [activeCoordinators, manualRaw],
  );
  const manualTotal = manualEntries.reduce((sum, e) => sum + e.quantity, 0);
  const manualDiff = unassignedCount - manualTotal;
  const manualStatus = manualAllocationStatus(manualTotal, unassignedCount);
  const manualValid = manualStatus === "exact";

  const plannedAssignments = useMemo(
    () =>
      activeCoordinators.map((c) => ({
        coordinatorId: c.id,
        displayName: c.displayName,
        quantity:
          method === "equal"
            ? (equalSplit.get(c.id) ?? 0)
            : (manualEntries.find((e) => e.coordinatorId === c.id)?.quantity ?? 0),
      })),
    [activeCoordinators, method, equalSplit, manualEntries],
  );

  const setManualQuantity = (coordinatorId: string, raw: string) => {
    if (!isValidQuantityRaw(raw)) return;
    setManualRaw((prev) => ({ ...prev, [coordinatorId]: raw }));
  };

  const canContinueFromMethod = method === "equal" || manualValid;

  const applySummary = (
    <div className="space-y-1.5">
      {plannedAssignments
        .filter((a) => a.quantity > 0)
        .map((a) => (
          <div key={a.coordinatorId} className="flex justify-between">
            <span>{a.displayName}</span>
            <span className="tabular-nums font-semibold">{a.quantity}</span>
          </div>
        ))}
      <div className="flex justify-between border-t border-slate-200 pt-1.5 font-bold">
        <span>{text.preview.totalLine(unassignedCount)}</span>
      </div>
    </div>
  );

  const handleApply = () => {
    const assignments = plannedAssignments
      .filter((a) => a.quantity > 0)
      .map((a) => ({ coordinatorId: a.coordinatorId, quantity: a.quantity }));
    return applyInitialAllocation(assignments, {
      title: text.confirmDialog.applyTitle,
      summary: applySummary,
      confirmLabel: text.confirmDialog.applyButton,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-center gap-2">
        {STEPS.map((s, index) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-bold",
                s === step
                  ? "bg-primary-600 text-white"
                  : STEPS.indexOf(step) > index
                    ? "bg-primary-100 text-primary-700"
                    : "bg-slate-100 text-slate-400",
              )}
            >
              {index + 1}
            </div>
            <span
              className={cn(
                "hidden text-xs font-semibold sm:inline",
                s === step ? "text-primary-700" : "text-slate-400",
              )}
            >
              {text.steps[s]}
            </span>
            {index < STEPS.length - 1 && <div className="h-px w-4 bg-slate-200 sm:w-8" />}
          </div>
        ))}
      </div>

      {step === "coordinators" && (
        <Card>
          <CardTitle className="mb-4">{text.steps.coordinators}</CardTitle>
          <CoordinatorRosterEditor
            coordinators={coordinators}
            contacts={contacts}
            onManage={manageCoordinators}
            busy={managingCoordinators}
            allowRename
            allowRemove
          />
          <div className="mt-5 flex flex-col items-end gap-1.5">
            {activeCoordinators.length === 0 && (
              <p className="text-xs font-semibold text-amber-600">
                {text.method.noActiveCoordinators}
              </p>
            )}
            <Button
              className="w-full sm:w-auto"
              disabled={activeCoordinators.length === 0}
              onClick={() => setStep("method")}
            >
              {text.method.continueButton}
            </Button>
          </div>
        </Card>
      )}

      {step === "method" && (
        <Card className="space-y-5">
          <CardTitle>{text.method.title}</CardTitle>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMethod("equal")}
              className={cn(
                "rounded-2xl p-4 text-start ring-2 transition",
                method === "equal"
                  ? "bg-primary-50 ring-primary-500"
                  : "bg-white ring-slate-200 hover:bg-slate-50",
              )}
            >
              <p className="font-bold text-slate-800">{text.method.equalTitle}</p>
              <p className="mt-1 text-sm text-slate-500">
                {text.method.equalDescription}
              </p>
            </button>
            <button
              type="button"
              onClick={() => setMethod("manual")}
              className={cn(
                "rounded-2xl p-4 text-start ring-2 transition",
                method === "manual"
                  ? "bg-primary-50 ring-primary-500"
                  : "bg-white ring-slate-200 hover:bg-slate-50",
              )}
            >
              <p className="font-bold text-slate-800">{text.method.manualTitle}</p>
              <p className="mt-1 text-sm text-slate-500">
                {text.method.manualDescription}
              </p>
            </button>
          </div>

          {method === "manual" && (
            <div className="space-y-3">
              <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
                {manualEntries.map((entry) => (
                  <li
                    key={entry.coordinatorId}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <span className="truncate text-sm font-semibold text-slate-700">
                      {entry.displayName}
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={entry.raw}
                      placeholder="0"
                      onChange={(e) =>
                        setManualQuantity(entry.coordinatorId, e.target.value)
                      }
                      className="h-10 w-24 rounded-lg bg-white px-3 text-center text-sm tabular-nums ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold">
                <span className="text-slate-600">
                  {text.method.manualAssignedOf(manualTotal, unassignedCount)}
                </span>
                <span
                  className={manualDiff === 0 ? "text-emerald-600" : "text-slate-500"}
                >
                  {text.method.manualRemaining(Math.max(manualDiff, 0))}
                </span>
                {manualDiff > 0 && (
                  <span className="text-amber-600">
                    {text.method.manualUnder(manualDiff)}
                  </span>
                )}
                {manualDiff < 0 && (
                  <span className="text-opponent">
                    {text.method.manualOver(Math.abs(manualDiff))}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep("coordinators")}>
              {text.method.backButton}
            </Button>
            <Button
              className="flex-1"
              disabled={!canContinueFromMethod}
              onClick={() => setStep("preview")}
            >
              {text.method.continueButton}
            </Button>
          </div>
        </Card>
      )}

      {step === "preview" && (
        <Card className="space-y-4">
          <CardTitle>{text.preview.title}</CardTitle>
          <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
            {plannedAssignments.map((a) => (
              <li
                key={a.coordinatorId}
                className="flex items-center justify-between px-3 py-2.5 text-sm"
              >
                <span className="font-semibold text-slate-700">{a.displayName}</span>
                <span className="tabular-nums font-bold text-primary-700">
                  {a.quantity}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm font-semibold text-slate-600">
            {text.preview.totalLine(unassignedCount)}
          </p>
          {assignedCount > 0 && (
            <p className="text-xs text-slate-400">
              {text.preview.alreadyAssignedNote(assignedCount)}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep("method")}>
              {text.preview.backButton}
            </Button>
            <Button
              className="flex-1"
              loading={applyingInitialAllocation}
              disabled={applyingInitialAllocation}
              onClick={() => void handleApply()}
            >
              {text.preview.confirmButton}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
