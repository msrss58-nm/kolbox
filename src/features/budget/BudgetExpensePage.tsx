import { useCallback, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { BUDGET_ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { BUDGET_TEXT } from "./budget.constants";
import {
  budgetCall,
  type BudgetCategory,
  type Expense,
  type ExpenseStatus,
  type FundingSource,
  type HistoryEntry,
  type Supplier,
} from "./budgetClient";
import { agorotToInput } from "./budgetMoney";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { ExpenseStatusBadge, LoadError, Money, MoneyInput, PaymentBadge, SectionCard, useBudgetAction } from "./budgetUi";
import { ExpenseFundingSection } from "./ExpenseFundingSection";
import { ExpensePartySection } from "./ExpensePartySection";
import { ExpensePaymentsSection } from "./ExpensePaymentsSection";

const t = BUDGET_TEXT.expense;
const e = BUDGET_TEXT.expenses;
const c = BUDGET_TEXT.common;

export interface ExpenseLookups {
  categories: BudgetCategory[];
  suppliers: Supplier[];
  sources: FundingSource[];
}

/** Which transitions the lifecycle allows from a status (the server is the
 * authority; this only decides which buttons to show). */
const NEXT: Record<ExpenseStatus, { to: ExpenseStatus; label: string; needsReason: boolean; danger?: boolean }[]> = {
  draft: [
    { to: "committed", label: t.transitions.committed, needsReason: false },
    { to: "incurred", label: t.transitions.incurred, needsReason: false },
    { to: "cancelled", label: t.transitions.cancelled, needsReason: false, danger: true },
  ],
  committed: [
    { to: "incurred", label: t.transitions.incurred, needsReason: false },
    { to: "cancelled", label: t.transitions.cancelled, needsReason: true, danger: true },
  ],
  incurred: [
    { to: "closed", label: t.transitions.closed, needsReason: false },
    { to: "cancelled", label: t.transitions.cancelled, needsReason: true, danger: true },
  ],
  closed: [{ to: "incurred", label: t.transitions.reopen, needsReason: true }],
  cancelled: [],
};

/** The expense file: ONE persistent record from draft to closed. */
export function BudgetExpensePage() {
  const { expenseId = "" } = useParams();
  const session = useBudgetSession((s) => s.session);
  const canManage = budgetCan(session, "budget.manageExpenses");

  const fetchExpense = useCallback(() => budgetCall<Expense>("get_expense", { expenseId }), [expenseId]);
  const expense = useAsyncData(fetchExpense);
  const fetchLookups = useCallback(async (): Promise<ExpenseLookups> => {
    const [categories, suppliers, sources] = await Promise.all([
      budgetCall<BudgetCategory[]>("list_categories"),
      budgetCall<Supplier[]>("list_suppliers"),
      budgetCall<FundingSource[]>("list_sources"),
    ]);
    return { categories, suppliers, sources };
  }, []);
  const lookups = useAsyncData(fetchLookups);
  const fetchHistory = useCallback(
    () => budgetCall<HistoryEntry[]>("list_history", { entityType: "expense", entityId: expenseId }),
    [expenseId],
  );
  const history = useAsyncData(fetchHistory);

  const [transition, setTransition] = useState<(typeof NEXT)[ExpenseStatus][number] | null>(null);
  const [editing, setEditing] = useState(false);
  const { run, busy } = useBudgetAction();

  /** Every mutation returns the whole expense - adopt it, refresh history. */
  const adopt = (next: Expense | undefined) => {
    if (next) {
      expense.setData(next);
      history.reload();
    } else {
      expense.reload(); // a conflict or failure: show the server's truth
    }
  };

  if (expense.error && !expense.data) return <LoadError onRetry={expense.reload} />;
  if (!expense.data || !lookups.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }
  const x = expense.data;
  const lk = lookups.data;
  const supplier = lk.suppliers.find((s) => s.id === x.supplierId);
  const category = lk.categories.find((k) => k.id === x.categoryId);
  const open = x.status === "draft" || x.status === "committed" || x.status === "incurred";

  return (
    <div className="space-y-4" data-testid="expense-file">
      <Link to={BUDGET_ROUTES.expenses} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-primary-700">
        <ArrowRight className="size-4" />
        {t.back}
      </Link>

      <Card className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500">#{x.referenceNo}</p>
            <h1 className="text-xl font-extrabold text-slate-800 md:text-2xl">{x.description}</h1>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ExpenseStatusBadge status={x.status} />
              <PaymentBadge status={x.facts.paymentStatus} />
            </div>
          </div>
          <div className="text-end">
            <Money value={x.total} className="text-2xl font-extrabold text-slate-800" />
            <p className="text-xs text-slate-500">
              {t.paid}: <Money value={x.facts.paid} /> · {t.outstanding}: <Money value={x.facts.outstanding} />
            </p>
          </div>
        </div>
        {x.facts.unfunded > 0 && x.status !== "cancelled" && (
          <p role="status" className="rounded-xl bg-potential-soft px-3 py-2 text-sm font-semibold text-amber-900">
            {t.unfunded}: <Money value={x.facts.unfunded} />
          </p>
        )}
        {canManage && NEXT[x.status].length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="expense-transitions">
            {NEXT[x.status].map((n) => (
              <Button key={n.to} variant={n.danger ? "danger-outline" : "secondary"} size="sm"
                onClick={() => (n.needsReason ? setTransition(n) :
                  void run(() => budgetCall<Expense>("transition_expense", { expenseId: x.id, expectedVersion: x.version, toStatus: n.to }), c.saved).then(adopt))}
                disabled={busy}>
                {n.label}
              </Button>
            ))}
          </div>
        )}
      </Card>

      <SectionCard title={t.details} actions={canManage && open ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{c.edit}</Button>) : undefined}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label={e.supplier} value={supplier?.businessName ?? c.none} />
          <Row label={e.category} value={category?.name ?? c.none} />
          <Row label={e.expenseDate} value={x.expenseDate ?? c.none} />
          <Row label={e.deliveryDate} value={x.deliveryDate ?? c.none} />
          <Row label={e.invoiceDate} value={x.invoiceDate ?? c.none} />
          <Row label={c.notes} value={x.notes ?? c.none} />
          {x.statusReason && <Row label={c.reason} value={x.statusReason} />}
        </dl>
      </SectionCard>

      <ExpenseFundingSection expense={x} lookups={lk} canManage={canManage && open} onChange={adopt} />
      {x.allocations.some((a) => a.kind === "party") && (
        <ExpensePartySection expense={x} canManage={budgetCan(session, "budget.manageFunderSubmissions") && open} onChange={adopt} />
      )}
      <ExpensePaymentsSection expense={x} lookups={lk} canManage={canManage} onChange={adopt} />

      <SectionCard title={c.history}>
        {!history.data || history.data.length === 0 ? (
          <p className="text-sm text-slate-500">{c.noHistory}</p>
        ) : (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-sm" data-testid="expense-history">
            {[...history.data].reverse().map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-slate-700">
                  {h.actorName} · {h.entityType.replace("budget_", "")} · {h.action}
                </span>
                <span className="text-xs text-slate-500" dir="ltr">{new Date(h.occurredAt).toLocaleString("he-IL")}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {transition && (
        <ReasonDialog title={transition.label} busy={busy} onClose={() => setTransition(null)}
          onSubmit={(reason) => void run(() => budgetCall<Expense>("transition_expense",
            { expenseId: x.id, expectedVersion: x.version, toStatus: transition.to, reason }), c.saved)
            .then((r) => { setTransition(null); adopt(r); })} />
      )}
      {editing && <EditExpenseDialog expense={x} lookups={lk} onClose={() => setEditing(false)}
        onSaved={(r) => { setEditing(false); adopt(r); }} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-50 py-1">
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 text-end font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

export function ReasonDialog({ title, busy, onClose, onSubmit }:
  { title: string; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open onClose={onClose} title={title}>
      <form className="space-y-4" onSubmit={(ev) => { ev.preventDefault(); onSubmit(reason.trim()); }}>
        <Field label={c.reason}>
          <Input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={500} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={reason.trim() === ""}>{c.save}</Button>
      </form>
    </Modal>
  );
}

function EditExpenseDialog({ expense, lookups, onClose, onSaved }:
  { expense: Expense; lookups: ExpenseLookups; onClose: () => void; onSaved: (r: Expense | undefined) => void }) {
  const [description, setDescription] = useState(expense.description);
  const [supplierId, setSupplierId] = useState(expense.supplierId ?? "");
  const [categoryId, setCategoryId] = useState(expense.categoryId ?? "");
  const [totalText, setTotalText] = useState(agorotToInput(expense.total));
  const [total, setTotal] = useState<number | null>(expense.total);
  const [expenseDate, setExpenseDate] = useState(expense.expenseDate ?? "");
  const [deliveryDate, setDeliveryDate] = useState(expense.deliveryDate ?? "");
  const [invoiceDate, setInvoiceDate] = useState(expense.invoiceDate ?? "");
  const [notes, setNotes] = useState(expense.notes ?? "");
  const { run, busy } = useBudgetAction();
  const valid = description.trim() !== "" && (totalText === "" || (total !== null && total > 0));
  return (
    <Modal open onClose={onClose} title={c.edit} wide>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(ev) => {
        ev.preventDefault();
        void run(() => budgetCall<Expense>("update_expense", {
          expenseId: expense.id, expectedVersion: expense.version, description: description.trim(),
          supplierId: supplierId || null, categoryId: categoryId || null,
          total: totalText === "" ? null : total, expenseDate: expenseDate || null,
          deliveryDate: deliveryDate || null, invoiceDate: invoiceDate || null, notes: notes.trim() || null,
        }), c.saved).then(onSaved);
      }}>
        <div className="sm:col-span-2">
          <Field label={e.description}><Input value={description} onChange={(ev) => setDescription(ev.target.value)} maxLength={500} required /></Field>
        </div>
        <Field label={e.supplier}>
          <Select value={supplierId} onChange={(ev) => setSupplierId(ev.target.value)}>
            <option value="">{c.none}</option>
            {lookups.suppliers.filter((s) => s.isActive || s.id === expense.supplierId).map((s) => (
              <option key={s.id} value={s.id}>{s.businessName}</option>))}
          </Select>
        </Field>
        <Field label={e.category}>
          <Select value={categoryId} onChange={(ev) => setCategoryId(ev.target.value)}>
            <option value="">{c.none}</option>
            {lookups.categories.filter((k) => k.isActive || k.id === expense.categoryId).map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>))}
          </Select>
        </Field>
        <Field label={e.total}><MoneyInput value={totalText} onChange={(v, a) => { setTotalText(v); setTotal(a); }} /></Field>
        <Field label={e.expenseDate}><Input type="date" value={expenseDate} onChange={(ev) => setExpenseDate(ev.target.value)} /></Field>
        <Field label={e.deliveryDate}><Input type="date" value={deliveryDate} onChange={(ev) => setDeliveryDate(ev.target.value)} /></Field>
        <Field label={e.invoiceDate}><Input type="date" value={invoiceDate} onChange={(ev) => setInvoiceDate(ev.target.value)} /></Field>
        <div className="sm:col-span-2">
          <Field label={c.notes}><Input value={notes} onChange={(ev) => setNotes(ev.target.value)} maxLength={4000} /></Field>
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" className="w-full" loading={busy} disabled={!valid}>{c.save}</Button>
        </div>
      </form>
    </Modal>
  );
}
