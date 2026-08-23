import { Check, Pencil, Phone, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";
import { useCoordinatorRowActions } from "./useCoordinatorRowActions";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.roster;

/**
 * One coordinator's full management row (rename, phone, remove, unlink an
 * existing Excel-assignment link) - the flex-column layout used by the
 * roster list (Setup's dedicated coordinators step, and any other future
 * "manage every coordinator in a simple list" context). `CoordinatorAllocationLive.tsx`'s
 * column-aligned grid table renders its own JSX instead (to fit the existing
 * totalAssigned/remaining/status columns + rebalance/end actions), but calls
 * the same `useCoordinatorRowActions` hook this component uses, so the
 * business logic never duplicates between the two layouts.
 */
export function CoordinatorRow({
  coordinator,
  contacts,
  allCoordinators,
  onManage,
  busy,
  allowRename,
  allowRemove,
}: {
  coordinator: Coordinator;
  contacts: readonly ElectionDayVoter[];
  allCoordinators: readonly Coordinator[];
  onManage: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  busy: boolean;
  allowRename: boolean;
  allowRemove: boolean;
}) {
  const row = useCoordinatorRowActions(coordinator, contacts, allCoordinators, onManage);
  const c = coordinator;

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        {row.isEditingName && allowRename ? (
          <div className="flex flex-1 items-center gap-2">
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
              aria-label={text.saveAriaLabel}
              className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
            >
              <Check className="size-4" />
            </button>
            <button
              type="button"
              onClick={row.cancelEdit}
              aria-label={text.cancelEditAriaLabel}
              className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-800">
                {c.displayName}
                {c.status === "ended" && (
                  <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                    {text.endedBadge}
                  </span>
                )}
              </p>
              {c.linkedAssignmentName !== null && (
                <p className="truncate text-xs text-slate-500">
                  {text.linkedBadge(c.linkedAssignmentName)}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {allowRename && c.status === "active" && (
                <button
                  type="button"
                  disabled={!row.isEligibleForEditOrRemove}
                  onClick={() => row.isEligibleForEditOrRemove && row.startEdit()}
                  aria-label={
                    row.isEligibleForEditOrRemove
                      ? text.editAriaLabel
                      : text.editAriaLabelBlocked
                  }
                  className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Pencil className="size-4" />
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {allowRemove && c.status === "active" && !row.isEditingName && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="danger-outline"
            size="sm"
            disabled={busy || !row.isEligibleForEditOrRemove}
            onClick={() => void row.handleRemoveClick()}
            aria-label={
              row.isEligibleForEditOrRemove
                ? text.removeAriaLabel
                : text.removeAriaLabelBlocked
            }
          >
            <Trash2 className="size-3.5" />
            {text.removeButton}
          </Button>
          {!row.isEligibleForEditOrRemove && (
            <p className="text-xs text-slate-500">{text.assignedVotersReason}</p>
          )}
        </div>
      )}

      {!allowRemove &&
        !row.isEligibleForEditOrRemove &&
        c.status === "active" &&
        allowRename && (
          <p className="text-xs text-slate-500">{text.assignedVotersReason}</p>
        )}

      {/* Phone is CONTACT METADATA, not identity - a plain inline field,
          editable regardless of the name-lock state above (no visual
          grouping with the identity pencil/trash icons). */}
      {row.isEditingPhone ? (
        <div className="flex items-center gap-2">
          <Phone className="size-3.5 shrink-0 text-slate-400" />
          <Input
            value={row.editingPhoneValue}
            onChange={(e) => row.setEditingPhoneValue(e.target.value)}
            placeholder={text.phonePlaceholder}
            dir="ltr"
            invalid={!!row.phoneError}
            autoFocus
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === "Enter") void row.confirmPhoneEdit();
              if (e.key === "Escape") row.cancelPhoneEdit();
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void row.confirmPhoneEdit()}
            aria-label={text.savePhoneAriaLabel}
            className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
          >
            <Check className="size-4" />
          </button>
          <button
            type="button"
            onClick={row.cancelPhoneEdit}
            aria-label={text.cancelPhoneEditAriaLabel}
            className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={row.startPhoneEdit}
          aria-label={text.editPhoneAriaLabel}
          className="flex w-fit items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-primary-600"
        >
          <Phone className="size-3.5 shrink-0" />
          {c.phone ? (
            <span dir="ltr" className="tabular-nums">
              {c.phone}
            </span>
          ) : (
            text.addPhoneLink
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
          {text.unlinkButton}
        </button>
      )}
    </li>
  );
}
