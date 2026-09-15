import { useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type Allocation, type Expense, type PartyHistoryEntry, type PartyWorkflow } from "./budgetClient";
import { agorotToInput } from "./budgetMoney";
import { Money, MoneyInput, PaymentBadge, SectionCard, SubmissionBadge, useBudgetAction } from "./budgetUi";
import { ReasonDialog } from "./BudgetExpensePage";
import { RecordPaymentDialog } from "./ExpensePaymentsSection";

const t = BUDGET_TEXT.expense;
const p = BUDGET_TEXT.party;
const c = BUDGET_TEXT.common;

type DialogKind = "preapproval" | "sent" | "returned" | "reference" | "payment";
type Dialog = { kind: DialogKind; allocation: Allocation; workflow: PartyWorkflow } | null;

/** Budget Stage 5: the party-funded process, per party allocation, as FOUR
 * separate business events - prior budget approval, the submission to the
 * funder, the later payment reference, and the party's payments to the
 * supplier. Every figure, state and gate comes from the server; this view
 * only decides which buttons to show (the server refuses anything else). */
export function ExpensePartySection({ expense, open, canSubmit, canPay, onChange }: {
  expense: Expense;
  open: boolean;
  canSubmit: boolean;
  canPay: boolean;
  onChange: (next: Expense | undefined) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const { run, busy } = useBudgetAction();
  const payable = expense.status === "committed" || expense.status === "incurred";
  const close = (r: Expense | undefined) => {
    setDialog(null);
    onChange(r);
  };

  return (
    <>
      {expense.party.map((w) => {
        const a = expense.allocations.find((x) => x.id === w.allocationId);
        if (!a) return null;
        const events = expense.submissionEvents.filter((ev) => ev.allocationId === w.allocationId);
        const payments = expense.payments.filter((pm) => pm.allocationId === w.allocationId);
        const lastReturn = [...events].reverse().find((ev) => ev.event === "returned");
        const partial = a.reference && w.requestedAmount !== null && a.reference.authorizedAmount < w.requestedAmount;
        const canPrepare = w.storedState === "not_sent" || w.storedState === "returned";
        return (
          <SectionCard key={w.allocationId} title={p.allocationTitle(w.sourceName)}>
            <div className="grid gap-3 lg:grid-cols-2" data-testid="party-workflow" data-allocation={w.allocationId}>
              {/* B. Prior budget approval */}
              <Panel title={p.preapprovalTitle} testId="party-preapproval">
                {a.preapproval ? (
                  <dl className="grid gap-1 text-sm">
                    <Item label={t.approvalCode} value={a.preapproval.approvalCode} />
                    <Item label={t.approverName} value={a.preapproval.approverName} />
                    <Item label={t.approvalDate} value={a.preapproval.approvalDate} />
                    {a.preapproval.orderNumber && <Item label={t.orderNumber} value={a.preapproval.orderNumber} />}
                    <Item label={p.partyPreapproved} value={a.preapproval.preapprovedAmount !== null ? <Money value={a.preapproval.preapprovedAmount} /> : c.none} />
                    {a.preapproval.note && <Item label={p.note} value={a.preapproval.note} />}
                  </dl>
                ) : (
                  <p className="text-sm font-semibold text-amber-800">{p.preapprovalNone}</p>
                )}
                {w.exceedsPreapproval && (
                  <p role="alert" className="rounded-lg bg-opponent-soft px-2 py-1.5 text-xs font-semibold text-rose-800">
                    {t.preapprovalExceeded}. {p.preapprovalCapHint}
                  </p>
                )}
                <p className="text-xs text-slate-500">{p.preapprovalHint}</p>
                {canSubmit && open && !a.reference && (
                  <Button size="sm" variant="secondary" data-testid="record-preapproval"
                    onClick={() => setDialog({ kind: "preapproval", allocation: a, workflow: w })}>
                    {a.preapproval ? p.updatePreapproval : t.recordPreapproval}
                  </Button>
                )}
                <History entries={w.preapprovalHistory} />
              </Panel>

              {/* C. Submission to the funder */}
              <Panel title={p.submissionTitle} testId="party-submission">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SubmissionBadge state={w.workflowState} />
                  <span className="text-xs text-slate-500">{t.requested}: <Money value={w.requestedAmount ?? w.amount} /></span>
                </div>
                {!w.hasReference && w.storedState !== "sent" && open && (
                  <div className="space-y-1" data-testid="party-readiness">
                    <p className="text-xs font-bold text-slate-600">{p.readiness}</p>
                    {w.readiness.ready ? (
                      <p className="text-sm font-semibold text-emerald-700">{p.readyOk}</p>
                    ) : (
                      <ul className="list-inside list-disc text-sm text-amber-900">
                        {w.readiness.blockers.map((b) => (
                          <li key={b} data-blocker={b}>{p.blockers[b] ?? b}</li>
                        ))}
                      </ul>
                    )}
                    {w.readiness.missingDocuments.length > 0 && (
                      <p className="text-xs text-slate-600">
                        {p.missingDocuments}: {w.readiness.missingDocuments.map((m) => m.name).join(" · ")}
                      </p>
                    )}
                  </div>
                )}
                {w.readyLapsed && (
                  <p role="alert" className="rounded-lg bg-potential-soft px-2 py-1.5 text-xs font-semibold text-amber-900">{p.readyLapsed}</p>
                )}
                {w.storedState === "returned" && lastReturn && (
                  <div className="rounded-lg bg-potential-soft px-2 py-1.5 text-xs text-amber-900">
                    <p className="font-semibold">{t.markReturned}: {lastReturn.note}</p>
                    <p>{p.resendHint}</p>
                  </div>
                )}
                {canSubmit && open && !w.hasReference && (
                  <div className="flex flex-wrap gap-2">
                    {canPrepare && a.preapproval && (
                      <Button size="sm" data-testid="mark-ready" disabled={busy || !w.readiness.ready}
                        onClick={() => void run(() => budgetCall<Expense>("mark_submission_ready", { allocationId: w.allocationId }), c.saved).then(onChange)}>
                        {p.markReady}
                      </Button>
                    )}
                    {w.storedState === "ready" && (
                      <Button size="sm" data-testid="mark-sent" disabled={!w.readiness.ready}
                        onClick={() => setDialog({ kind: "sent", allocation: a, workflow: w })}>
                        {p.markSent}
                      </Button>
                    )}
                    {w.storedState === "sent" && (
                      <Button size="sm" variant="secondary" data-testid="mark-returned"
                        onClick={() => setDialog({ kind: "returned", allocation: a, workflow: w })}>
                        {p.markReturned}
                      </Button>
                    )}
                  </div>
                )}
                <details className="text-sm" data-testid="party-attempts">
                  <summary className="min-h-11 cursor-pointer py-2 text-xs font-bold text-primary-700">{p.attempts} ({w.attempts})</summary>
                  {events.length === 0 ? (
                    <p className="text-xs text-slate-500">{p.noAttempts}</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-xs">
                      {events.map((ev) => (
                        <li key={ev.id} className="py-1.5">
                          <span className="font-semibold text-slate-700">
                            {ev.attemptNo ? `${p.attempt(ev.attemptNo)} · ` : ""}{p.events[ev.event]}
                          </span>
                          {ev.orderFormVersionNo ? ` · ${p.formVersion(ev.orderFormVersionNo)}` : ""}
                          {ev.requestedAmount !== null && <> · <Money value={ev.requestedAmount} /></>}
                          {ev.note ? ` · ${ev.note}` : ""}
                          <span className="block text-slate-500">{ev.actorName} · <span dir="ltr">{new Date(ev.createdAt).toLocaleString("he-IL")}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </Panel>

              {/* D. Payment reference (the party's later authorization) */}
              <Panel title={p.referenceTitle} testId="party-reference">
                {a.reference ? (
                  <dl className="grid gap-1 text-sm">
                    <Item label={t.referenceNumber} value={a.reference.referenceNumber} />
                    <Item label={t.authorized} value={<Money value={a.reference.authorizedAmount} />} />
                    {w.requestedAmount !== null && <Item label={t.requested} value={<Money value={w.requestedAmount} />} />}
                    <Item label={t.receivedDate} value={a.reference.receivedDate} />
                    {a.reference.note && <Item label={p.note} value={a.reference.note} />}
                  </dl>
                ) : (
                  <p className="text-sm text-slate-600">{p.referenceNone}{w.storedState !== "sent" ? ` - ${p.referenceNeedsSent}` : ""}</p>
                )}
                {partial && <p role="status" className="rounded-lg bg-potential-soft px-2 py-1 text-xs font-semibold text-amber-900">{t.partialAuthorization}</p>}
                <p className="text-xs text-slate-500">{p.referenceHint}</p>
                {canSubmit && open && ((w.storedState === "sent" && !a.reference) || (a.reference && w.paid === 0)) && (
                  <Button size="sm" variant={a.reference ? "ghost" : "primary"} data-testid="record-reference"
                    onClick={() => setDialog({ kind: "reference", allocation: a, workflow: w })}>
                    {a.reference ? c.edit : t.recordReference}
                  </Button>
                )}
                <History entries={w.referenceHistory} />
              </Panel>

              {/* E. The party's payments to the supplier */}
              <Panel title={p.paymentsTitle} testId="party-payments">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <PaymentBadge status={w.paymentStatus} />
                </div>
                <dl className="grid gap-1 text-sm">
                  <Item label={p.partyAllocation} value={<Money value={w.amount} />} />
                  <Item label={p.paidByParty} value={<Money value={w.paid} />} />
                  <Item label={p.remaining} value={<Money value={w.remaining} className="font-bold" />} />
                </dl>
                <p className="text-xs text-slate-500">{p.paymentsHint}</p>
                {payments.length > 0 && (
                  <ul className="divide-y divide-slate-100 text-sm" data-testid="party-payment-list">
                    {payments.map((pm) => (
                      <li key={pm.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2", pm.voidedAt && "opacity-60")}>
                        <div className="min-w-0">
                          <p className={cn("font-semibold text-slate-800", pm.voidedAt && "line-through")}>
                            <Money value={pm.amount} /> · {pm.paymentDate}
                          </p>
                          <p className="text-xs text-slate-500">
                            {BUDGET_TEXT.confirmationSource[pm.confirmationSource]}
                            {pm.externalReference ? ` · ${pm.externalReference}` : ""} · {p.recordedBy} {pm.recordedByName}
                            {pm.voidedAt ? ` · ${t.voided}: ${pm.voidReason}` : ""}
                          </p>
                        </div>
                        {canPay && open && !pm.voidedAt && (
                          <Button size="sm" variant="danger-outline" onClick={() => setVoiding(pm.id)}>{t.voidPayment}</Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!w.hasReference && <p className="text-xs text-slate-600">{p.paymentsNeedReference}</p>}
                {canPay && payable && w.hasReference && w.remaining > 0 && (
                  <Button size="sm" data-testid="party-add-payment" onClick={() => setDialog({ kind: "payment", allocation: a, workflow: w })}>
                    <Plus className="size-4" />
                    {p.addPayment}
                  </Button>
                )}
              </Panel>
            </div>
          </SectionCard>
        );
      })}

      {dialog?.kind === "preapproval" && (
        <PreapprovalDialog allocation={dialog.allocation} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("record_preapproval", args), c.saved).then(close)} />
      )}
      {dialog?.kind === "sent" && (
        <SentDialog busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("mark_submission_sent", { allocationId: dialog.allocation.id, ...args }), c.saved).then(close)} />
      )}
      {dialog?.kind === "returned" && (
        <ReturnedDialog busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("mark_submission_returned", { allocationId: dialog.allocation.id, ...args }), c.saved).then(close)} />
      )}
      {dialog?.kind === "reference" && (
        <ReferenceDialog allocation={dialog.allocation} workflow={dialog.workflow} busy={busy} onClose={() => setDialog(null)}
          onSubmit={(args) => void run(() => budgetCall<Expense>("record_payment_reference", args), c.saved).then(close)} />
      )}
      {dialog?.kind === "payment" && (
        <RecordPaymentDialog expense={expense} allocationIds={[dialog.allocation.id]}
          allocLabel={() => `${dialog.workflow.sourceName} · ${BUDGET_TEXT.payer.party}`}
          onClose={() => setDialog(null)} onDone={(r) => { if (r) setDialog(null); onChange(r); }} />
      )}
      {voiding && (
        <ReasonDialog title={t.voidPayment} busy={busy} onClose={() => setVoiding(null)}
          onSubmit={(reason) => void run(() => budgetCall<Expense>("void_payment", { paymentId: voiding, reason }), c.saved)
            .then((r) => { setVoiding(null); onChange(r); })} />
      )}
    </>
  );
}

function Panel({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="space-y-2 rounded-xl p-3 ring-1 ring-slate-200" data-testid={testId}>
      <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      {children}
    </section>
  );
}

function Item({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-end font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function History({ entries }: { entries: PartyHistoryEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <details className="text-xs">
      <summary className="min-h-11 cursor-pointer py-2 font-bold text-primary-700">{p.history} ({entries.length})</summary>
      <ul className="divide-y divide-slate-100">
        {entries.map((h, i) => (
          <li key={i} className="py-1.5 text-slate-600">
            <span className="font-semibold text-slate-700">{p.historyActions[h.action] ?? h.action}</span> · {h.actorName} ·{" "}
            <span dir="ltr">{new Date(h.occurredAt).toLocaleString("he-IL")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PreapprovalDialog({ allocation, busy, onClose, onSubmit }: {
  allocation: Allocation; busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const pa = allocation.preapproval;
  const [orderNumber, setOrderNumber] = useState(pa?.orderNumber ?? "");
  const [approvalCode, setApprovalCode] = useState(pa?.approvalCode ?? "");
  const [approverName, setApproverName] = useState(pa?.approverName ?? "");
  const [approvalDate, setApprovalDate] = useState(pa?.approvalDate ?? "");
  const [amountText, setAmountText] = useState(agorotToInput(pa?.preapprovedAmount));
  const [amount, setAmount] = useState<number | null>(pa?.preapprovedAmount ?? null);
  const [note, setNote] = useState(pa?.note ?? "");
  const valid = approvalCode.trim() && approverName.trim() && approvalDate && (amountText === "" || (amount !== null && amount > 0));
  return (
    <Modal open onClose={onClose} title={p.preapprovalTitle}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({
          allocationId: allocation.id, approvalCode: approvalCode.trim(), approverName: approverName.trim(), approvalDate,
          ...(orderNumber.trim() ? { orderNumber: orderNumber.trim() } : {}),
          ...(amountText !== "" && amount !== null ? { preapprovedAmount: amount } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(pa ? { expectedVersion: pa.version } : {}),
        });
      }}>
        <p className="text-xs text-slate-500">{p.preapprovalHint}</p>
        <Field label={t.approvalCode}><Input value={approvalCode} onChange={(ev) => setApprovalCode(ev.target.value)} maxLength={100} required /></Field>
        <Field label={t.approverName}><Input value={approverName} onChange={(ev) => setApproverName(ev.target.value)} maxLength={200} required /></Field>
        <Field label={t.approvalDate}><Input type="date" value={approvalDate} onChange={(ev) => setApprovalDate(ev.target.value)} required /></Field>
        <Field label={t.orderNumber}><Input value={orderNumber} onChange={(ev) => setOrderNumber(ev.target.value)} maxLength={100} /></Field>
        <Field label={t.preapprovedAmount}><MoneyInput value={amountText} onChange={(v, n) => { setAmountText(v); setAmount(n); }} /></Field>
        <p className="text-xs text-slate-500">{p.preapprovalCapHint}</p>
        <Field label={p.note}><Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
      </form>
    </Modal>
  );
}

/** A transition dialog's idempotency key is created on the first submit (never
 * during render) and reused on a retry, so a double submit records once. */
function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return () => (ref.current ??= crypto.randomUUID());
}

function SentDialog({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const key = useIdempotencyKey();
  return (
    <Modal open onClose={onClose} title={p.markSent}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({ idempotencyKey: key(), ...(phone.trim() ? { recipientPhone: phone.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      }}>
        <p className="text-sm text-slate-600">{t.sentHint}</p>
        <Field label={BUDGET_TEXT.settings.funderPhone}><Input dir="ltr" value={phone} onChange={(ev) => setPhone(ev.target.value)} maxLength={32} /></Field>
        <Field label={p.note}><Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} /></Field>
        <Button type="submit" className="w-full" loading={busy}>{p.markSent}</Button>
      </form>
    </Modal>
  );
}

function ReturnedDialog({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const [note, setNote] = useState("");
  const key = useIdempotencyKey();
  return (
    <Modal open onClose={onClose} title={p.markReturned}>
      <form className="space-y-3" onSubmit={(ev) => { ev.preventDefault(); onSubmit({ note: note.trim(), idempotencyKey: key() }); }}>
        <Field label={p.returnNote}><Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} required /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={note.trim() === ""}>{c.save}</Button>
      </form>
    </Modal>
  );
}

function ReferenceDialog({ allocation, workflow, busy, onClose, onSubmit }: {
  allocation: Allocation; workflow: PartyWorkflow; busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const r = allocation.reference;
  const initial = r?.authorizedAmount ?? workflow.requestedAmount ?? allocation.amount;
  const [referenceNumber, setReferenceNumber] = useState(r?.referenceNumber ?? "");
  const [amountText, setAmountText] = useState(agorotToInput(initial));
  const [amount, setAmount] = useState<number | null>(initial);
  const [receivedDate, setReceivedDate] = useState(r?.receivedDate ?? "");
  const [note, setNote] = useState(r?.note ?? "");
  const valid = referenceNumber.trim() && receivedDate && amount !== null && amount > 0;
  return (
    <Modal open onClose={onClose} title={p.referenceTitle}>
      <form className="space-y-3" onSubmit={(ev) => {
        ev.preventDefault();
        onSubmit({
          allocationId: allocation.id, referenceNumber: referenceNumber.trim(), authorizedAmount: amount, receivedDate,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(r ? { expectedVersion: r.version } : {}),
        });
      }}>
        <p className="text-xs text-slate-500">{p.referenceHint}</p>
        <Field label={t.referenceNumber}><Input value={referenceNumber} onChange={(ev) => setReferenceNumber(ev.target.value)} maxLength={100} required /></Field>
        <Field label={t.authorizedAmount}><MoneyInput value={amountText} onChange={(v, n) => { setAmountText(v); setAmount(n); }} /></Field>
        <Field label={t.receivedDate}><Input type="date" value={receivedDate} onChange={(ev) => setReceivedDate(ev.target.value)} required /></Field>
        <Field label={p.note}><Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={1000} /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
      </form>
    </Modal>
  );
}
