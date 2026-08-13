import { useState } from "react";
import { Check, Link2, Pencil, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import type { CoordinatorAction } from "../../services/api";
import type { Coordinator, ElectionDayVoter } from "../../types";
import { countVotersWithRawCoordinatorName } from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ReauthCopy } from "./useCoordinatorAllocation";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.roster;

/**
 * Coordinator Allocation Management (Phase 5): "today's coordinators" roster
 * - add/rename/remove + the explicit Excel-assignment link/relink/unlink
 * flow (`countVotersWithRawCoordinatorName`, exact-match-only, never
 * fuzzy/automatic - see that function's own comment). Used both as Setup
 * Step 1 (`allowRename`/`allowRemove` both true - nothing has touched the
 * server yet) and as the always-available "הוסף אחראי" section in the live
 * management view (`allowRename={false} allowRemove={false}` there - once
 * allocation activity exists server-side, only `add` is guaranteed to stay
 * allowed; rename/remove are conservatively hidden rather than attempting to
 * reproduce the server's exact activity predicate client-side). Link/unlink/
 * relink stay visible in both call sites - that lock is per-coordinator
 * (`COORDINATOR_LOCKED`), not a global activity flag, and Phase 5 has no
 * reliable per-coordinator participation signal to hide them with, so a
 * locked attempt surfaces through the real error mapper instead of being
 * silently guessed away.
 *
 * Security Hardening (Reauth), Phase 2: every action here is a single
 * explicit user click -> one `onManage([action], copy)` call, which runs
 * through `useCoordinatorAllocation`'s shared `reauth.gate` - the first
 * action after a page load (or after the cached proof expires/is revoked)
 * shows the shared `AllocationPasswordDialog` with this action's own
 * `copy`; every further action within the ~15-minute proof lifetime runs
 * immediately with no dialog at all. Always a single-element `actions`
 * array - never a staged multi-edit batch, so there is no "promised atomic
 * batch UX" to accidentally break into N separate calls (see the Phase 5
 * spec's "ADD + LINK LIMITATION" section - a newly-added coordinator's id is
 * only known after this component's own reload, so a later link is
 * naturally its own explicit action, never invented as a client-side temp
 * id).
 */
export function CoordinatorRosterEditor({
  coordinators,
  contacts,
  onManage,
  busy,
  allowRename,
  allowRemove,
}: {
  coordinators: Coordinator[];
  contacts: readonly ElectionDayVoter[];
  onManage: (
    actions: CoordinatorAction[],
    copy: ReauthCopy,
  ) => Promise<Coordinator[] | undefined>;
  busy: boolean;
  allowRename: boolean;
  allowRemove: boolean;
}) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const isDuplicateActiveName = (candidate: string, excludeId?: string) =>
    coordinators.some(
      (c) => c.status === "active" && c.id !== excludeId && c.displayName === candidate,
    );

  const handleAddClick = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(text.emptyNameBlocked);
      return;
    }
    if (isDuplicateActiveName(trimmed)) {
      toast.error(text.duplicateActiveName);
      return;
    }
    const result = await onManage([{ action: "add", displayName: trimmed }], {
      title: text.confirm.addTitle,
      summary: text.confirm.addSummary(trimmed),
      confirmLabel: text.confirm.confirmButton,
    });
    if (result !== undefined) setName("");
  };

  const startEdit = (c: Coordinator) => {
    setEditingId(c.id);
    setEditingName(c.displayName);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };
  const confirmEditClick = async (c: Coordinator) => {
    const trimmed = editingName.trim();
    if (!trimmed) {
      toast.error(text.emptyNameBlocked);
      return;
    }
    if (trimmed === c.displayName) {
      cancelEdit();
      return;
    }
    if (isDuplicateActiveName(trimmed, c.id)) {
      toast.error(text.duplicateActiveName);
      return;
    }
    const result = await onManage(
      [{ action: "edit", coordinatorId: c.id, displayName: trimmed }],
      {
        title: text.confirm.editTitle,
        summary: text.confirm.editSummary(c.displayName, trimmed),
        confirmLabel: text.confirm.confirmButton,
      },
    );
    if (result !== undefined) cancelEdit();
  };

  const handleRemoveClick = (c: Coordinator) =>
    onManage([{ action: "remove", coordinatorId: c.id }], {
      title: text.confirm.removeTitle,
      summary: text.confirm.removeSummary(c.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  const handleLinkClick = (c: Coordinator, kind: "link" | "relink") =>
    onManage(
      [{ action: kind, coordinatorId: c.id, linkedAssignmentName: c.displayName }],
      {
        title: text.confirm.linkTitle,
        summary: text.confirm.linkSummary(c.displayName),
        confirmLabel: text.confirm.confirmButton,
      },
    );

  const handleUnlinkClick = (c: Coordinator) =>
    onManage([{ action: "unlink", coordinatorId: c.id }], {
      title: text.confirm.unlinkTitle,
      summary: text.confirm.unlinkSummary(c.displayName),
      confirmLabel: text.confirm.confirmButton,
    });

  return (
    <div className="space-y-5">
      <Field label={text.nameLabel}>
        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={text.namePlaceholder}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAddClick();
            }}
            className="flex-1"
          />
        </div>
      </Field>
      <Button className="w-full" disabled={busy} onClick={() => void handleAddClick()}>
        ➕ {text.addButton}
      </Button>

      {coordinators.length === 0 ? (
        <EmptyState icon={UserPlus} title={text.empty} hint={text.emptyHint} dense />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
          {coordinators.map((c) => {
            const isEditing = editingId === c.id;
            const showLinkSuggestion =
              c.linkedAssignmentName === null &&
              countVotersWithRawCoordinatorName(contacts, c.displayName) > 0;
            const showRelinkSuggestion =
              c.linkedAssignmentName !== null &&
              c.linkedAssignmentName !== c.displayName &&
              countVotersWithRawCoordinatorName(contacts, c.displayName) > 0;
            const suggestionCount = countVotersWithRawCoordinatorName(
              contacts,
              c.displayName,
            );

            return (
              <li key={c.id} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  {isEditing && allowRename ? (
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="flex-1"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void confirmEditClick(c);
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void confirmEditClick(c)}
                        aria-label={text.saveAriaLabel}
                        className="touch-target grid shrink-0 place-items-center rounded-lg text-primary-600 hover:bg-primary-50"
                      >
                        <Check className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
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
                        {allowRename && (
                          <button
                            type="button"
                            onClick={() => startEdit(c)}
                            aria-label={text.editAriaLabel}
                            className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          >
                            <Pencil className="size-4" />
                          </button>
                        )}
                        {allowRemove && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemoveClick(c)}
                            aria-label={text.removeAriaLabel}
                            className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {showLinkSuggestion && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800">
                    <Link2 className="size-3.5 shrink-0" />
                    <span>{text.linkSuggestion(suggestionCount, c.displayName)}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleLinkClick(c, "link")}
                      className="ms-auto font-semibold underline hover:no-underline"
                    >
                      {text.linkButton}
                    </button>
                  </div>
                )}

                {showRelinkSuggestion && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary-50 px-3 py-2 text-xs text-primary-800">
                    <Link2 className="size-3.5 shrink-0" />
                    <span>{text.linkSuggestion(suggestionCount, c.displayName)}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleLinkClick(c, "relink")}
                      className="ms-auto font-semibold underline hover:no-underline"
                    >
                      {text.relinkButton}
                    </button>
                  </div>
                )}

                {c.linkedAssignmentName !== null && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleUnlinkClick(c)}
                    className="self-start text-xs font-semibold text-slate-500 underline hover:no-underline"
                  >
                    {text.unlinkButton}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
