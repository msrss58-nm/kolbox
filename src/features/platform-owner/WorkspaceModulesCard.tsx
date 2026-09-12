import { Blocks } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import type { WorkspaceEntitlements } from "./platformOwnerClient";
import type { useWorkspaceModules } from "./useWorkspaceModules";

const text = PLATFORM_OWNER_TEXT.workspaceModules;

/**
 * Stage 9: every workspace with its module entitlements, and the one
 * controlled edit the Platform Owner has: pick an explicit, non-empty set,
 * then confirm. The server validates and enforces the result (Election Day is
 * re-checked on every worker request); this card only offers the choice and
 * refetches after every attempt.
 *
 * Success is reported INLINE on the saved row, like every other result on
 * this console: the Platform console is not mounted under `AppShell`, so it
 * has no toast container and a toast would never be seen.
 */
export function WorkspaceModulesCard({
  modules,
}: {
  modules: ReturnType<typeof useWorkspaceModules>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(() => new Set());
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkspaceEntitlements | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const startEdit = (w: WorkspaceEntitlements) => {
    setSavedId(null);
    setEditingId(w.workspaceId);
    setDraft(new Set(w.modules));
    setDraftError(null);
  };

  const toggle = (key: string) => {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const requestSave = (w: WorkspaceEntitlements) => {
    if (draft.size === 0) {
      setDraftError(text.required);
      return;
    }
    setConfirm(w);
  };

  return (
    <>
      <Card className="space-y-4" data-testid="workspace-modules-card">
        <div className="flex items-center gap-2">
          <Blocks className="size-5 text-slate-700" />
          <CardTitle>{text.title}</CardTitle>
        </div>
        <p className="text-sm text-slate-600">{text.subtitle}</p>

        {modules.readError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm font-medium text-opponent">
              {modules.readError}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void modules.reload()}>
              {text.retry}
            </Button>
          </div>
        )}

        {!modules.readError && modules.loading && modules.workspaces.length === 0 && (
          <Skeleton className="h-16 w-full" />
        )}

        {!modules.readError && !modules.loading && modules.workspaces.length === 0 && (
          <EmptyState dense icon={Blocks} title={text.empty} />
        )}

        {!modules.readError && modules.workspaces.length > 0 && (
          <ul className="space-y-2" data-testid="workspace-modules-list">
            {modules.workspaces.map((w) => {
              const editing = editingId === w.workspaceId;
              const error = modules.errorFor(w.workspaceId);
              return (
                <li
                  key={w.workspaceId}
                  className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="font-bold break-words text-slate-800">{w.name}</p>
                      {w.ownerName && (
                        <p className="text-xs text-slate-500">
                          {text.owner(w.ownerName)}
                        </p>
                      )}
                      {!editing && (
                        <p className="text-sm text-slate-700">
                          {w.modules.length > 0
                            ? w.modules.map(moduleLabel).join(" · ")
                            : text.none}
                        </p>
                      )}
                    </div>
                    {!editing && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={modules.savingId !== null}
                        onClick={() => startEdit(w)}
                        className="w-full shrink-0 sm:w-auto"
                      >
                        {text.edit}
                      </Button>
                    )}
                  </div>

                  {editing && (
                    <div className="space-y-2">
                      <div className="grid gap-1.5 sm:grid-cols-3">
                        {modules.catalog.map((m) => (
                          <label
                            key={m.key}
                            className="flex min-h-11 items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-slate-700 ring-1 ring-slate-200"
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
                      {draftError && (
                        <p role="alert" className="text-sm text-opponent">
                          {draftError}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          loading={modules.savingId === w.workspaceId}
                          onClick={() => requestSave(w)}
                        >
                          {text.save}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingId(null)}
                        >
                          {text.cancel}
                        </Button>
                      </div>
                    </div>
                  )}

                  {error && (
                    <p role="alert" className="text-sm font-medium text-opponent">
                      {error}
                    </p>
                  )}
                  {!editing && savedId === w.workspaceId && (
                    <p role="status" className="text-sm font-medium text-emerald-700">
                      {text.saved}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={text.confirmTitle}
        message={confirm ? text.confirmMessage(confirm.name) : ""}
        confirmLabel={text.confirm}
        onConfirm={() => {
          const w = confirm;
          setConfirm(null);
          if (!w) return;
          void modules.save(w.workspaceId, [...draft]).then((ok) => {
            if (ok) {
              setEditingId(null);
              setSavedId(w.workspaceId);
            }
          });
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
