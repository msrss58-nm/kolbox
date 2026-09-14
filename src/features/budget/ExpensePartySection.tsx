import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type Allocation, type Expense } from "./budgetClient";
import { agorotToInput } from "./budgetMoney";
import { Money, MoneyInput, SectionCard, SubmissionBadge, useBudgetAction } from "./budgetUi";
import { ReasonDialog } from "./BudgetExpensePage";

const t = BUDGET_TEXT.expense;
const c = BUDGET_TEXT.common;

type Dialog = { kind: "preapproval" | "sent" | "returned" | "reference"; allocation: Allocation } | null;

/** The party-funded process for each party allocation: prior budget approval
 * (BEFORE the order), sent / returned, and the later payment reference with
 * the AUTHORIZED amount. Separate from supplier payment status. */
export function ExpensePartySection({ expense, canManage, onChange }: {
  expense: Expense;
  canManage: boolean;
  onChange: (next: Expense | undefined) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { run, busy } = useBudgetAction();
  const party = expense.allocations.filter((a) => a.kind === "party");
  const close = (r: Expense | undefined) => {
    setDialog(null);
    onChange(r);
  };

  return (
    <SectionCard title={t.party}>
      <ul className="space-y-3" data-testid="party-workflow">
        {party.map((a) => {
          const state = a.submission?.displayState ?? "awaiting_preapproval";
          const partial = a.reference && a.submission?.requestedAmount && a.reference.authorizedAmount < a.submission.requestedAmount;
          const exceeded = a.preapproval?.preapprovedAmount != null && a.amount > a.preapproval.preapprovedAmount;
          return (
            <li key={a.id} className="space-y-2 rounded-xl p-3 ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SubmissionBadge state={state} />
                <Money value={a.amount} className="font-bold" />
              </div>
              {a.preapproval ? (
                <p className="text-sm text-slate-600">
                  {t.preapproval}: {a.preapproval.approvalCode} · {a.preapproval.approverName} · {a.preapproval.approvalDate}
                  {a.preapproval.orderNumber ? ` · ${t.orderNumber} ${a.preapproval.orderNumber}` : ""}
                  {a.preapproval.preapprovedAmount != null && <> · <Money value={a.preapproval.preapprovedAmount} /></>}
                </p>
              ) : null}
              {exceeded && <p className="text-xs font-semibold text-amber-800">{t.preapprovalExceeded}</p>}
              {a.reference && (
                <p className="text-sm text-slate-600">
                  {t.referenceNumber}: {a.reference.referenceNumber} · {t.authorized}: <Money value={a.reference.authorizedAmount} />
                  {a.submission?.requestedAmount != null && <> · {t.requested}: <Money value={a.submission.requestedAmount} /></>}
                </p>
              )}
              {partial && <p role="status" className="rounded-lg bg-potential-soft px-2 py-1 text-xs font-semibold text-amber-900">{t.partialAuthorization}</p>}
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  {!a.reference && (
                    <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "preapproval", allocation: a })}>
                      {t.recordPreapproval}
                    </Button>
                  )}
                  {a.preapproval && !a.reference && a.submission?.state !== "sent" && (
                    <Button size="sm" onClick={() => setDialog({ kind: "sent", allocation: a })}>{t.markSent}</Button>
                  )}
                  {a.submission?.state === "sent" && !a.reference && (
                    <>
                      <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "returned", allocation: a })}>{t.markReturned}</Button>
                      <Button size="sm" onClick={() => setDialog({ kind: "reference", allocation: a })}>{t.recordReference}</Button>
                    </>
                  )}
                  {a.reference && a.paid === 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "reference", allocation: a })}>{c.edit}</Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {dialog?.kind === "preapproval" && (
        <PreapprovalDialog allocation={dialog.allocation} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("record_preapproval", args), c.saved).then(close)} />
      )}
      {dialog?.kind === "sent" && (
        <SentDialog busy={busy} onClose={() => setDialog(null)}
          onSubmit={(recipientPhone) => void run(() => budgetCall<Expense>("mark_submission_sent",
            { allocationId: dialog.allocation.id, ...(recipientPhone ? { recipientPhone } : {}) }), c.saved).then(close)} />
      )}
      {dialog?.kind === "returned" && (
        <ReasonDialog title={t.markReturned} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(note) => void run(() => budgetCall<Expense>("mark_submission_returned",
            { allocationId: dialog.allocation.id, note }), c.saved).then(close)} />
      )}
      {dialog?.kind === "reference" && (
        <ReferenceDialog allocation={dialog.allocation} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("record_payment_reference", args), c.saved).then(close)} />
      )}
    </SectionCard>
  );
}

function PreapprovalDialog({ allocation, busy, onClose, onSubmit }: {
  allocation: Allocation; busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const p = allocation.preapproval;
  const [orderNumber, setOrderNumber] = useState(p?.orderNumber ?? "");
  const [approvalCode, setApprovalCode] = useState(p?.approvalCode ?? "");
  const [approverName, setApproverName] = useState(p?.approverName ?? "");
  const [approvalDate, setApprovalDate] = useState(p?.approvalDate ?? "");
  const [amountText, setAmountText] = useState(agorotToInput(p?.preapprovedAmount));
  const [amount, setAmount] = useState<number | null>(p?.preapprovedAmount ?? null);
  const valid = approvalCode.trim() && approverName.trim() && approvalDate && (amountText === "" || (amount !== null && amount > 0));
  return (
    <Modal open onClose={onClose} title={t.preapproval}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({
          allocationId: allocation.id, approvalCode: approvalCode.trim(), approverName: approverName.trim(), approvalDate,
          ...(orderNumber.trim() ? { orderNumber: orderNumber.trim() } : {}),
          ...(amountText !== "" && amount !== null ? { preapprovedAmount: amount } : {}),
          ...(p ? { expectedVersion: p.version } : {}),
        });
      }}>
        <Field label={t.orderNumber}><Input value={orderNumber} onChange={(ev) => setOrderNumber(ev.target.value)} maxLength={100} /></Field>
        <Field label={t.approvalCode}><Input value={approvalCode} onChange={(ev) => setApprovalCode(ev.target.value)} maxLength={100} required /></Field>
        <Field label={t.approverName}><Input value={approverName} onChange={(ev) => setApproverName(ev.target.value)} maxLength={200} required /></Field>
        <Field label={t.approvalDate}><Input type="date" value={approvalDate} onChange={(ev) => setApprovalDate(ev.target.value)} required /></Field>
        <Field label={t.preapprovedAmount}><MoneyInput value={amountText} onChange={(v, n) => { setAmountText(v); setAmount(n); }} /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
      </form>
    </Modal>
  );
}

function SentDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (phone: string) => void }) {
  const [phone, setPhone] = useState("");
  return (
    <Modal open onClose={onClose} title={t.markSent}>
      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); onSubmit(phone.trim()); }}>
        <p className="text-sm text-slate-600">{t.sentHint}</p>
        <Field label={BUDGET_TEXT.settings.funderPhone}><Input dir="ltr" value={phone} onChange={(ev) => setPhone(ev.target.value)} maxLength={32} /></Field>
        <Button type="submit" className="w-full" loading={busy}>{t.markSent}</Button>
      </form>
    </Modal>
  );
}

function ReferenceDialog({ allocation, busy, onClose, onSubmit }: {
  allocation: Allocation; busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const r = allocation.reference;
  const [referenceNumber, setReferenceNumber] = useState(r?.referenceNumber ?? "");
  const [amountText, setAmountText] = useState(agorotToInput(r?.authorizedAmount ?? allocation.submission?.requestedAmount ?? allocation.amount));
  const [amount, setAmount] = useState<number | null>(r?.authorizedAmount ?? allocation.submission?.requestedAmount ?? allocation.amount);
  const [receivedDate, setReceivedDate] = useState(r?.receivedDate ?? "");
  const valid = referenceNumber.trim() && receivedDate && amount !== null && amount > 0;
  return (
    <Modal open onClose={onClose} title={t.recordReference}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({
          allocationId: allocation.id, referenceNumber: referenceNumber.trim(), authorizedAmount: amount, receivedDate,
          ...(r ? { expectedVersion: r.version } : {}),
        });
      }}>
        <Field label={t.referenceNumber}><Input value={referenceNumber} onChange={(ev) => setReferenceNumber(ev.target.value)} maxLength={100} required /></Field>
        <Field label={t.authorizedAmount}><MoneyInput value={amountText} onChange={(v, n) => { setAmountText(v); setAmount(n); }} /></Field>
        <Field label={t.receivedDate}><Input type="date" value={receivedDate} onChange={(ev) => setReceivedDate(ev.target.value)} required /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
      </form>
    </Modal>
  );
}
