import { useCallback, useState } from "react";
import { FolderDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/Toast";
import { useAsyncData } from "../../hooks/useAsyncData";
import { BUDGET_TEXT, budgetErrorMessage } from "./budget.constants";
import { BudgetApiError, budgetCall, type BudgetExportStatus } from "./budgetClient";
import { exportFolderSupported, pickExportFolder, runDeletionExport, type DirectoryHandleLike, type ExportProgress } from "./budgetExport";
import { LoadError, SectionCard } from "./budgetUi";

const t = BUDGET_TEXT.exportData;
const when = (iso: string) => new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

/** The Election Owner's deletion export (Stage 7A): its status, and a full
 * checksum-verified export into a local folder. Permanent deletion of a
 * workspace holding Budget data is refused by the database unless the latest
 * verified export is still fresh. */
export function OwnerBudgetExportCard() {
  const fetchStatus = useCallback(() => budgetCall<BudgetExportStatus>("export_status", {}, "owner"), []);
  const { data, error, reload } = useAsyncData(fetchStatus);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const supported = exportFolderSupported();

  const start = async () => {
    let root: DirectoryHandleLike;
    try {
      root = await pickExportFolder();
    } catch {
      return; // the Owner closed the folder picker
    }
    setProgress({ done: 0, total: 0 });
    try {
      await runDeletionExport(root, setProgress);
      toast.success(t.done);
    } catch (e) {
      toast.error(budgetErrorMessage(e instanceof BudgetApiError ? e.code : undefined));
    } finally {
      setProgress(null);
      reload();
    }
  };

  let body;
  if (error && !data) {
    body = error instanceof BudgetApiError && error.code === "MODULE_NOT_ENABLED"
      ? <p className="text-sm text-slate-600">{BUDGET_TEXT.guard.unavailableTitle}</p>
      : <LoadError onRetry={reload} />;
  } else if (!data) {
    body = <Skeleton className="h-24 rounded-xl" />;
  } else {
    const latest = data.latest;
    const statusText = !latest ? t.none
      : latest.state === "open" ? t.incomplete
      : latest.fresh ? t.verifiedFresh(when(latest.verifiedAt ?? latest.createdAt))
      : t.stale;
    const good = Boolean(latest && latest.state === "verified" && latest.fresh);
    body = (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">{t.subtitle}</p>
        <div data-testid="export-status" data-state={good ? "fresh" : latest ? latest.state === "open" ? "open" : "stale" : "none"}
          className={good ? "flex items-start gap-2 rounded-xl bg-supporter-soft p-3 text-sm text-emerald-900"
            : "flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-700"}>
          {good ? <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <div>
            <p className="font-semibold">{statusText}</p>
            {latest && <p className="text-xs">{t.summary(latest.rows, latest.documents.count)}</p>}
          </div>
        </div>
        <p data-testid="export-deletion" data-allowed={data.deletionAllowed ? "true" : "false"} className="text-sm text-slate-700">
          {data.deletionAllowed ? t.deletionAllowed : t.deletionBlocked}
        </p>
        <p className="text-xs text-slate-500">{t.bankMasked}</p>
        {!supported && <p data-testid="export-unsupported" className="text-sm text-amber-800">{t.unsupported}</p>}
        {progress && (
          <p data-testid="export-progress" role="status" aria-live="polite" className="text-sm font-semibold text-primary-700">
            {t.running(progress.done, progress.total)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-testid="budget-export-card">
      <SectionCard
        title={t.title}
        actions={
          <Button data-testid="export-start" onClick={() => void start()} loading={progress !== null}
            disabled={!supported || !data || progress !== null}>
            <FolderDown className="size-4" aria-hidden />{t.start}
          </Button>
        }
      >
        {body}
      </SectionCard>
    </div>
  );
}
