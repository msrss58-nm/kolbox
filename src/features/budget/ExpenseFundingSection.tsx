import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Select } from "../../components/ui/Field";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type Allocation, type Expense } from "./budgetClient";
import { agorotToInput } from "./budgetMoney";
import type { ExpenseLookups } from "./BudgetExpensePage";
import { KindBadge, Money, MoneyInput, PaymentBadge, SectionCard, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.expense;
const c = BUDGET_TEXT.common;

/** Funding allocations: one expense, one or more funding sources. The user
 * always chooses the source - an uncovered balance is shown, never filled. */
export function ExpenseFundingSection({ expense, lookups, canManage, onChange }: {
  expense: Expense;
  lookups: ExpenseLookups;
  canManage: boolean;
  onChange: (next: Expense | undefined) => void;
}) {
  const { run, busy } = useBudgetAction();
  const [adding, setAdding] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [editing, setEditing] = useState<Allocation | null>(null);
  const sourceName = (id: string) => lookups.sources.find((s) => s.id === id)?.name ?? c.none;
  const usedSources = new Set(expense.allocations.map((a) => a.sourceId));
  const available = lookups.sources.filter((s) => s.isActive && !usedSources.has(s.id));

  const save = (srcId: string, value: number) =>
    run(() => budgetCall<Expense>("set_allocation", { expenseId: expense.id, sourceId: srcId, amount: value }), c.saved).then((r) => {
      onChange(r);
      if (r) {
        setAdding(false);
        setEditing(null);
        setText("");
        setAmount(null);
      }
    });

  return (
    <SectionCard
      title={t.funding}
      actions={canManage && expense.total !== null && available.length > 0 && !adding ? (
        <Button size="sm" variant="secondary" onClick={() => { setAdding(true); setSourceId(available[0]?.id ?? ""); }}>
          <Plus className="size-4" />
          {t.addAllocation}
        </Button>
      ) : undefined}
    >
      <FundingSummary expense={expense} />
      <ul className="divide-y divide-slate-100" data-testid="allocations">
        {expense.allocations.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0 space-y-1">
              <p className="font-semibold text-slate-800">{sourceName(a.sourceId)}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                <KindBadge kind={a.kind} />
                <PaymentBadge status={a.paymentStatus} />
                <span>{t.paid}: <Money value={a.paid} /></span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Money value={a.amount} className="font-bold" />
              {canManage && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(a); setText(agorotToInput(a.amount)); setAmount(a.amount); }}>
                    {c.edit}
                  </Button>
                  <button
                    className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent"
                    aria-label={t.removeAllocation}
                    disabled={busy}
                    onClick={() => void run(() => budgetCall<Expense>("remove_allocation", { allocationId: a.id }), c.saved).then(onChange)}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </>
              )}
            </div>
            {editing?.id === a.id && (
              <form className="flex w-full flex-wrap items-end gap-2" onSubmit={(ev) => {
                ev.preventDefault();
                if (amount !== null && amount > 0) void save(a.sourceId, amount);
              }}>
                <div className="min-w-40 flex-1">
                  <Field label={c.amount}><MoneyInput value={text} onChange={(v, n) => { setText(v); setAmount(n); }} /></Field>
                </div>
                <Button type="submit" loading={busy} disabled={amount === null || amount <= 0}>{c.save}</Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>{c.cancel}</Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <form className="mt-3 grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end" onSubmit={(ev) => {
          ev.preventDefault();
          if (sourceId && amount !== null && amount > 0) void save(sourceId, amount);
        }}>
          <Field label={t.source}>
            <Select value={sourceId} onChange={(ev) => setSourceId(ev.target.value)}>
              {available.map((s) => (
                <option key={s.id} value={s.id}>{s.name} · {BUDGET_TEXT.kinds[s.kind]}</option>
              ))}
            </Select>
          </Field>
          <Field label={c.amount}>
            <MoneyInput value={text} onChange={(v, n) => { setText(v); setAmount(n); }} placeholder={agorotToInput(expense.facts.unfunded)} />
          </Field>
          <Button type="submit" loading={busy} disabled={!sourceId || amount === null || amount <= 0}>{c.add}</Button>
          <Button type="button" variant="ghost" onClick={() => setAdding(false)}>{c.cancel}</Button>
        </form>
      )}
    </SectionCard>
  );
}

/** Budget Stage 5: the funding picture as the server computed it (one
 * calculation layer) - the uncovered balance is shown, never filled. */
function FundingSummary({ expense }: { expense: Expense }) {
  const f = expense.funding;
  const p = BUDGET_TEXT.party;
  const hasParty = expense.allocations.some((a) => a.kind === "party");
  const gap = f.uncovered > 0 && expense.status !== "cancelled";
  const tiles: { label: string; value: number | null; testId: string }[] = [
    { label: p.expenseTotal, value: f.total, testId: "funding-total" },
    ...(hasParty ? [{ label: p.partyPreapproved, value: f.partyPreapproved, testId: "funding-preapproved" }] : []),
    { label: p.partyFunding, value: f.party, testId: "funding-party" },
    { label: p.donationFunding, value: f.donation, testId: "funding-donation" },
    { label: p.personalFunding, value: f.personal, testId: "funding-personal" },
  ];
  return (
    <div className="mb-3 space-y-2" data-testid="funding-summary">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tiles.map((x) => (
          <div key={x.testId} className="rounded-xl bg-slate-50 px-3 py-2" data-testid={x.testId}>
            <dt className="text-xs text-slate-500">{x.label}</dt>
            <dd className="font-bold text-slate-800">{x.value === null ? c.none : <Money value={x.value} />}</dd>
          </div>
        ))}
        <div className={gap ? "rounded-xl bg-potential-soft px-3 py-2" : "rounded-xl bg-supporter-soft px-3 py-2"} data-testid="funding-uncovered">
          <dt className="text-xs text-slate-600">{p.uncovered}</dt>
          <dd className={gap ? "font-extrabold text-amber-900" : "font-bold text-emerald-800"}><Money value={f.uncovered} /></dd>
        </div>
      </dl>
      {gap ? (
        <p role="alert" className="rounded-xl bg-potential-soft px-3 py-2 text-sm font-semibold text-amber-900">{p.gapWarning}</p>
      ) : f.total !== null && expense.status !== "cancelled" ? (
        <p className="text-xs text-slate-500">{p.gapNone}</p>
      ) : null}
    </div>
  );
}
