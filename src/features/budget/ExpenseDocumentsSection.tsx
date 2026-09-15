import { useState } from "react";
import { CheckCircle2, CircleAlert, Plus, Upload } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type BudgetDocument, type ExpenseDocuments, type RequirementItem } from "./budgetClient";
import { downloadBudgetDocument, uploadBudgetFile } from "./budgetFiles";
import { formatAgorot } from "./budgetMoney";
import { SectionCard, useBudgetAction } from "./budgetUi";
import { BudgetDocumentCard } from "./BudgetDocumentCard";
import { DocumentUploadDialog, type UploadFields } from "./DocumentUploadDialog";
import { ReasonDialog } from "./BudgetExpensePage";

const t = BUDGET_TEXT.documents;
const c = BUDGET_TEXT.common;

const WORKFLOW_KEYS = new Set(["order_form", "order_form_signed"]);

type Dialog =
  | { kind: "upload"; typeId?: string }
  | { kind: "replace"; doc: BudgetDocument }
  | { kind: "archive"; doc: BudgetDocument }
  | null;

/** Why a type is (not) required - from the server's rule evaluation only. */
function reasonText(item: RequirementItem): string {
  const money = (n: number | null) => formatAgorot(n);
  const matched = item.rules.filter((r) => r.matched);
  const list = matched.length ? matched : item.rules;
  return list
    .map((r) => {
      if (r.condition === "always") return t.always;
      if (r.condition === "amount_gt") return r.matched ? t.above(money(r.threshold)) : t.notAbove(money(r.threshold));
      if (r.condition === "amount_gte") return r.matched ? t.atLeast(money(r.threshold)) : t.notAtLeast(money(r.threshold));
      if (r.condition === "category") return r.matched ? t.inCategory : t.notInCategory;
      return r.matched ? t.manualOn : t.manualOff;
    })
    .join(" · ");
}

/**
 * The expense's documents: the requirement checklist (the server's ONE
 * engine - no rule logic here), every document with its version history,
 * upload / new version / archive, and the per-expense requirement toggles.
 */
export function ExpenseDocumentsSection({ data, open, canUpload, canFlag, onChange }: {
  data: ExpenseDocuments;
  open: boolean;
  canUpload: boolean;
  canFlag: boolean;
  onChange: (next: ExpenseDocuments | undefined) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, busy } = useBudgetAction();
  const req = data.requirements;
  const editable = open && canUpload;
  const done = (r: ExpenseDocuments | undefined) => {
    if (r) {
      setDialog(null);
      onChange(r);
    }
  };
  const download = (versionId: string) => void run(() => downloadBudgetDocument(versionId));
  const upload = (file: File, fields: UploadFields, documentId?: string) =>
    void run(() => uploadBudgetFile<ExpenseDocuments>(
      documentId
        ? { purpose: "expense", expenseId: data.expenseId, documentId, ...(fields.title ? { title: fields.title } : {}), ...(fields.notes ? { notes: fields.notes } : {}) }
        : { purpose: "expense", expenseId: data.expenseId, ...fields },
      file), t.uploaded).then(done);

  return (
    <SectionCard title={t.title} actions={editable ? (
      <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "upload" })} data-testid="upload-document">
        <Plus className="size-4" />{t.upload}
      </Button>) : undefined}>
      <div className="space-y-4">
        {req.mode === "snapshot" && (
          <p role="status" className="rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-700" data-testid="requirements-snapshot">{t.snapshotNote}</p>
        )}
        {req.items.some((i) => i.required) ? (
          <p role="status" data-testid="documents-readiness"
            className={cn("flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold",
              req.ready ? "bg-supporter-soft text-emerald-800" : "bg-potential-soft text-amber-900")}>
            {req.ready ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}
            {req.ready ? t.ready : t.notReady}
          </p>
        ) : (
          <p className="text-sm text-slate-500">{t.noRequirements}</p>
        )}

        {req.items.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-bold text-slate-700">{t.checklist}</h3>
            <ul className="divide-y divide-slate-100" data-testid="document-checklist">
              {req.items.map((item) => {
                const managed = WORKFLOW_KEYS.has(item.key);
                const own = item.satisfiedBy?.source === "expense" ? data.documents.find((d) => d.id === item.satisfiedBy?.documentId) : undefined;
                return (
                  <li key={item.documentTypeId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`requirement-${item.key}`}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                        {item.name}
                        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold",
                          item.required ? "bg-primary-50 text-primary-700" : "bg-slate-100 text-slate-600")}>
                          {item.required ? t.required : item.rules.length ? t.notRequired : t.optional}
                        </span>
                        {item.satisfied ? (
                          <span className="text-xs font-semibold text-emerald-700" data-state="present">
                            {t.present} · {t.version(item.satisfiedBy?.versionNo ?? 1)}
                            {item.satisfiedBy?.source === "supplier" && ` · ${t.fromSupplier}`}
                            {item.satisfiedBy?.source === "order_form_return" && ` · ${t.fromReturn}`}
                          </span>
                        ) : item.required ? (
                          <span className="text-xs font-semibold text-rose-700" data-state="missing">{t.missing}</span>
                        ) : null}
                      </p>
                      {item.rules.length > 0 && <p className="text-xs text-slate-500">{reasonText(item)}</p>}
                      {managed && <p className="text-xs text-slate-500">{t.managed}</p>}
                    </div>
                    <div className="flex gap-1.5">
                      {item.satisfiedBy && (
                        <Button size="sm" variant="ghost" onClick={() => download(item.satisfiedBy!.versionId)} disabled={busy}>{t.download}</Button>
                      )}
                      {editable && !managed && (
                        own ? (
                          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "replace", doc: own })} disabled={busy}>
                            <Upload className="size-4" />{t.replace}
                          </Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "upload", typeId: item.documentTypeId })} disabled={busy}>
                            <Upload className="size-4" />{t.uploadFor}
                          </Button>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {data.manualTypes.length > 0 && (
          <div className="flex flex-wrap gap-4">
            {data.manualTypes.map((m) => (
              <label key={m.documentTypeId} className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-700">
                <input type="checkbox" className="size-4 accent-primary-600" checked={data.flags.includes(m.documentTypeId)}
                  disabled={!open || !canFlag || busy}
                  onChange={(e) => void run(() => budgetCall<ExpenseDocuments>("set_expense_document_flag",
                    { expenseId: data.expenseId, documentTypeId: m.documentTypeId, required: e.target.checked }), c.saved).then(done)} />
                {t.flag(m.name)}
              </label>
            ))}
          </div>
        )}

        <div>
          <h3 className="mb-2 text-sm font-bold text-slate-700">{t.all}</h3>
          {data.documents.length === 0 ? (
            <p className="text-sm text-slate-500">{t.none}</p>
          ) : (
            <div className="space-y-2" data-testid="expense-documents">
              {data.documents.map((doc) => (
                <BudgetDocumentCard key={doc.id} doc={doc} canChange={editable} managed={WORKFLOW_KEYS.has(doc.typeKey)} busy={busy}
                  onDownload={download}
                  onReplace={() => setDialog({ kind: "replace", doc })}
                  onArchive={() => setDialog({ kind: "archive", doc })}
                  onRestore={() => void run(() => budgetCall<ExpenseDocuments>("restore_document",
                    { documentId: doc.id, expectedVersion: doc.version }), c.saved).then(done)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {dialog?.kind === "upload" && (
        <DocumentUploadDialog title={t.uploadTitle} types={dataTypes(data)} defaultTypeId={dialog.typeId} busy={busy}
          onClose={() => setDialog(null)} onSubmit={(file, fields) => upload(file, fields)} />
      )}
      {dialog?.kind === "replace" && (
        <DocumentUploadDialog title={`${t.replaceTitle} - ${dialog.doc.typeName}`} hint={t.replaceHint} busy={busy}
          onClose={() => setDialog(null)} onSubmit={(file, fields) => upload(file, fields, dialog.doc.id)} />
      )}
      {dialog?.kind === "archive" && (
        <ReasonDialog title={t.archive} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(reason) => void run(() => budgetCall<ExpenseDocuments>("archive_document",
            { documentId: dialog.doc.id, expectedVersion: dialog.doc.version, reason }), t.archivedToast).then(done)} />
      )}
    </SectionCard>
  );
}

function dataTypes(data: ExpenseDocuments): { id: string; name: string }[] {
  return data.documentTypes.map((x) => ({ id: x.id, name: x.name }));
}
