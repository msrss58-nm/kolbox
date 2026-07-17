import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { APP_CONFIG } from "../../constants/config";
import { ROUTES } from "../../constants/routes";
import { fmtNum } from "../../lib/utils";
import type { ImportSummary } from "../../services/api";
import { IMPORT_TEXT } from "./import.constants";

export function SummaryStep({
  summary,
  onImportAnother,
}: {
  summary: ImportSummary;
  onImportAnother: () => void;
}) {
  const navigate = useNavigate();
  const tiles = [
    { label: IMPORT_TEXT.summary.added, value: summary.added },
    { label: IMPORT_TEXT.summary.updated, value: summary.updated },
    { label: IMPORT_TEXT.summary.skipped, value: summary.skipped.length },
  ];
  const shownSkipped = summary.skipped.slice(0, APP_CONFIG.importSkippedListLimit);

  return (
    <Card className="mx-auto max-w-lg text-center animate-fade-in-up">
      <span className="mx-auto grid size-16 place-items-center rounded-full bg-supporter-soft">
        <CheckCircle2 className="size-9 text-supporter" />
      </span>
      <h2 className="mt-4 text-xl font-extrabold text-slate-800">
        {IMPORT_TEXT.summary.title}
      </h2>
      <div className="mt-5 grid grid-cols-3 gap-2">
        {tiles.map(({ label, value }) => (
          <div key={label} className="rounded-xl bg-slate-50 p-3">
            <p className="text-2xl font-extrabold tabular-nums text-slate-800">
              {fmtNum(value)}
            </p>
            <p className="text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      {summary.skipped.length > 0 && (
        <details className="mt-4 rounded-xl bg-slate-50 p-3 text-start text-xs text-slate-500">
          <summary className="cursor-pointer font-bold">
            {IMPORT_TEXT.summary.skippedDetails(summary.skipped.length)}
          </summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {shownSkipped.map((s) => (
              <li key={s.row}>{IMPORT_TEXT.summary.skippedRow(s.row, s.reason)}</li>
            ))}
            {summary.skipped.length > shownSkipped.length && (
              <li>{IMPORT_TEXT.summary.skippedMore}</li>
            )}
          </ul>
        </details>
      )}
      <div className="mt-6 flex justify-center gap-2">
        <Button onClick={() => void navigate(ROUTES.voters)}>
          {IMPORT_TEXT.summary.goToVoters}
          <ArrowLeft className="size-4" />
        </Button>
        <Button variant="secondary" onClick={onImportAnother}>
          {IMPORT_TEXT.summary.importAnother}
        </Button>
      </div>
    </Card>
  );
}
