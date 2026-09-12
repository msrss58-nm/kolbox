import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Modal } from "../../components/ui/Modal";
import { moduleLabel } from "../../constants/labels";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import type { ModuleCatalogEntry, WorkspaceEntitlements } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.workspaceModules;

/**
 * Stage 9: the Platform Owner's one controlled entitlement edit - pick an
 * explicit, non-empty set, then confirm. Shared by the Modules and Workspaces
 * sections (one editor, one hook). The server validates, applies, audits and
 * enforces the result; this dialog only offers the choice. Mount it only while
 * editing, so every open starts from the workspace's current set.
 */
export function WorkspaceModulesEditDialog({
  workspace,
  catalog,
  saving,
  error,
  onSave,
  onClose,
}: {
  workspace: WorkspaceEntitlements;
  catalog: ModuleCatalogEntry[];
  saving: boolean;
  /** The server's refusal for this workspace, if the last save failed. */
  error: string | null;
  /** Resolves true only when the server confirmed the new set. */
  onSave: (modules: string[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Set<string>>(() => new Set(workspace.modules));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const toggle = (key: string) => {
    setDraftError(null);
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const requestSave = () => {
    if (draft.size === 0) {
      setDraftError(text.required);
      return;
    }
    setConfirmOpen(true);
  };

  return (
    <>
      <Modal
        open
        title={PLATFORM_OWNER_TEXT.modulesSection.editTitle(workspace.name)}
        onClose={saving ? () => {} : onClose}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{text.subtitle}</p>
          <div className="grid gap-1.5">
            {catalog.map((m) => (
              <label
                key={m.key}
                className="flex min-h-11 items-center gap-2 rounded-xl px-3 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200"
              >
                <input
                  type="checkbox"
                  checked={draft.has(m.key)}
                  onChange={() => toggle(m.key)}
                  className="size-4 shrink-0 accent-primary-600"
                />
                <span>
                  {moduleLabel(m.key)}
                  {!m.available && (
                    <span className="block text-xs text-slate-400">
                      {text.unavailable}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {(draftError ?? error) && (
            <p role="alert" className="text-sm text-opponent">
              {draftError ?? error}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" loading={saving} onClick={requestSave}>
              {text.save}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              {text.cancel}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        title={text.confirmTitle}
        message={text.confirmMessage(workspace.name)}
        confirmLabel={text.confirm}
        onConfirm={() => {
          setConfirmOpen(false);
          void onSave([...draft]).then((ok) => {
            if (ok) onClose();
          });
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
