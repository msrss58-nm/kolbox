import { useState } from "react";
import { Download, Eye, FilePlus2, RefreshCcw, Send, Share2, Upload } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type Expense, type ExpenseDocuments, type OrderFormVersion } from "./budgetClient";
import { downloadBudgetDocument, downloadOrderFormPreview, fetchBudgetDocumentFile, uploadBudgetFile } from "./budgetFiles";
import { SectionCard, useBudgetAction } from "./budgetUi";
import { DocumentUploadDialog } from "./DocumentUploadDialog";

const t = BUDGET_TEXT.orderForm;
const d = BUDGET_TEXT.documents;

type Dialog = { kind: "send"; version: OrderFormVersion } | { kind: "return"; version: OrderFormVersion } | { kind: "regenerate" } | null;

const when = (iso: string) => new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

/** wa.me link with the prepared text; an Israeli 0-prefixed number -> 972. */
function whatsappLink(phone: string | null, text: string): string {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `972${digits.slice(1)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * The party order form's DOCUMENT lifecycle: draft preview -> (after the prior
 * budget approval) final PDF version N -> the user confirms it was sent ->
 * the supplier-signed return is uploaded and linked to version N. A
 * regeneration is version N+1; N is kept. The approval decision itself is the
 * party workflow (the section above), not this one.
 */
export function ExpenseOrderFormSection({ expense, data, supplierPhone, canManage, onChange }: {
  expense: Expense;
  data: ExpenseDocuments;
  supplierPhone: string | null;
  canManage: boolean;
  onChange: (next: ExpenseDocuments | undefined) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, busy } = useBudgetAction();
  const of = data.orderForm;
  const latest = of.versions[0];
  const done = (r: ExpenseDocuments | undefined) => {
    if (r) {
      setDialog(null);
      onChange(r);
    }
  };
  const generate = () => void run(() => budgetCall<ExpenseDocuments>("order_form_generate", { expenseId: expense.id }), t.generated).then(done);
  const download = (versionId: string) => void run(() => downloadBudgetDocument(versionId));

  return (
    <SectionCard title={t.title}>
      <div className="space-y-3" data-testid="order-form">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="order-form-state" data-state={of.state}
            className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
              of.state === "returned" ? "bg-supporter-soft text-emerald-800" : "bg-primary-50 text-primary-700")}>
            {t.states[of.state]}
          </span>
          {of.state !== "not_applicable" && (
            <span className="text-xs text-slate-600" data-testid="order-form-signature">
              {data.requirements.supplierSignatureRequired ? t.signatureRequired : t.signatureNotRequired}
            </span>
          )}
        </div>
        {of.generateBlockers.filter((b) => b !== "ORDER_FORM_NOT_APPLICABLE").map((b) => (
          <p key={b} className="text-xs font-semibold text-amber-800">{t.blockers[b] ?? b}</p>
        ))}
        {canManage && (of.canPreview || of.canGenerate) && (
          <div className="flex flex-wrap gap-2">
            {of.canPreview && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => downloadOrderFormPreview(expense.id))}>
                <Eye className="size-4" />{t.preview}
              </Button>
            )}
            {of.canGenerate && (latest ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog({ kind: "regenerate" })}>
                <RefreshCcw className="size-4" />{t.regenerate}
              </Button>
            ) : (
              <Button size="sm" loading={busy} onClick={generate} data-testid="order-form-generate">
                <FilePlus2 className="size-4" />{t.generate}
              </Button>
            ))}
          </div>
        )}

        {of.versions.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-bold text-slate-700">{t.versions}</h3>
            <ul className="space-y-2" data-testid="order-form-versions">
              {of.versions.map((v, i) => (
                <li key={v.id} className={cn("space-y-1 rounded-xl p-3 ring-1 ring-slate-200", i > 0 && "bg-slate-50")} data-testid="order-form-version">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">
                      {d.version(v.versionNo)}
                      <span className="ms-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {i === 0 ? t.latest : t.superseded}
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => download(v.documentVersionId)}>
                        <Download className="size-4" />{d.download}
                      </Button>
                      {canManage && i === 0 && !v.sentAt && (
                        <Button size="sm" disabled={busy} onClick={() => setDialog({ kind: "send", version: v })}>
                          <Send className="size-4" />{t.send}
                        </Button>
                      )}
                      {canManage && (
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog({ kind: "return", version: v })}>
                          <Upload className="size-4" />{t.uploadReturn}
                        </Button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">{d.by(v.createdByName, when(v.createdAt))}</p>
                  {v.sentAt && <p className="text-xs text-slate-600" data-testid="order-form-sent">{t.sentBy(v.sentByName ?? "", when(v.sentAt))}</p>}
                  {v.returns.length > 0 && (
                    <ul className="text-xs" data-testid="order-form-returns">
                      {v.returns.map((r) => (
                        <li key={r.versionId} className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-emerald-800">
                            {t.returns}: <span dir="auto">{r.fileName}</span> · {d.by(r.createdByName, when(r.createdAt))}
                          </span>
                          <Button size="sm" variant="ghost" disabled={busy} onClick={() => download(r.versionId)}>
                            <Download className="size-4" />{d.download}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {dialog?.kind === "regenerate" && (
        <Modal open onClose={() => setDialog(null)} title={t.regenerateTitle}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600">{t.regenerateHint}</p>
            <Button className="w-full" loading={busy} onClick={generate}>{t.regenerate}</Button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "send" && (
        <SendDialog expense={expense} version={dialog.version} supplierPhone={supplierPhone} busy={busy} onClose={() => setDialog(null)}
          onConfirm={(note) => void run(() => budgetCall<ExpenseDocuments>("order_form_mark_sent",
            { orderFormVersionId: dialog.version.id, ...(note ? { note } : {}) }), BUDGET_TEXT.common.saved).then(done)} />
      )}
      {dialog?.kind === "return" && (
        <DocumentUploadDialog title={t.returnTitle} hint={t.returnHint(dialog.version.versionNo)} showTitle={false} busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(file, fields) => void run(() => uploadBudgetFile<ExpenseDocuments>(
            { purpose: "order_form_return", orderFormVersionId: dialog.version.id, ...(fields.notes ? { notes: fields.notes } : {}) },
            file), d.uploaded).then(done)} />
      )}
    </SectionCard>
  );
}

/** Sending is done by the user in WhatsApp: phones share the file itself
 * (Web Share API with files); desktop downloads it and opens wa.me with the
 * prepared text. "Sent" is only ever the user's own confirmation. */
function SendDialog({ expense, version, supplierPhone, busy, onClose, onConfirm }: {
  expense: Expense;
  version: OrderFormVersion;
  supplierPhone: string | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const { run, busy: working } = useBudgetAction();
  const text = t.whatsappText(expense.referenceNo, version.versionNo);
  const canShare = typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  const share = () => void run(async () => {
    const file = await fetchBudgetDocumentFile(version.documentVersionId);
    if (!navigator.canShare?.({ files: [file] })) {
      await downloadBudgetDocument(version.documentVersionId);
      return;
    }
    try {
      await navigator.share({ files: [file], text });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
    }
  });
  return (
    <Modal open onClose={onClose} title={t.sendTitle}>
      <div className="space-y-3" data-testid="order-form-send">
        <p className="text-sm text-slate-600">{t.sendHint}</p>
        <div className="flex flex-wrap gap-2">
          {canShare && (
            <Button size="sm" variant="secondary" loading={working} onClick={share}><Share2 className="size-4" />{t.share}</Button>
          )}
          <Button size="sm" variant="secondary" disabled={working}
            onClick={() => void run(() => downloadBudgetDocument(version.documentVersionId))}>
            <Download className="size-4" />{t.downloadFile}
          </Button>
          <a href={whatsappLink(supplierPhone, text)} target="_blank" rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-primary-700 ring-1 ring-slate-200">
            {t.openWhatsapp}
          </a>
        </div>
        <Field label={t.sentNote}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        <Button className="w-full" loading={busy} onClick={() => onConfirm(note.trim())}>{t.confirmSent}</Button>
      </div>
    </Modal>
  );
}
