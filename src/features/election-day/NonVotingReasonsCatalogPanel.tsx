import { useState } from "react";
import { ArrowDown, ArrowUp, ListX } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/utils";
import type { NewNonVotingReason } from "../../services/api";
import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { NonVotingReasonsHook } from "./useNonVotingReasons";

const text = ELECTION_DAY_TEXT.nonVotingReasonsManager;

interface ReasonFormState {
  name: string;
  description: string;
  requiresFollowUp: boolean;
}

function emptyForm(): ReasonFormState {
  // Defaults to `true` (matches the DB default) - the fail-safe direction:
  // a brand-new reason should be treated as still needing follow-up until
  // an admin deliberately marks it closed.
  return { name: "", description: "", requiresFollowUp: true };
}

function formFromReason(reason: NonVotingReason): ReasonFormState {
  return {
    name: reason.name,
    description: reason.description,
    requiresFollowUp: reason.requiresFollowUp,
  };
}

/**
 * Election Day Shell migration: the catalog-management half of the old
 * `NonVotingReasonsModal` (see `ElectionDayReasonsPage.tsx`'s "catalog" tab),
 * un-modal-ified - same state/handlers/JSX that used to live inside that
 * modal's body, just rendered directly instead of wrapped in `<Modal>`. Zero
 * logic change.
 */
export function NonVotingReasonsCatalogPanel({
  contacts,
  reasonsManagement,
}: {
  contacts: ElectionDayVoter[];
  reasonsManagement: NonVotingReasonsHook;
}) {
  const {
    reasons,
    createReason,
    updateReason,
    setReasonActive,
    deleteReason,
    moveReason,
    creating,
    updating,
    deleting,
  } = reasonsManagement;

  // `null` = list view, "new" = creating, a NonVotingReason = editing that reason.
  const [editing, setEditing] = useState<NonVotingReason | "new" | null>(null);
  const [form, setForm] = useState<ReasonFormState>(emptyForm());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const usageCount = (reasonId: string) =>
    contacts.filter((c) => c.notVotingReasonId === reasonId).length;

  const openCreate = () => {
    setForm(emptyForm());
    setEditing("new");
  };
  const openEdit = (reason: NonVotingReason) => {
    setForm(formFromReason(reason));
    setEditing(reason);
  };
  const closeEditor = () => setEditing(null);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error(text.toast.invalid);
      return;
    }
    const input: NewNonVotingReason = {
      name: form.name.trim(),
      description: form.description.trim(),
      requiresFollowUp: form.requiresFollowUp,
    };
    const result =
      editing !== "new" && editing !== null
        ? await updateReason({ ...input, id: editing.id })
        : await createReason(input);
    if (result !== undefined) closeEditor();
  };

  const busy = creating || updating;

  return (
    <>
      {editing === null ? (
        <div className="space-y-4">
          <Button className="w-full" onClick={openCreate}>
            ➕ {text.newButton}
          </Button>

          {reasons.length === 0 ? (
            <EmptyState icon={ListX} title={text.empty} />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {reasons.map((reason, index) => {
                const count = usageCount(reason.id);
                return (
                  <li
                    key={reason.id}
                    className="flex items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "truncate text-sm font-bold",
                          reason.isActive ? "text-slate-800" : "text-slate-400",
                        )}
                      >
                        {reason.name}
                        {!reason.isActive && (
                          <span className="ms-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-500">
                            {text.inactiveBadge}
                          </span>
                        )}
                        {!reason.requiresFollowUp && (
                          <span className="ms-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-500">
                            {text.closedBadge}
                          </span>
                        )}
                      </p>
                      {reason.description && (
                        <p className="truncate text-xs text-slate-500">
                          {reason.description}
                        </p>
                      )}
                      <p className="text-xs text-slate-400">{text.usageCount(count)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => moveReason(reason, "up")}
                        aria-label={text.moveUpAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        <ArrowUp className="size-4" />
                      </button>
                      <button
                        type="button"
                        disabled={index === reasons.length - 1}
                        onClick={() => moveReason(reason, "down")}
                        aria-label={text.moveDownAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        <ArrowDown className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void setReasonActive(reason.id, !reason.isActive)}
                        aria-label={
                          reason.isActive
                            ? text.deactivateAriaLabel
                            : text.activateAriaLabel
                        }
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        {reason.isActive ? "🙈" : "👁️"}
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(reason)}
                        aria-label={text.editAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        disabled={count > 0}
                        onClick={() => setPendingDeleteId(reason.id)}
                        aria-label={text.deleteAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        🗑️
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label={text.nameLabel}>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={text.namePlaceholder}
            />
          </Field>
          <Field label={text.descriptionLabel}>
            <Input
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder={text.descriptionPlaceholder}
            />
          </Field>
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={form.requiresFollowUp}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, requiresFollowUp: e.target.checked }))
              }
              className="size-4 accent-primary-600"
            />
            {text.requiresFollowUpLabel}
          </label>

          <div className="flex gap-2">
            <Button className="flex-1" loading={busy} onClick={() => void handleSave()}>
              {text.saveButton}
            </Button>
            <Button variant="secondary" onClick={closeEditor}>
              {text.cancelButton}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={text.confirmDeleteTitle}
        message={text.confirmDeleteMessage}
        confirmLabel={text.confirmDeleteButton}
        danger
        busy={deleting}
        onConfirm={async () => {
          if (!pendingDeleteId) return;
          const result = await deleteReason(pendingDeleteId);
          if (result !== undefined) setPendingDeleteId(null);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
    </>
  );
}
