import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type ConfirmationSource, type Expense, type Payment } from "./budgetClient";
import type { ExpenseLookups } from "./BudgetExpensePage";
import { ReasonDialog } from "./BudgetExpensePage";
import { Money, MoneyInput, SectionCard, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.expense;
const c = BUDGET_TEXT.common;
const SOURCES = Object.keys(BUDGET_TEXT.confirmationSource) as ConfirmationSource[];

/** The supplier payment ledger: any number of payments per allocation; a
 * mistaken payment is voided (kept, with a reason), never deleted. */
export function ExpensePaymentsSection({ expense, lookups, canManage, onChange }: {
  expense: Expense;
  lookups: ExpenseLookups;
  canManage: boolean;
  onChange: (next: Expense | undefined) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<Payment | null>(null);
  const { run, busy } = useBudgetAction();
  const payable = expense.status === "committed" || expense.status === "incurred";
  const open = payable || expense.status === "draft";
  const allocLabel = (id: string) => {
    const a = expense.allocations.find((x) => x.id === id);
    const s = lookups.sources.find((x) => x.id === a?.sourceId);
    return s ? `${s.name} · ${BUDGET_TEXT.payer[a!.payer]}` : c.none;
  };

  return (
    <SectionCard
      title={t.payments}
      actions={canManage && payable && expense.allocations.some((a) => a.paid < a.amount) ? (
        <Button size="sm" onClick={() => setRecording(true)} data-testid="record-payment">
          <Plus className="size-4" />
          {t.recordPayment}
        </Button>
      ) : undefined}
    >
      {expense.payments.length === 0 ? (
        <p className="text-sm text-slate-500">{t.noPayments}</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm" data-testid="payments">
          {expense.payments.map((p) => (
            <li key={p.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2.5", p.voidedAt && "opacity-60")}>
              <div className="min-w-0">
                <p className={cn("font-semibold text-slate-800", p.voidedAt && "line-through")}>
                  <Money value={p.amount} /> · {p.paymentDate}
                </p>
                <p className="text-xs text-slate-500">
                  {allocLabel(p.allocationId)} · {BUDGET_TEXT.confirmationSource[p.confirmationSource]}
                  {p.externalReference ? ` · ${p.externalReference}` : ""} · {p.recordedByName}
                  {p.voidedAt ? ` · ${t.voided}: ${p.voidReason}` : ""}
                </p>
              </div>
              {canManage && open && !p.voidedAt && (
                <Button size="sm" variant="danger-outline" onClick={() => setVoiding(p)}>{t.voidPayment}</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {recording && <RecordPaymentDialog expense={expense} allocLabel={allocLabel} onClose={() => setRecording(false)}
        onDone={(r) => { if (r) setRecording(false); onChange(r); }} />}
      {voiding && (
        <ReasonDialog title={t.voidPayment} busy={busy} onClose={() => setVoiding(null)}
          onSubmit={(reason) => void run(() => budgetCall<Expense>("void_payment", { paymentId: voiding.id, reason }), c.saved)
            .then((r) => { setVoiding(null); onChange(r); })} />
      )}
    </SectionCard>
  );
}

/** `allocationIds` limits the choice (the party section records only on its
 * own party allocation). */
export function RecordPaymentDialog({ expense, allocationIds, allocLabel, onClose, onDone }: {
  expense: Expense; allocationIds?: string[]; allocLabel: (id: string) => string; onClose: () => void; onDone: (r: Expense | undefined) => void;
}) {
  const open = expense.allocations.filter((a) => a.paid < a.amount && (!allocationIds || allocationIds.includes(a.id)));
  const [allocationId, setAllocationId] = useState(open[0]?.id ?? "");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [paymentDate, setPaymentDate] = useState("");
  const [source, setSource] = useState<ConfirmationSource>("funder_notice");
  const [externalReference, setExternalReference] = useState("");
  const [note, setNote] = useState("");
  // Idempotency: the key is created on the first submit (never during render)
  // and reused if the same payment is retried, so a double submit cannot pay
  // twice; the server returns the first result for a repeated key.
  const keyRef = useRef<string | null>(null);
  const { run, busy } = useBudgetAction();
  const alloc = open.find((a) => a.id === allocationId);
  const remaining = alloc ? alloc.amount - alloc.paid : 0;
  const valid = alloc && amount !== null && amount > 0 && amount <= remaining && paymentDate;
  return (
    <Modal open onClose={onClose} title={t.recordPayment}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        keyRef.current ??= crypto.randomUUID();
        void run(() => budgetCall<Expense>("record_payment", {
          allocationId, amount, paymentDate, confirmationSource: source, idempotencyKey: keyRef.current,
          ...(externalReference.trim() ? { externalReference: externalReference.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }), c.saved).then(onDone);
      }}>
        <Field label={t.source}>
          <Select value={allocationId} onChange={(ev) => { setAllocationId(ev.target.value); keyRef.current = null; }}>
            {open.map((a) => (<option key={a.id} value={a.id}>{allocLabel(a.id)}</option>))}
          </Select>
        </Field>
        {alloc && <p className="text-xs text-slate-500">{t.outstanding}: <Money value={remaining} /></p>}
        <Field label={c.amount}><MoneyInput value={text} onChange={(v, n) => { setText(v); setAmount(n); keyRef.current = null; }} /></Field>
        <Field label={t.paymentDate}><Input type="date" value={paymentDate} onChange={(ev) => setPaymentDate(ev.target.value)} required /></Field>
        <Field label={t.confirmationSource}>
          <Select value={source} onChange={(ev) => setSource(ev.target.value as ConfirmationSource)}>
            {SOURCES.map((s) => (<option key={s} value={s}>{BUDGET_TEXT.confirmationSource[s]}</option>))}
          </Select>
        </Field>
        <Field label={t.externalReference}><Input value={externalReference} onChange={(ev) => setExternalReference(ev.target.value)} maxLength={100} /></Field>
        <Field label={c.notes}><Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
      </form>
    </Modal>
  );
}
