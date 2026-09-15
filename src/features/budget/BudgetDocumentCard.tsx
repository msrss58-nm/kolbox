import { useState } from "react";
import { Archive, ChevronDown, ChevronUp, Download, RotateCcw, Upload } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import type { BudgetDocument } from "./budgetClient";
import { formatBytes } from "./budgetFiles";

const t = BUDGET_TEXT.documents;

const when = (iso: string) => new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

/**
 * One document (shared by the expense file and the supplier file): its
 * current version, every earlier version (never overwritten - each stays
 * downloadable), and the allowed actions. `managed` = owned by the order-form
 * workflow (no manual replace / archive).
 */
export function BudgetDocumentCard({ doc, canChange, managed = false, busy, onDownload, onReplace, onArchive, onRestore }: {
  doc: BudgetDocument;
  canChange: boolean;
  managed?: boolean;
  busy: boolean;
  onDownload: (versionId: string) => void;
  onReplace?: () => void;
  onArchive?: () => void;
  onRestore?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [current, ...older] = doc.versions;
  const archived = doc.status === "archived";
  const expired = doc.validUntil !== null && doc.validUntil < new Date().toISOString().slice(0, 10);
  return (
    <div className={cn("space-y-2 rounded-xl p-3 ring-1 ring-slate-200", archived && "bg-slate-50 opacity-70")} data-testid="document-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800">
            {doc.typeName}
            {doc.title && <span className="font-normal text-slate-600"> · {doc.title}</span>}
          </p>
          <p className="text-xs text-slate-500">
            {current ? (
              <>
                {t.version(current.versionNo)} · <span dir="auto">{current.fileName}</span> · {formatBytes(current.sizeBytes)} ·{" "}
                {t.by(current.createdByName, when(current.createdAt))}
              </>
            ) : t.none}
          </p>
          {doc.validUntil && (
            <p className={cn("text-xs", expired ? "font-semibold text-rose-700" : "text-slate-500")}>
              {t.validUntilShort}: {doc.validUntil}{expired && ` · ${t.expired}`}
            </p>
          )}
          {doc.notes && <p className="text-xs text-slate-500">{doc.notes}</p>}
          {archived && <p className="text-xs font-semibold text-slate-600">{t.archived}{doc.archiveReason ? ` · ${doc.archiveReason}` : ""}</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {current && (
            <Button size="sm" variant="ghost" onClick={() => onDownload(current.id)} disabled={busy}>
              <Download className="size-4" />{t.download}
            </Button>
          )}
          {canChange && !managed && !archived && onReplace && (
            <Button size="sm" variant="secondary" onClick={onReplace} disabled={busy}><Upload className="size-4" />{t.replace}</Button>
          )}
          {canChange && !managed && !archived && onArchive && (
            <Button size="sm" variant="ghost" onClick={onArchive} disabled={busy}><Archive className="size-4" />{t.archive}</Button>
          )}
          {canChange && !managed && archived && onRestore && (
            <Button size="sm" variant="ghost" onClick={onRestore} disabled={busy}><RotateCcw className="size-4" />{t.restore}</Button>
          )}
        </div>
      </div>
      {older.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAll((v) => !v)}
            className="inline-flex min-h-11 items-center gap-1 text-xs font-semibold text-primary-700">
            {showAll ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            {showAll ? t.hideVersions : `${t.showVersions} (${older.length})`}
          </button>
          {showAll && (
            <ul className="divide-y divide-slate-100 text-xs" data-testid="document-versions">
              {older.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="text-slate-600">
                    {t.version(v.versionNo)} · <span dir="auto">{v.fileName}</span> · {formatBytes(v.sizeBytes)} · {t.by(v.createdByName, when(v.createdAt))}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => onDownload(v.id)} disabled={busy}>
                    <Download className="size-4" />{t.download}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
