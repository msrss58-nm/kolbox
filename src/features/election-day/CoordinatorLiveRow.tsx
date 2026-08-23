import { ArrowLeftRight, Check, Pencil, Phone, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { cn } from "../../lib/utils";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import type { CoordinatorAllocationStats } from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";
import { useCoordinatorRowActions } from "./useCoordinatorRowActions";

const liveText = ELECTION_DAY_TEXT.coordinatorAllocation.live;
const rosterText = ELECTION_DAY_TEXT.coordinatorAllocation.roster;

/**
 * One coordinator's row in the live/day-of "אחראים" table (UX fix,
 * 2026-08-22): `העבר הקצאות`/`סיום פעילות`/`הסר אחראי` now live together
 * here, clustered in the same actions cell - `הסר אחראי` moved OUT of the
 * "➕ הוסף אחראי" add-form panel, which now only ever adds a new coordinator
 * (see `CoordinatorRosterEditor.tsx`'s own comment). Rename/phone/unlink
 * management also moved here for the same reason - managing an existing
 * coordinator is a property of ITS row, not of the add-form's open/closed
 * state. Shares its business logic (eligibility, onManage
 * wiring) with `CoordinatorRow.tsx` (Setup's flex-column list) via the same
 * `useCoordinatorRowActions` hook - only the layout differs, kept as its own
 * column-aligned grid here to match this table's existing
 * totalAssigned/remaining/status columns.
 */
export function CoordinatorLiveRow({
  coordinator,
  contacts,
  allCoordinators,
  onManage,
  busy,
  stats,
  onRebalanceClick,
  onEndClick,
}: {
  coordinator: Coordinator;
  contacts: readonly ElectionDayVoter[];
  allCoordinators: readonly Coordinator[];
  onManage: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  busy: boolean;
  stats: CoordinatorAllocationStats | undefined;
  onRebalanceClick: () => void;
  onEndClick: () => void;
}) {
  const row = useCoordinatorRowActions(coordinator, contacts, allCoordinators, onManage);
  const c = coordinator;
  const isActive = c.status === "active";

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-[1fr_120px_120px_100px_auto] md:items-center">
        <div className="col-span-2 min-w-0 md:col-span-1">
          {row.isEditingName ? (
            <div className="flex items-center gap-2">
              <Input
                value={row.editingName}
                onChange={(e) => row.setEditingName(e.target.value)}
                className="flex-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") void row.confirmEdit();
                  if (e.key === "Escape") row.cancelEdit();
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void row.confirmEdit()}
                aria-label={rosterText.saveAriaLabel}
                className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
              >
                <Check className="size-4" />
              </button>
              <button
                type="button"
                onClick={row.cancelEdit}
                aria-label={rosterText.cancelEditAriaLabel}
                className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">
                  {c.displayName}
                  {c.status === "ended" && (
                    <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                      {rosterText.endedBadge}
                    </span>
                  )}
                </p>
                {c.linkedAssignmentName !== null && (
                  <p className="truncate text-xs text-slate-400">
                    {rosterText.linkedBadge(c.linkedAssignmentName)}
                  </p>
                )}
              </div>
              {isActive && (
                <button
                  type="button"
                  disabled={!row.isEligibleForEditOrRemove}
                  onClick={() => row.isEligibleForEditOrRemove && row.startEdit()}
                  aria-label={
                    row.isEligibleForEditOrRemove
                      ? rosterText.editAriaLabel
                      : rosterText.editAriaLabelBlocked
                  }
                  className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Pencil className="size-4" />
                </button>
              )}
            </div>
          )}
        </div>
        <div className="text-sm tabular-nums text-slate-600 md:block">
          <span className="text-xs text-slate-400 md:hidden">
            {liveText.columns.totalAssigned}:{" "}
          </span>
          {stats?.totalAssigned ?? 0}
        </div>
        <div className="text-sm font-bold tabular-nums text-primary-700 md:block">
          <span className="text-xs font-normal text-slate-400 md:hidden">
            {liveText.columns.remaining}:{" "}
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
            {isActive ? liveText.statusActive : liveText.statusEnded}
          </span>
        </div>
        {isActive && (
          <div className="col-span-2 flex flex-wrap gap-2 md:col-span-1 md:justify-end">
            <Button size="sm" variant="secondary" onClick={onRebalanceClick}>
              <ArrowLeftRight className="size-3.5" />
              {liveText.rebalanceButton}
            </Button>
            <Button size="sm" variant="secondary" onClick={onEndClick}>
              {liveText.endButton}
            </Button>
            <Button
              type="button"
              variant="danger-outline"
              size="sm"
              disabled={busy || !row.isEligibleForEditOrRemove}
              onClick={() => void row.handleRemoveClick()}
              aria-label={
                row.isEligibleForEditOrRemove
                  ? rosterText.removeAriaLabel
                  : rosterText.removeAriaLabelBlocked
              }
            >
              <Trash2 className="size-3.5" />
              {rosterText.removeButton}
            </Button>
          </div>
        )}
      </div>

      {!row.isEligibleForEditOrRemove && isActive && (
        <p className="text-xs text-slate-500">{rosterText.assignedVotersReason}</p>
      )}

      {/* Phone is CONTACT METADATA, not identity - editable regardless of
          the name-lock state above. */}
      {row.isEditingPhone ? (
        <div className="flex items-center gap-2">
          <Phone className="size-3.5 shrink-0 text-slate-400" />
          <Input
            value={row.editingPhoneValue}
            onChange={(e) => row.setEditingPhoneValue(e.target.value)}
            placeholder={rosterText.phonePlaceholder}
            dir="ltr"
            invalid={!!row.phoneError}
            autoFocus
            className="max-w-xs flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") void row.confirmPhoneEdit();
              if (e.key === "Escape") row.cancelPhoneEdit();
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void row.confirmPhoneEdit()}
            aria-label={rosterText.savePhoneAriaLabel}
            className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
          >
            <Check className="size-4" />
          </button>
          <button
            type="button"
            onClick={row.cancelPhoneEdit}
            aria-label={rosterText.cancelPhoneEditAriaLabel}
            className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={row.startPhoneEdit}
          aria-label={rosterText.editPhoneAriaLabel}
          className="flex w-fit items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-primary-600"
        >
          <Phone className="size-3.5 shrink-0" />
          {c.phone ? (
            <span dir="ltr" className="tabular-nums">
              {c.phone}
            </span>
          ) : (
            rosterText.addPhoneLink
          )}
        </button>
      )}
      {row.phoneError && row.isEditingPhone && (
        <p className="text-xs text-opponent">{row.phoneError}</p>
      )}

      {c.linkedAssignmentName !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void row.handleUnlinkClick()}
          className="self-start text-xs font-semibold text-slate-500 underline hover:no-underline"
        >
          {rosterText.unlinkButton}
        </button>
      )}
    </li>
  );
}
