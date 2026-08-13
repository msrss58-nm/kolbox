import { useState } from "react";
import { ChevronLeft, LayoutGrid, X } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { usePermissions } from "../../permissions/usePermissions";
import { CoordinatorAllocationView } from "./CoordinatorAllocationView";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayImportButton } from "./ElectionDayImportButton";
import { useElectionDayShell } from "./ElectionDayShell";

export function ElectionDayFilesPage() {
  const electionDay = useElectionDayShell();
  const { can } = usePermissions();
  const showImport = can("electionDay.import");
  const showClearData = can("electionDay.clearData");
  const showAllocationEntry = can("electionDay.manageCoordinatorAllocation");

  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [allocationOpen, setAllocationOpen] = useState(false);

  if (allocationOpen) {
    return <CoordinatorAllocationView onBack={() => setAllocationOpen(false)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      {showImport &&
        electionDay.lastImportSummary &&
        electionDay.lastImportSummary.rejected.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
            <span className="font-semibold">
              {ELECTION_DAY_TEXT.import.summary.title}:
            </span>
            <span>
              {ELECTION_DAY_TEXT.import.summary.imported(
                electionDay.lastImportSummary.imported.length,
              )}
            </span>
            <span>
              {ELECTION_DAY_TEXT.import.summary.rejected(
                electionDay.lastImportSummary.rejected.length,
              )}
            </span>
            <button
              type="button"
              onClick={electionDay.downloadRejectedRows}
              className="font-semibold text-amber-900 underline hover:no-underline"
            >
              {ELECTION_DAY_TEXT.import.summary.downloadButton}
            </button>
            <button
              type="button"
              onClick={electionDay.dismissImportSummary}
              className="ms-auto text-amber-600 hover:text-amber-900"
              aria-label={ELECTION_DAY_TEXT.import.summary.dismiss}
            >
              <X className="size-4" />
            </button>
          </div>
        )}

      {showImport && (
        <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{ELECTION_DAY_TEXT.import.button}</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              {ELECTION_DAY_TEXT.import.columnsHint}
            </p>
          </div>
          <ElectionDayImportButton
            onFileSelected={(file) => setPendingImportFile(file)}
            busy={electionDay.importing}
          />
        </Card>
      )}

      {showAllocationEntry && (
        <button
          type="button"
          onClick={() => setAllocationOpen(true)}
          className="flex items-center gap-3 rounded-2xl bg-gradient-to-l from-primary-600 to-primary-500 p-5 text-start shadow-sm shadow-primary-600/30 transition hover:brightness-105 sm:flex-row sm:items-center"
        >
          <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/15">
            <LayoutGrid className="size-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-white">
              {ELECTION_DAY_TEXT.coordinatorAllocation.entryButton}
            </p>
            <p className="truncate text-sm text-primary-50">
              {ELECTION_DAY_TEXT.coordinatorAllocation.entryHint}
            </p>
          </div>
          <ChevronLeft className="size-5 shrink-0 text-white/80" />
        </button>
      )}

      {showClearData && (
        <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{ELECTION_DAY_TEXT.clearAll.button}</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              {ELECTION_DAY_TEXT.clearAll.confirmMessage}
            </p>
          </div>
          <Button
            variant="danger"
            disabled={!electionDay.total}
            onClick={() => setConfirmClearOpen(true)}
          >
            🗑️ {ELECTION_DAY_TEXT.clearAll.button}
          </Button>
        </Card>
      )}

      <ConfirmDialog
        open={confirmClearOpen}
        title={ELECTION_DAY_TEXT.clearAll.confirmTitle}
        message={ELECTION_DAY_TEXT.clearAll.confirmMessage}
        confirmLabel={ELECTION_DAY_TEXT.clearAll.confirmButton}
        danger
        busy={electionDay.clearing}
        onConfirm={async () => {
          // A blocked (no permission) or failed clear resolves to
          // `undefined` - the dialog must stay open, not close as if the
          // data had actually been wiped.
          const result = await electionDay.clearElectionDayData();
          if (result !== undefined) setConfirmClearOpen(false);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />

      <ConfirmDialog
        open={pendingImportFile !== null}
        title={ELECTION_DAY_TEXT.import.confirmTitle}
        message={ELECTION_DAY_TEXT.import.confirmMessage}
        confirmLabel={ELECTION_DAY_TEXT.import.confirmButton}
        danger
        busy={electionDay.importing}
        onConfirm={async () => {
          if (!pendingImportFile) return;
          // Same as clear-data above: a blocked or failed import resolves
          // to `undefined` - keep the dialog open rather than close it as
          // if the file had actually been loaded.
          const result = await electionDay.importFile(pendingImportFile);
          if (result !== undefined) setPendingImportFile(null);
        }}
        onCancel={() => setPendingImportFile(null)}
      />
    </div>
  );
}
