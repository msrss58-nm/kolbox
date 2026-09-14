import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Plus, Receipt } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { BUDGET_ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { BUDGET_TEXT } from "./budget.constants";
import {
  budgetCall,
  type BudgetCategory,
  type Expense,
  type ExpenseList,
  type ExpenseStatus,
  type FundingSource,
  type Supplier,
} from "./budgetClient";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { ExpenseStatusBadge, LoadError, Money, MoneyInput, PaymentBadge, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.expenses;
const c = BUDGET_TEXT.common;
const QUEUES = Object.keys(t.queues) as (keyof typeof t.queues)[];
const STATUSES = Object.keys(BUDGET_TEXT.expenseStatus) as ExpenseStatus[];
const PAGE_SIZE = 50;

interface Lookups {
  categories: BudgetCategory[];
  suppliers: Supplier[];
  sources: FundingSource[];
}

/** The expense list. Filters live in the URL, so a dashboard number (Stage
 * 6) can deep-link to exactly the list it counts. */
export function BudgetExpensesPage() {
  const session = useBudgetSession((s) => s.session);
  const canManage = budgetCan(session, "budget.manageExpenses");
  const [params, setParams] = useSearchParams();
  const [searchText, setSearchText] = useState(params.get("search") ?? "");
  const search = useDebouncedValue(searchText, 300);
  const [creating, setCreating] = useState(false);

  const filters = useMemo(
    () => ({
      status: params.get("status") ?? "",
      categoryId: params.get("categoryId") ?? "",
      supplierId: params.get("supplierId") ?? "",
      sourceId: params.get("sourceId") ?? "",
      queue: params.get("queue") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
      offset: Number(params.get("offset") ?? 0) || 0,
    }),
    [params],
  );
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("offset");
    setParams(next, { replace: true });
  };

  const fetchLookups = useCallback(async (): Promise<Lookups> => {
    const [categories, suppliers, sources] = await Promise.all([
      budgetCall<BudgetCategory[]>("list_categories"),
      budgetCall<Supplier[]>("list_suppliers"),
      budgetCall<FundingSource[]>("list_sources"),
    ]);
    return { categories, suppliers, sources };
  }, []);
  const lookups = useAsyncData(fetchLookups);

  const fetchList = useCallback(() => {
    const args: Record<string, unknown> = { limit: PAGE_SIZE, offset: filters.offset };
    for (const k of ["status", "categoryId", "supplierId", "sourceId", "queue", "from", "to"] as const) {
      if (filters[k]) args[k] = filters[k];
    }
    if (search.trim()) args.search = search.trim();
    return budgetCall<ExpenseList>("list_expenses", args);
  }, [filters, search]);
  const list = useAsyncData(fetchList);

  const supplierName = (id: string | null) => lookups.data?.suppliers.find((s) => s.id === id)?.businessName ?? c.none;
  const categoryName = (id: string | null) => lookups.data?.categories.find((x) => x.id === id)?.name ?? c.none;
  const hasFilters = QUEUES.some(() => false) || Object.entries(filters).some(([k, v]) => k !== "offset" && v) || search.trim() !== "";

  return (
    <div className="space-y-4">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)} data-testid="new-expense">
              <Plus className="size-4" />
              {t.newExpense}
            </Button>
          ) : undefined
        }
      />

      <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          type="search"
          value={searchText}
          onChange={(e) => {
            setSearchText(e.target.value);
            setFilter("search", "");
          }}
          placeholder={c.search}
          aria-label={c.search}
        />
        <Select value={filters.queue} onChange={(e) => setFilter("queue", e.target.value)} aria-label={t.filterQueue}>
          <option value="">{t.filterQueue}: {c.all}</option>
          {QUEUES.map((q) => (
            <option key={q} value={q}>
              {t.queues[q]}
            </option>
          ))}
        </Select>
        <Select value={filters.status} onChange={(e) => setFilter("status", e.target.value)} aria-label={t.status}>
          <option value="">{t.status}: {c.all}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {BUDGET_TEXT.expenseStatus[s]}
            </option>
          ))}
        </Select>
        <Select value={filters.categoryId} onChange={(e) => setFilter("categoryId", e.target.value)} aria-label={t.category}>
          <option value="">{t.category}: {c.all}</option>
          {lookups.data?.categories.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
        <Select value={filters.supplierId} onChange={(e) => setFilter("supplierId", e.target.value)} aria-label={t.supplier}>
          <option value="">{t.supplier}: {c.all}</option>
          {lookups.data?.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.businessName}
            </option>
          ))}
        </Select>
        <Select value={filters.sourceId} onChange={(e) => setFilter("sourceId", e.target.value)} aria-label={BUDGET_TEXT.expense.source}>
          <option value="">{BUDGET_TEXT.expense.source}: {c.all}</option>
          {lookups.data?.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input type="date" value={filters.from} onChange={(e) => setFilter("from", e.target.value)} aria-label={c.date} />
        <Input type="date" value={filters.to} onChange={(e) => setFilter("to", e.target.value)} aria-label={c.date} />
      </Card>

      {list.error && <LoadError onRetry={list.reload} />}

      {!list.data && !list.error ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-16 rounded-2xl" />
          ))}
        </div>
      ) : list.data && list.data.rows.length === 0 ? (
        <EmptyState icon={Receipt} title={hasFilters ? t.noResults : t.empty} hint={hasFilters ? undefined : t.emptyHint} />
      ) : list.data ? (
        <>
          <p className="text-sm text-slate-500" data-testid="expense-total">
            {t.totalFiltered}: {list.data.total} · <Money value={list.data.totalAmount} />
          </p>
          <ul className="space-y-2 md:hidden" data-testid="expense-cards">
            {list.data.rows.map((r) => (
              <li key={r.id}>
                <Link to={`${BUDGET_ROUTES.expenses}/${r.id}`} className="block">
                  <Card className="space-y-1.5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 truncate font-bold text-slate-800">{r.description}</p>
                      <Money value={r.total} className="shrink-0 font-bold" />
                    </div>
                    <p className="truncate text-xs text-slate-500">
                      #{r.referenceNo} · {supplierName(r.supplierId)} · {categoryName(r.categoryId)}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <ExpenseStatusBadge status={r.status} />
                      <PaymentBadge status={r.paymentStatus} />
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm" data-testid="expense-table">
              <thead>
                <tr className="border-b border-slate-100 text-xs text-slate-500">
                  <th className="px-3 py-2.5 text-start font-semibold">{t.reference}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{c.date}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{t.description}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{t.supplier}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{t.category}</th>
                  <th className="px-3 py-2.5 text-end font-semibold">{BUDGET_TEXT.expense.allocated}</th>
                  <th className="px-3 py-2.5 text-end font-semibold">{c.amount}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{t.status}</th>
                  <th className="px-3 py-2.5 text-start font-semibold">{t.payment}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-3 py-2.5 text-slate-500">
                      <Link to={`${BUDGET_ROUTES.expenses}/${r.id}`} className="font-semibold text-primary-700 hover:underline">
                        #{r.referenceNo}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{r.expenseDate ?? c.none}</td>
                    <td className="max-w-64 truncate px-3 py-2.5 font-semibold text-slate-800">
                      <Link to={`${BUDGET_ROUTES.expenses}/${r.id}`}>{r.description}</Link>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5">{supplierName(r.supplierId)}</td>
                    <td className="px-3 py-2.5">{categoryName(r.categoryId)}</td>
                    <td className="px-3 py-2.5 text-end">
                      <Money value={r.allocated} />
                      {r.unfunded > 0 && <span className="block text-xs text-rose-600">−<Money value={r.unfunded} /></span>}
                    </td>
                    <td className="px-3 py-2.5 text-end font-bold"><Money value={r.total} /></td>
                    <td className="px-3 py-2.5"><ExpenseStatusBadge status={r.status} /></td>
                    <td className="px-3 py-2.5"><PaymentBadge status={r.paymentStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          {list.data.total > PAGE_SIZE && (
            <div className="flex justify-center gap-2">
              <Button variant="secondary" size="sm" disabled={filters.offset === 0}
                onClick={() => setFilter("offset", String(Math.max(0, filters.offset - PAGE_SIZE)))}>‹</Button>
              <Button variant="secondary" size="sm" disabled={filters.offset + PAGE_SIZE >= list.data.total}
                onClick={() => setFilter("offset", String(filters.offset + PAGE_SIZE))}>›</Button>
            </div>
          )}
        </>
      ) : null}

      {creating && lookups.data && <NewExpenseDialog lookups={lookups.data} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewExpenseDialog({ lookups, onClose }: { lookups: Lookups; onClose: () => void }) {
  const navigate = useNavigate();
  const [description, setDescription] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [totalText, setTotalText] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [expenseDate, setExpenseDate] = useState("");
  const { run, busy } = useBudgetAction();
  const valid = description.trim() !== "" && (totalText === "" || (total !== null && total > 0));
  return (
    <Modal open onClose={onClose} title={t.newExpense} wide>
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const args: Record<string, unknown> = { description: description.trim() };
          if (supplierId) args.supplierId = supplierId;
          if (categoryId) args.categoryId = categoryId;
          if (total !== null) args.total = total;
          if (expenseDate) args.expenseDate = expenseDate;
          void run(() => budgetCall<Expense>("create_expense", args)).then((exp) => {
            if (exp) navigate(`${BUDGET_ROUTES.expenses}/${exp.id}`);
          });
        }}
      >
        <div className="sm:col-span-2">
          <Field label={t.description}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} required />
          </Field>
        </div>
        <Field label={t.supplier}>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">{c.none}</option>
            {lookups.suppliers.filter((s) => s.isActive).map((s) => (
              <option key={s.id} value={s.id}>
                {s.businessName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.category}>
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{c.none}</option>
            {lookups.categories.filter((x) => x.isActive).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.total}>
          <MoneyInput value={totalText} onChange={(v, a) => { setTotalText(v); setTotal(a); }} />
        </Field>
        <Field label={t.expenseDate}>
          <Input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" className="w-full" loading={busy} disabled={!valid}>
            {c.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
