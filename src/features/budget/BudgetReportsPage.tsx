import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { FileBarChart2, Lock } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { BUDGET_ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import {
  budgetCall,
  type BudgetCategory,
  type CategoryReport,
  type CategoryReportRow,
  type ExpenseReport,
  type ExpenseReportRow,
  type FundingSource,
  type PartyReport,
  type PartyReportRow,
  type PaymentReport,
  type PaymentReportRow,
  type PlanReport,
  type PlanReportRow,
  type SourceReport,
  type SourceReportRow,
  type Supplier,
  type SupplierReport,
  type SupplierReportRow,
} from "./budgetClient";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { ExpenseStatusBadge, KindBadge, LoadError, Money, PaymentBadge, SubmissionBadge } from "./budgetUi";

const t = BUDGET_TEXT.reports;
const c = BUDGET_TEXT.common;
const PAGE = 50;

type ReportKey = "expenses" | "categories" | "sources" | "suppliers" | "party" | "plan" | "payments";
const REPORTS: ReportKey[] = ["expenses", "categories", "sources", "suppliers", "party", "plan", "payments"];
const OPS: Record<ReportKey, string> = {
  expenses: "report_expenses",
  categories: "report_categories",
  sources: "report_sources",
  suppliers: "report_suppliers",
  party: "report_party",
  plan: "report_plan",
  payments: "report_payments",
};
const PAGED = new Set<ReportKey>(["expenses", "suppliers", "party", "payments"]);

type FilterKey =
  | "from" | "to" | "status" | "categoryId" | "supplierId" | "sourceId" | "paymentStatus" | "docReadiness"
  | "workflowState" | "search" | "kind" | "attention" | "active" | "docsExpiring" | "payer" | "state";
/** Only filters with a business meaning for each report (the server validates
 * every value again). */
const FILTERS: Record<ReportKey, FilterKey[]> = {
  expenses: ["from", "to", "status", "categoryId", "supplierId", "sourceId", "paymentStatus", "docReadiness", "workflowState", "search"],
  categories: ["from", "to", "status", "supplierId", "sourceId"],
  sources: ["kind", "attention"],
  suppliers: ["search", "active", "docsExpiring"],
  party: ["from", "to", "supplierId", "categoryId", "workflowState", "paymentStatus", "docReadiness"],
  plan: ["attention"],
  payments: ["from", "to", "supplierId", "sourceId", "payer", "state"],
};

interface Lookups {
  categories: BudgetCategory[];
  suppliers: Supplier[];
  sources: FundingSource[];
  period: { start: string | null; end: string | null };
}

interface Col<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  end?: boolean;
}

const qs = (o: Record<string, string | null | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => Boolean(e[1]))).toString();

/** Budget Stage 6: the reports. Every figure comes from a server report op on
 * the shared calculation layer; totals cover the whole filtered set, lists
 * are paged server-side, and rows drill into the underlying records. */
export function BudgetReportsPage() {
  const session = useBudgetSession((s) => s.session);
  const canReports = budgetCan(session, "budget.viewReports");
  const [params, setParams] = useSearchParams();
  const report = (REPORTS as string[]).includes(params.get("report") ?? "") ? (params.get("report") as ReportKey) : "expenses";
  const offset = Number(params.get("offset") ?? 0) || 0;
  const [searchText, setSearchText] = useState(params.get("search") ?? "");
  const search = useDebouncedValue(searchText, 300);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "offset") next.delete("offset");
    setParams(next, { replace: true });
  };
  const switchReport = (r: ReportKey) => setParams(new URLSearchParams({ report: r }), { replace: true });

  const fetchLookups = useCallback(async (): Promise<Lookups> => {
    const [categories, suppliers, sources, settings] = await Promise.all([
      budgetCall<BudgetCategory[]>("list_categories"),
      budgetCall<Supplier[]>("list_suppliers"),
      budgetCall<FundingSource[]>("list_sources"),
      budgetCall<{ periodStart: string | null; periodEnd: string | null }>("get_settings"),
    ]);
    return { categories, suppliers, sources, period: { start: settings.periodStart, end: settings.periodEnd } };
  }, []);
  const lookups = useAsyncData(fetchLookups);

  const args = useMemo(() => {
    const a: Record<string, unknown> = {};
    for (const k of FILTERS[report]) {
      const v = k === "search" ? search.trim() : params.get(k);
      if (!v) continue;
      a[k] = k === "docsExpiring" ? true : v;
    }
    if (PAGED.has(report)) {
      a.limit = PAGE;
      a.offset = offset;
    }
    return a;
  }, [report, params, search, offset]);
  const argsKey = JSON.stringify(args);
  // Each result is tagged with its report: while a newly selected tab loads,
  // the previous tab's data (a different shape) is never rendered by the new
  // tab's renderer.
  const fetchReport = useCallback(
    async () => (canReports
      ? { report, rows: await budgetCall<unknown>(OPS[report], JSON.parse(argsKey) as Record<string, unknown>) }
      : null),
    [canReports, report, argsKey],
  );
  const data = useAsyncData(fetchReport);
  const current = data.data?.report === report ? data.data.rows : null;

  if (!canReports) {
    return (
      <div className="space-y-4">
        <PageHeader title={t.title} subtitle={t.subtitle} />
        <Card className="p-6" data-testid="reports-forbidden">
          <EmptyState icon={Lock} title={t.forbidden} hint={t.forbiddenHint} />
        </Card>
      </div>
    );
  }

  const carry = (extra: Record<string, string | null | undefined>) =>
    `${BUDGET_ROUTES.expenses}?${qs({ from: params.get("from"), to: params.get("to"), status: params.get("status"), ...extra })}`;

  return (
    <div className="space-y-4">
      <PageHeader title={t.title} subtitle={t.subtitle} />

      <div className="-mx-1 overflow-x-auto px-1" role="tablist" data-testid="report-tabs">
        <div className="flex w-max gap-1.5">
          {REPORTS.map((r) => (
            <button key={r} role="tab" aria-selected={r === report} data-report={r} onClick={() => switchReport(r)}
              className={cn("min-h-11 whitespace-nowrap rounded-xl px-3.5 text-sm font-semibold ring-1",
                r === report ? "bg-primary-600 text-white ring-primary-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50")}>
              {t.tabs[r]}
            </button>
          ))}
        </div>
      </div>

      <Card className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="report-filters">
        {FILTERS[report].map((k) => (
          <FilterControl key={k} name={k} report={report} value={k === "search" ? searchText : params.get(k) ?? ""}
            lookups={lookups.data} onChange={(v) => (k === "search" ? setSearchText(v) : setParam(k, v))} />
        ))}
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS[report].includes("from") && lookups.data && (lookups.data.period.start || lookups.data.period.end) && (
            <Button size="sm" variant="secondary" data-testid="filter-period" onClick={() => {
              const next = new URLSearchParams(params);
              for (const [k, v] of [["from", lookups.data!.period.start], ["to", lookups.data!.period.end]] as const) {
                if (v) next.set(k, v);
                else next.delete(k);
              }
              next.delete("offset");
              setParams(next, { replace: true });
            }}>
              {t.f.period}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setSearchText(""); switchReport(report); }}>{t.f.clear}</Button>
        </div>
      </Card>

      {data.error && <LoadError onRetry={data.reload} />}
      {!current && !data.error ? (
        <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14 rounded-2xl" />)}</div>
      ) : current ? (
        <ReportBody report={report} data={current} carry={carry} onPage={(o) => setParam("offset", String(o))} />
      ) : null}
    </div>
  );
}

function FilterControl({ name, report, value, lookups, onChange }: {
  name: FilterKey;
  report: ReportKey;
  value: string;
  lookups: Lookups | null;
  onChange: (v: string) => void;
}) {
  const f = t.f;
  const select = (label: string, options: [string, string][]) => (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} data-filter={name}>
      <option value="">{label}: {c.all}</option>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
  );
  switch (name) {
    case "from":
    case "to":
      return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} aria-label={f[name]} data-filter={name} />;
    case "search":
      return <Input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.search} aria-label={f.search} data-filter={name} />;
    case "status":
      return select(BUDGET_TEXT.expenses.status, Object.entries(BUDGET_TEXT.expenseStatus));
    case "categoryId":
      return select(BUDGET_TEXT.expenses.category, (lookups?.categories ?? []).map((x) => [x.id, x.name]));
    case "supplierId":
      return select(BUDGET_TEXT.expenses.supplier, (lookups?.suppliers ?? []).map((x) => [x.id, x.businessName]));
    case "sourceId":
      return select(BUDGET_TEXT.expense.source, (lookups?.sources ?? []).map((x) => [x.id, x.name]));
    case "paymentStatus":
      return select(f.paymentStatus, Object.entries(BUDGET_TEXT.paymentStatus));
    case "docReadiness":
      return select(f.docReadiness, [["ready", f.docsReady], ["missing", f.docsMissing]]);
    case "workflowState":
      return select(f.workflowState, Object.entries(BUDGET_TEXT.submissionState));
    case "kind":
      return select(f.kind, Object.entries(BUDGET_TEXT.kinds));
    case "attention":
      return select(f.attention, report === "plan" ? [["overrun", f.overrun], ["warning", f.warning]] : [["overrun", f.overrun]]);
    case "active":
      return select(f.active, [["active", f.activeOnly], ["inactive", f.inactiveOnly]]);
    case "payer":
      return select(f.payer, Object.entries(BUDGET_TEXT.payer));
    case "state":
      return select(f.state, [["active", f.stateActive], ["voided", f.stateVoided]]);
    case "docsExpiring":
      return (
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="size-4" checked={value === "1"} onChange={(e) => onChange(e.target.checked ? "1" : "")} data-filter={name} />
          {f.docsExpiring}
        </label>
      );
  }
}

function ReportBody({ report, data, carry, onPage }: {
  report: ReportKey;
  data: unknown;
  carry: (extra: Record<string, string | null | undefined>) => string;
  onPage: (offset: number) => void;
}) {
  const col = t.col;
  const expenseLink = (id: string, ref: number) => (
    <Link to={`${BUDGET_ROUTES.expenses}/${id}`} className="font-semibold text-primary-700 hover:underline">#{ref}</Link>
  );
  const docs = (ready: boolean | null, missing: number | null) =>
    ready === null ? c.none : ready ? <span className="text-emerald-700">{t.docsOk}</span> : <span className="text-amber-800">{t.docsMissing(missing ?? 0)}</span>;
  const money = (v: number | null | undefined) => <Money value={v} />;

  switch (report) {
    case "expenses": {
      const d = data as ExpenseReport;
      const cols: Col<ExpenseReportRow>[] = [
        { key: "ref", label: col.reference, render: (r) => expenseLink(r.id, r.referenceNo) },
        { key: "date", label: col.date, render: (r) => r.expenseDate ?? c.none },
        { key: "description", label: col.description, render: (r) => r.description },
        { key: "category", label: col.category, render: (r) => r.categoryName ?? c.none },
        { key: "supplier", label: col.supplier, render: (r) => r.supplierName ?? c.none },
        { key: "total", label: col.total, render: (r) => money(r.total), end: true },
        { key: "allocated", label: col.allocated, render: (r) => money(r.allocated), end: true },
        { key: "unfunded", label: col.unfunded, render: (r) => (r.unfunded > 0 ? <span className="text-rose-600">{money(r.unfunded)}</span> : money(0)), end: true },
        { key: "paid", label: col.paid, render: (r) => money(r.paid), end: true },
        { key: "outstanding", label: col.outstanding, render: (r) => money(r.outstanding), end: true },
        { key: "status", label: col.status, render: (r) => <ExpenseStatusBadge status={r.status} /> },
        { key: "payment", label: col.payment, render: (r) => <PaymentBadge status={r.paymentStatus} /> },
        { key: "party", label: col.party, render: (r) => (r.partyState ? <SubmissionBadge state={r.partyState} /> : c.none) },
        { key: "docs", label: col.docs, render: (r) => docs(r.docsReady, r.missingCount) },
      ];
      return (
        <>
          <Totals items={[[t.count, d.total], [col.total, d.totals.amount, true], [col.committed, d.totals.committed, true],
            [col.actual, d.totals.actual, true], [col.allocated, d.totals.allocated, true], [col.unfunded, d.totals.unfunded, true],
            [col.paid, d.totals.paid, true], [col.outstanding, d.totals.outstanding, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.id} rowHref={(r) => `${BUDGET_ROUTES.expenses}/${r.id}`} />
          <Pager total={d.total} offset={d.offset} limit={d.limit} onPage={onPage} />
        </>
      );
    }
    case "categories": {
      const d = data as CategoryReport;
      const cols: Col<CategoryReportRow>[] = [
        { key: "name", label: col.category, render: (r) => (r.categoryId
          ? <Link to={carry({ categoryId: r.categoryId })} className="font-semibold text-primary-700 hover:underline">{r.name}</Link>
          : t.noCategory) },
        { key: "expenses", label: col.expenses, render: (r) => r.expenses, end: true },
        { key: "committed", label: col.committed, render: (r) => money(r.committed), end: true },
        { key: "actual", label: col.actual, render: (r) => money(r.actual), end: true },
        { key: "draft", label: col.draft, render: (r) => money(r.draft), end: true },
        { key: "paid", label: col.paid, render: (r) => money(r.paid), end: true },
        { key: "outstanding", label: col.outstanding, render: (r) => money(r.outstanding), end: true },
      ];
      return (
        <>
          <Totals items={[[col.expenses, d.totals.expenses], [col.committed, d.totals.committed, true], [col.actual, d.totals.actual, true],
            [col.draft, d.totals.draft, true], [col.paid, d.totals.paid, true], [col.outstanding, d.totals.outstanding, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.categoryId ?? "none"}
            rowHref={(r) => (r.categoryId ? carry({ categoryId: r.categoryId }) : null)} />
        </>
      );
    }
    case "sources": {
      const d = data as SourceReport;
      const cols: Col<SourceReportRow>[] = [
        { key: "name", label: col.source, render: (r) => (
          <Link to={`${BUDGET_ROUTES.expenses}?sourceId=${r.sourceId}`} className="font-semibold text-primary-700 hover:underline">{r.name}</Link>) },
        { key: "kind", label: t.f.kind, render: (r) => <KindBadge kind={r.kind} /> },
        { key: "active", label: col.active, render: (r) => (r.isActive ? t.yes : t.no) },
        { key: "current", label: col.current, render: (r) => money(r.currentAmount), end: true },
        { key: "committed", label: col.committed, render: (r) => money(r.committed), end: true },
        { key: "actual", label: col.actual, render: (r) => money(r.actual), end: true },
        { key: "remaining", label: col.remaining, render: (r) => <span className={r.overrun ? "font-bold text-rose-600" : ""}>{money(r.remaining)}</span>, end: true },
        { key: "paid", label: col.paid, render: (r) => money(r.paid), end: true },
      ];
      return (
        <>
          <Totals items={[[col.current, d.totals.currentAmount, true], [col.committed, d.totals.committed, true],
            [col.actual, d.totals.actual, true], [col.allocated, d.totals.allocated, true], [col.paid, d.totals.paid, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.sourceId} rowHref={(r) => `${BUDGET_ROUTES.expenses}?sourceId=${r.sourceId}`} />
        </>
      );
    }
    case "suppliers": {
      const d = data as SupplierReport;
      const cols: Col<SupplierReportRow>[] = [
        { key: "name", label: col.supplier, render: (r) => (
          <Link to={`${BUDGET_ROUTES.expenses}?supplierId=${r.supplierId}`} className="font-semibold text-primary-700 hover:underline">{r.name}</Link>) },
        { key: "active", label: col.active, render: (r) => (r.isActive ? t.yes : t.no) },
        { key: "expenses", label: col.expenses, render: (r) => r.expenses, end: true },
        { key: "amount", label: col.amount, render: (r) => money(r.amount), end: true },
        { key: "partyAllocated", label: col.partyAllocated, render: (r) => money(r.partyAllocated), end: true },
        { key: "paid", label: col.paid, render: (r) => money(r.paid), end: true },
        { key: "partyOutstanding", label: col.partyOutstanding, render: (r) => money(r.partyOutstanding), end: true },
        { key: "outstanding", label: col.outstanding, render: (r) => money(r.outstanding), end: true },
        { key: "bank", label: col.bank, render: (r) => (
          <span className={r.docsExpiring ? "font-semibold text-amber-800" : ""}>
            {r.hasBankConfirmation ? (r.bankConfirmationValidUntil ? t.validUntil(r.bankConfirmationValidUntil) : t.noExpiry) : c.none}
            {r.docsExpiring ? ` · ${t.expiring}` : ""}
          </span>) },
        { key: "bankOnFile", label: col.bankOnFile, render: (r) => (r.bankOnFile ? t.yes : t.no) },
      ];
      return (
        <>
          <Totals items={[[t.count, d.total], [col.amount, d.totals.amount, true], [col.partyAllocated, d.totals.partyAllocated, true],
            [col.paid, d.totals.paid, true], [col.partyOutstanding, d.totals.partyOutstanding, true], [col.outstanding, d.totals.outstanding, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.supplierId} rowHref={(r) => `${BUDGET_ROUTES.expenses}?supplierId=${r.supplierId}`} />
          <Pager total={d.total} offset={d.offset} limit={d.limit} onPage={onPage} />
        </>
      );
    }
    case "party": {
      const d = data as PartyReport;
      const cols: Col<PartyReportRow>[] = [
        { key: "ref", label: col.reference, render: (r) => expenseLink(r.expenseId, r.referenceNo) },
        { key: "description", label: col.description, render: (r) => r.description },
        { key: "supplier", label: col.supplier, render: (r) => r.supplierName ?? c.none },
        { key: "state", label: col.party, render: (r) => <SubmissionBadge state={r.workflowState} /> },
        { key: "preapproval", label: col.preapproval, render: (r) => (r.hasPreapproval
          ? <>{r.preapprovalCode}{r.preapprovedAmount !== null && <> · {money(r.preapprovedAmount)}</>}</> : c.none) },
        { key: "reference", label: col.reference2, render: (r) => (r.hasReference
          ? <>{r.referenceNumber} · {money(r.authorizedAmount)}</> : c.none) },
        { key: "attempts", label: col.attempts, render: (r) => r.attempts, end: true },
        { key: "amount", label: col.partyAllocated, render: (r) => money(r.amount), end: true },
        { key: "paid", label: col.partyPaid, render: (r) => money(r.paid), end: true },
        { key: "remaining", label: col.remaining, render: (r) => money(r.remaining), end: true },
        { key: "payment", label: col.payment, render: (r) => <PaymentBadge status={r.paymentStatus} /> },
        { key: "docs", label: col.docs, render: (r) => docs(r.docsReady, r.missingCount) },
      ];
      return (
        <>
          <Totals items={[[t.count, d.total], [col.partyAllocated, d.totals.amount, true], [col.partyPaid, d.totals.paid, true],
            [col.remaining, d.totals.remaining, true], [col.preapproval, d.totals.preapproved, true], [col.reference2, d.totals.authorized, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.allocationId} rowHref={(r) => `${BUDGET_ROUTES.expenses}/${r.expenseId}`} />
          <Pager total={d.total} offset={d.offset} limit={d.limit} onPage={onPage} />
        </>
      );
    }
    case "plan": {
      const d = data as PlanReport;
      const cols: Col<PlanReportRow>[] = [
        { key: "name", label: col.category, render: (r) => (
          <Link to={`${BUDGET_ROUTES.expenses}?statusGroup=obligations&categoryId=${r.categoryId}`} className="font-semibold text-primary-700 hover:underline">{r.name}</Link>) },
        { key: "plan", label: col.plan, render: (r) => money(r.plan), end: true },
        { key: "committed", label: col.committed, render: (r) => money(r.committed), end: true },
        { key: "actual", label: col.actual, render: (r) => money(r.actual), end: true },
        { key: "remaining", label: col.remaining, render: (r) => <span className={r.remaining < 0 ? "font-bold text-rose-600" : ""}>{money(r.remaining)}</span>, end: true },
        { key: "variance", label: col.variance, render: (r) => money(r.variance), end: true },
        { key: "pct", label: col.pctUsed, render: (r) => (r.pctUsed === null ? c.none : `${r.pctUsed}%`), end: true },
        { key: "state", label: col.state, render: (r) => (
          <span className={cn("inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold",
            r.state === "overrun" ? "bg-opponent-soft text-rose-800" : r.state === "warning" ? "bg-potential-soft text-amber-800"
              : r.state === "no_plan" ? "bg-slate-100 text-slate-600" : "bg-supporter-soft text-emerald-800")} data-state={r.state}>
            {t.planStates[r.state]}
          </span>) },
      ];
      return (
        <>
          <Totals items={[[t.budgetStrip.totalBudget, d.budget.totalBudget, true], [t.budgetStrip.planned, d.budget.plannedInCategories, true],
            [t.budgetStrip.unallocated, d.budget.unallocatedPlan, true], [t.budgetStrip.available, d.budget.available, true],
            [col.plan, d.totals.plan, true], [col.used, d.totals.used, true], [col.remaining, d.totals.remaining, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.categoryId}
            rowHref={(r) => `${BUDGET_ROUTES.expenses}?statusGroup=obligations&categoryId=${r.categoryId}`} />
        </>
      );
    }
    case "payments": {
      const d = data as PaymentReport;
      const cols: Col<PaymentReportRow>[] = [
        { key: "date", label: col.date, render: (r) => r.paymentDate },
        { key: "amount", label: col.total, render: (r) => <span className={r.state === "voided" ? "line-through opacity-60" : "font-semibold"}>{money(r.amount)}</span>, end: true },
        { key: "state", label: col.state, render: (r) => (r.state === "voided"
          ? <span className="text-rose-700">{t.paymentStates.voided}{r.voidReason ? ` · ${r.voidReason}` : ""}</span> : t.paymentStates.active) },
        { key: "payer", label: col.payer, render: (r) => BUDGET_TEXT.payer[r.payer] },
        { key: "source", label: col.source, render: (r) => r.sourceName },
        { key: "supplier", label: col.supplier, render: (r) => r.supplierName ?? c.none },
        { key: "expense", label: col.reference, render: (r) => expenseLink(r.expenseId, r.referenceNo) },
        { key: "ext", label: col.extRef, render: (r) => r.externalReference ?? c.none },
        { key: "partyRemaining", label: col.partyRemaining, render: (r) => (r.partyRemaining === null ? c.none : money(r.partyRemaining)), end: true },
      ];
      return (
        <>
          <Totals items={[[t.count, d.total], [t.activeAmount, d.totals.activeAmount, true], [t.voidedAmount, d.totals.voidedAmount, true]]} />
          <ReportTable cols={cols} rows={d.rows} rowKey={(r) => r.paymentId} rowHref={(r) => `${BUDGET_ROUTES.expenses}/${r.expenseId}`} />
          <Pager total={d.total} offset={d.offset} limit={d.limit} onPage={onPage} />
        </>
      );
    }
  }
}

function Totals({ items }: { items: [string, number, boolean?][] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="report-totals">
      {items.map(([label, value, isMoney]) => (
        <div key={label} className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200" data-total={label}>
          <p className="truncate text-xs text-slate-500">{label}</p>
          <p className="font-bold text-slate-800">{isMoney ? <Money value={value} /> : value}</p>
        </div>
      ))}
    </div>
  );
}

function ReportTable<T>({ cols, rows, rowKey, rowHref }: {
  cols: Col<T>[];
  rows: T[];
  rowKey: (r: T) => string;
  rowHref: (r: T) => string | null;
}) {
  if (rows.length === 0) return <EmptyState icon={FileBarChart2} title={t.noResults} dense />;
  return (
    <>
      <ul className="space-y-2 md:hidden" data-testid="report-cards">
        {rows.map((r) => {
          const href = rowHref(r);
          return (
            <li key={rowKey(r)}>
              <Card className="p-3.5">
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                  {cols.map((cl) => (
                    <Fragment key={cl.key}>
                      <dt className="text-slate-500">{cl.label}</dt>
                      <dd className="min-w-0 break-words text-end font-semibold text-slate-800">{cl.render(r)}</dd>
                    </Fragment>
                  ))}
                </dl>
                {href && (
                  <Link to={href} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-primary-700">{t.open}</Link>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm" data-testid="report-table">
          <thead>
            <tr className="border-b border-slate-100 text-xs text-slate-500">
              {cols.map((cl) => (
                <th key={cl.key} className={cn("whitespace-nowrap px-3 py-2.5 font-semibold", cl.end ? "text-end" : "text-start")}>{cl.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={rowKey(r)} className="hover:bg-slate-50" data-testid="report-row">
                {cols.map((cl) => (
                  <td key={cl.key} className={cn("max-w-64 truncate px-3 py-2.5", cl.end && "text-end tabular-nums")}>{cl.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Pager({ total, offset, limit, onPage }: { total: number; offset: number; limit: number; onPage: (o: number) => void }) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-center gap-3" data-testid="report-pager">
      <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))} data-testid="report-prev">
        {t.prev}
      </Button>
      <span className="text-sm text-slate-600" data-testid="report-page">{t.page(offset + 1, Math.min(offset + limit, total), total)}</span>
      <Button variant="secondary" size="sm" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)} data-testid="report-next">
        {t.next}
      </Button>
    </div>
  );
}
