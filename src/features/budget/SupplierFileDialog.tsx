import { useCallback, useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, CircleAlert, Download, Plus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { BUDGET_ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type BudgetDocument, type Supplier, type SupplierFile } from "./budgetClient";
import { downloadBudgetDocument, uploadBudgetFile } from "./budgetFiles";
import { ExpenseStatusBadge, LoadError, Money, useBudgetAction } from "./budgetUi";
import { BudgetDocumentCard } from "./BudgetDocumentCard";
import { DocumentUploadDialog, type UploadFields } from "./DocumentUploadDialog";
import { ReasonDialog } from "./BudgetExpensePage";

const t = BUDGET_TEXT.supplierFile;
const d = BUDGET_TEXT.documents;
const c = BUDGET_TEXT.common;

type Dialog = { kind: "upload" } | { kind: "replace"; doc: BudgetDocument } | { kind: "archive"; doc: BudgetDocument } | null;

/**
 * The supplier file: the supplier's own documents (e.g. a bank-account
 * confirmation with a validity date, which then serves every party expense
 * of this supplier), its expenses with their document readiness, and the
 * documents filed on those expenses. Bank details stay masked here - the
 * step-up reveal lives on the supplier card.
 */
export function SupplierFileDialog({ supplier, canManage, onClose }: { supplier: Supplier; canManage: boolean; onClose: () => void }) {
  const fetchFile = useCallback(() => budgetCall<SupplierFile>("get_supplier_file", { supplierId: supplier.id }), [supplier.id]);
  const file = useAsyncData(fetchFile);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, busy } = useBudgetAction();
  const after = (r: unknown) => {
    if (r !== undefined) {
      setDialog(null);
      file.reload();
    }
  };
  const download = (versionId: string) => void run(() => downloadBudgetDocument(versionId));
  const upload = (f: File, fields: UploadFields, documentId?: string) =>
    void run(() => uploadBudgetFile(
      documentId
        ? { purpose: "supplier", supplierId: supplier.id, documentId, ...(fields.notes ? { notes: fields.notes } : {}), ...(fields.validUntil ? { validUntil: fields.validUntil } : {}) }
        : { purpose: "supplier", supplierId: supplier.id, ...fields },
      f), d.uploaded).then(after);

  return (
    <Modal open onClose={onClose} title={`${t.open} - ${supplier.businessName}`} wide>
      {!file.data ? (
        file.error ? <LoadError onRetry={file.reload} /> : <Skeleton className="h-40 rounded-2xl" />
      ) : (
        <div className="space-y-5" data-testid="supplier-file">
          <section>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">{t.documents}</h3>
              {canManage && (
                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "upload" })} data-testid="supplier-upload">
                  <Plus className="size-4" />{t.upload}
                </Button>
              )}
            </div>
            <p className="mb-2 text-xs text-slate-500">{t.documentsHint}</p>
            {file.data.documents.length === 0 ? (
              <p className="text-sm text-slate-500">{d.none}</p>
            ) : (
              <div className="space-y-2" data-testid="supplier-documents">
                {file.data.documents.map((doc) => (
                  <BudgetDocumentCard key={doc.id} doc={doc} canChange={canManage} busy={busy} onDownload={download}
                    onReplace={() => setDialog({ kind: "replace", doc })}
                    onArchive={() => setDialog({ kind: "archive", doc })}
                    onRestore={() => void run(() => budgetCall("restore_document", { documentId: doc.id, expectedVersion: doc.version }), c.saved).then(after)} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-bold text-slate-800">{t.expenses}</h3>
            {file.data.expenses.length === 0 ? (
              <p className="text-sm text-slate-500">{t.noExpenses}</p>
            ) : (
              <ul className="space-y-2" data-testid="supplier-expenses">
                {file.data.expenses.map((e) => (
                  <li key={e.id} className="space-y-1 rounded-xl p-3 ring-1 ring-slate-200">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link to={`${BUDGET_ROUTES.expenses}/${e.id}`} onClick={onClose}
                        className="min-w-0 font-semibold text-primary-700 hover:underline">
                        #{e.referenceNo} · {e.description}
                      </Link>
                      <span className="flex items-center gap-2">
                        <ExpenseStatusBadge status={e.status} />
                        <Money value={e.total} className="text-sm font-bold" />
                      </span>
                    </div>
                    <p className={e.documentsReady ? "flex items-center gap-1 text-xs font-semibold text-emerald-700" : "flex items-center gap-1 text-xs font-semibold text-amber-800"}>
                      {e.documentsReady ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                      {e.documentsReady ? t.ready : t.missing(e.missing.length)}
                    </p>
                    {e.documents.length > 0 && (
                      <ul className="text-xs text-slate-600">
                        {e.documents.map((doc) => (
                          <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2">
                            <span>
                              {doc.typeName}
                              {doc.currentVersion && <> · {d.version(doc.currentVersion.versionNo)} · <span dir="auto">{doc.currentVersion.fileName}</span></>}
                              {doc.status === "archived" && ` · ${d.archived}`}
                            </span>
                            {doc.currentVersion && (
                              <Button size="sm" variant="ghost" disabled={busy} onClick={() => download(doc.currentVersion!.id)}>
                                <Download className="size-4" />{d.download}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {dialog?.kind === "upload" && file.data && (
        <DocumentUploadDialog title={t.upload} types={file.data.documentTypes.map((x) => ({ id: x.id, name: x.name }))}
          defaultTypeId={file.data.documentTypes.find((x) => x.key === "bank_confirmation")?.id} showValidUntil busy={busy}
          onClose={() => setDialog(null)} onSubmit={(f, fields) => upload(f, fields)} />
      )}
      {dialog?.kind === "replace" && (
        <DocumentUploadDialog title={`${d.replaceTitle} - ${dialog.doc.typeName}`} hint={d.replaceHint} showTitle={false} showValidUntil busy={busy}
          onClose={() => setDialog(null)} onSubmit={(f, fields) => upload(f, fields, dialog.doc.id)} />
      )}
      {dialog?.kind === "archive" && (
        <ReasonDialog title={d.archive} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(reason) => void run(() => budgetCall("archive_document",
            { documentId: dialog.doc.id, expectedVersion: dialog.doc.version, reason }), d.archivedToast).then(after)} />
      )}
    </Modal>
  );
}
