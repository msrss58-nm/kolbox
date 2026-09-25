import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FolderDown, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  exportFolderSupported,
  pickExportFolder,
  runDeletionExport,
  type ExportProgress,
} from "../budget/budgetExport";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import {
  PLATFORM_OWNER_TEXT,
  platformDeleteWorkspaceError,
} from "./platform-owner.constants";
import {
  deleteWorkspace,
  fetchDeletionPreview,
  platformBudgetExportCall,
  type WorkspaceDeletionPreview,
} from "./platformOwnerClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.deleteWorkspace;

/** The fixed server codes and the driver's own `BudgetApiError.code` are read
 * the same way: both arrive as a code, never as prose. */
const codeOf = (err: unknown): string => {
  if (err instanceof Error) {
    const c = (err as Error & { code?: unknown }).code;
    return typeof c === "string" && c ? c : err.message;
  }
  return "SERVER_ERROR";
};

function WarningList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-bold text-slate-500">{title}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm text-slate-600">
            <span aria-hidden="true" className="text-slate-300">
              •
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Permanent deletion of one election system, in two deliberate steps.
 *
 * STEP 1 chooses the system from the real list and asks the SERVER what it
 * holds - how many rows, in which tables, and whether the Budget delete guard
 * would allow the deletion. A system is picked, never typed, so a name that
 * does not exist or a near-miss of one that does is not expressible here at all.
 *
 * Holding data does NOT block deletion. The one thing that can is an unmet
 * safety prerequisite: a system holding Budget data needs a fresh VERIFIED
 * Budget export first. When one is needed this dialog produces it with the SAME
 * driver the Election Owner's own export uses - the same manifest, the same
 * per-part checksums, the same verification - writing every part and every
 * document into a folder the operator picks. Nothing about the guard is
 * bypassed or relaxed; the export is really produced and really delivered.
 *
 * STEP 2 is the final warning, naming the chosen system, listing what is
 * destroyed and what survives. Only there is the destructive button armed.
 */
export function WorkspaceDeleteDialog({
  workspaces,
  initialWorkspaceId,
  onClose,
  onDeleted,
}: {
  /** Every REAL election system. An approval has nothing to delete and is not
   * in this list. */
  workspaces: readonly { workspaceId: string; name: string }[];
  initialWorkspaceId: string;
  onClose: () => void;
  onDeleted: (result: { name: string; authCleanupIncomplete: boolean }) => void;
}) {
  const [selectedId, setSelectedId] = useState(initialWorkspaceId);
  const [step, setStep] = useState<"select" | "confirm">("select");
  const [preview, setPreview] = useState<WorkspaceDeletionPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [exporting, setExporting] = useState<ExportProgress | null>(null);
  const [exported, setExported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = workspaces.find((w) => w.workspaceId === selectedId) ?? null;

  const token = useCallback(async () => {
    const { data } = await platformOwnerAuthClient.auth.getSession();
    const t = data.session?.access_token ?? null;
    if (!t) usePlatformOwnerSession.getState().refreshStatus();
    return t;
  }, []);

  const loadPreview = useCallback(
    async (workspaceId: string) => {
      setLoadingPreview(true);
      setPreviewFailed(false);
      const t = await token();
      if (!t) {
        setLoadingPreview(false);
        return;
      }
      const res = await fetchDeletionPreview(t, workspaceId);
      if (res.status === "unauthorized") {
        setLoadingPreview(false);
        return;
      }
      if (res.status === "error") {
        setPreview(null);
        setPreviewFailed(true);
        setLoadingPreview(false);
        return;
      }
      setPreview(res.data);
      setLoadingPreview(false);
    },
    [token],
  );

  // The inspection is the server's answer about THIS system, so it is re-read
  // whenever the selection changes - never carried over from another one.
  useEffect(() => {
    setPreview(null);
    setExported(false);
    setError(null);
    void loadPreview(selectedId);
  }, [selectedId, loadPreview]);

  const needsExport = preview !== null && preview.hasBudgetData && !preview.deletionAllowed;
  const canContinue = preview !== null && !loadingPreview && !needsExport;

  const runExport = async () => {
    if (!selected || exporting) return;
    setError(null);
    if (!exportFolderSupported()) {
      setError(text.budgetUnsupported);
      return;
    }
    const t = await token();
    if (!t) return;
    let root;
    try {
      root = await pickExportFolder();
    } catch (err) {
      // Cancelling the folder picker is not a failure to report.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(platformDeleteWorkspaceError(codeOf(err)));
      return;
    }
    setExporting({ done: 0, total: 0 });
    try {
      // The Election Owner's own export driver, unchanged, over this console's
      // endpoint. One implementation of what a deletion export is.
      await runDeletionExport(
        root,
        setExporting,
        platformBudgetExportCall(t, selected.workspaceId),
      );
      setExported(true);
      // The server decides whether the guard is satisfied now - not this
      // component, and not the value the export happened to return.
      await loadPreview(selected.workspaceId);
    } catch (err) {
      setError(platformDeleteWorkspaceError(codeOf(err)));
    } finally {
      setExporting(null);
    }
  };

  const submit = async () => {
    if (!selected || busy) return;
    setError(null);
    setBusy(true);
    try {
      const t = await token();
      if (!t) return;
      // The system's OWN name, from the list - the database compares it against
      // the row it is about to delete, so a mixed-up id and name cannot delete
      // the wrong system.
      const res = await deleteWorkspace(t, selected.workspaceId, selected.name);
      if (res.status === "unauthorized") return;
      if (res.status === "error") {
        setError(platformDeleteWorkspaceError(res.code));
        return;
      }
      onDeleted({
        name: res.data.name,
        authCleanupIncomplete: res.data.authCleanupIncomplete,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={selected ? text.title(selected.name) : text.open}
    >
      <div className="space-y-4" data-testid="delete-workspace-form" data-step={step}>
        {step === "select" ? (
          <>
            <Field label={text.selectLabel}>
              <Select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={exporting !== null}
                data-testid="delete-workspace-select"
              >
                {workspaces.length === 0 && <option value="">{text.selectEmpty}</option>}
                {workspaces.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </Field>

            {/* What the SERVER says this system holds. */}
            <section
              className="space-y-2 rounded-lg bg-slate-50 p-3"
              data-testid="delete-workspace-preview"
            >
              <p className="text-xs font-bold text-slate-500">{text.contentsTitle}</p>
              {loadingPreview ? (
                <Skeleton className="h-4 w-40" />
              ) : previewFailed ? (
                <p className="text-sm text-opponent">{text.inspectError}</p>
              ) : preview === null ? (
                <p className="text-sm text-slate-500">{text.inspecting}</p>
              ) : preview.totalRows === 0 ? (
                <p className="text-sm text-slate-600">{text.contentsEmpty}</p>
              ) : (
                <>
                  <p className="text-sm font-bold text-slate-700">
                    {text.contents(preview.totalRows)}
                  </p>
                  <ul className="space-y-0.5">
                    {preview.rowCounts.map((c) => (
                      <li key={c.table} className="text-xs text-slate-500">
                        <bdi>{text.contentsRow(c.table, c.rows)}</bdi>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            {/* Budget data is a prerequisite, never a blocker in itself. */}
            {preview !== null && (
              <section
                className="space-y-2 rounded-lg p-3 ring-1 ring-slate-200"
                data-testid="delete-workspace-budget"
                data-needs-export={needsExport ? "true" : "false"}
              >
                <p className="text-xs font-bold text-slate-500">{text.budgetTitle}</p>
                {!preview.hasBudgetData ? (
                  <p className="text-sm text-slate-600">{text.budgetNone}</p>
                ) : needsExport ? (
                  <>
                    <p className="text-sm text-slate-600">{text.budgetNeedsExport}</p>
                    <Button
                      variant="secondary"
                      className="w-full"
                      onClick={() => void runExport()}
                      disabled={exporting !== null}
                      loading={exporting !== null}
                      data-testid="delete-workspace-export"
                    >
                      <FolderDown className="size-4" aria-hidden="true" />
                      {exporting
                        ? text.budgetExporting(exporting.done, exporting.total)
                        : text.budgetExport}
                    </Button>
                    {!exportFolderSupported() && (
                      <p className="text-xs text-slate-500">{text.budgetUnsupported}</p>
                    )}
                  </>
                ) : (
                  <p className="flex items-center gap-2 text-sm font-semibold text-supporter">
                    <ShieldCheck className="size-4" aria-hidden="true" />
                    {exported ? text.budgetReady : text.budgetAlreadyReady}
                  </p>
                )}
              </section>
            )}

            {error && (
              <p className="text-sm text-opponent" data-testid="delete-workspace-error">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                className="sm:flex-1"
                disabled={!canContinue || exporting !== null}
                onClick={() => setStep("confirm")}
                data-testid="delete-workspace-continue"
              >
                {text.continueLabel}
              </Button>
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={exporting !== null}
              >
                {text.cancel}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex gap-2 rounded-lg bg-opponent-soft p-3 text-opponent">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-bold">{text.warningTitle}</p>
                {selected && (
                  <p className="text-sm font-semibold">
                    <bdi>{text.aboutToDelete(selected.name)}</bdi>
                  </p>
                )}
              </div>
            </div>

            <WarningList title={text.advancedHint} items={text.warningItems} />
            <WarningList title={text.keptTitle} items={text.keptItems} />

            {error && (
              <p className="text-sm text-opponent" data-testid="delete-workspace-error">
                {error}
              </p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                variant="danger"
                className="sm:flex-1"
                disabled={busy || !selected}
                loading={busy}
                onClick={() => void submit()}
                data-testid="delete-workspace-submit"
              >
                {busy ? text.submitting : text.submit}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setStep("select")}
                disabled={busy}
                data-testid="delete-workspace-back"
              >
                {text.back}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
