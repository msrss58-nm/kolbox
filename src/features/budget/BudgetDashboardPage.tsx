import { useCallback } from "react";
import { Link, useNavigate } from "react-router";
import { AlertTriangle, CheckCircle2, CircleAlert, Info, Receipt, Settings, SlidersHorizontal, Wallet } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { BUDGET_ROUTES } from "../../constants/routes";
import { useAsyncData } from "../../hooks/useAsyncData";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetCall, type BudgetDashboard, type DashboardAlert } from "./budgetClient";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { ExpenseStatusBadge, LoadError, Money, PaymentBadge, SectionCard, SubmissionBadge } from "./budgetUi";
import { CategoryChart, PlanChart, SourceChart, TimeChart } from "./BudgetCharts";

const t = BUDGET_TEXT.dashboard;
const c = BUDGET_TEXT.common;

/** Budget Stage 6: the dashboard. One read (`get_dashboard`); every number is
 * computed server-side by the shared calculation layer and links to the list
 * or report that shows exactly the records it counts. */
export function BudgetDashboardPage() {
  const session = useBudgetSession((s) => s.session);
  const canReports = budgetCan(session, "budget.viewReports");
  const canSettings = budgetCan(session, "budget.manageSettings");
  const navigate = useNavigate();
  const fetchDashboard = useCallback(() => budgetCall<BudgetDashboard>("get_dashboard"), []);
  const { data, error, reload } = useAsyncData(fetchDashboard);

  /** A report link when the user may read reports, otherwise the page that
   * holds the same figures. */
  const report = (query: string, fallback: string) => (canReports ? `${BUDGET_ROUTES.reports}?${query}` : fallback);
  const queue = (key: string) => `${BUDGET_ROUTES.expenses}?queue=${key}`;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        subtitle={data ? t.period(data.period.start, data.period.end) : t.subtitle}
        actions={
          <div className="flex flex-wrap gap-2">
            <HeaderLink to={BUDGET_ROUTES.planning} icon={<Wallet className="size-4" />} label={t.openPlanning} />
            {canReports && <HeaderLink to={BUDGET_ROUTES.reports} icon={<SlidersHorizontal className="size-4" />} label={t.openReports} />}
            {canSettings && <HeaderLink to={BUDGET_ROUTES.settings} icon={<Settings className="size-4" />} label={t.openSettings} />}
          </div>
        }
      />

      {error && <LoadError onRetry={reload} />}

      {!data && !error ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      ) : data ? (
        <>
          {data.counts.sources === 0 && (
            <Card className="p-4">
              <EmptyState icon={Wallet} title={t.noBudget} hint={t.noBudgetHint} dense />
              <div className="mt-2 flex justify-center">
                <Link to={BUDGET_ROUTES.planning} className="inline-flex min-h-11 items-center font-semibold text-primary-700">
                  {t.openPlanning}
                </Link>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="dashboard-kpis">
            <KpiTile testId="kpi-totalBudget" label={t.kpis.totalBudget} value={data.kpis.totalBudget}
              to={report("report=sources", BUDGET_ROUTES.planning)} />
            <KpiTile testId="kpi-partyBudget" label={t.kpis.partyBudget} value={data.kpis.partyBudget}
              to={report("report=sources&kind=party", BUDGET_ROUTES.planning)} />
            <KpiTile testId="kpi-donationBudget" label={t.kpis.donationBudget} value={data.kpis.donationBudget}
              to={report("report=sources&kind=donation", BUDGET_ROUTES.planning)} />
            <KpiTile testId="kpi-personalBudget" label={t.kpis.personalBudget} value={data.kpis.personalBudget}
              to={report("report=sources&kind=personal", BUDGET_ROUTES.planning)} />
            <KpiTile testId="kpi-totalExpenses" label={t.kpis.totalExpenses} value={data.kpis.totalExpenses}
              to={`${BUDGET_ROUTES.expenses}?statusGroup=obligations`}
              sub={{ label: t.kpis.committedSub, value: data.kpis.committed, to: `${BUDGET_ROUTES.expenses}?status=committed` }} />
            <KpiTile testId="kpi-available" label={t.kpis.available} value={data.kpis.available}
              to={report("report=plan", BUDGET_ROUTES.planning)} danger={data.kpis.available < 0} hint={t.kpis.availableHint} />
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <SectionCard title={t.queuesTitle}>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1" data-testid="dashboard-queues">
                {(["awaiting_preapproval", "missing_documents", "waiting_supplier_form", "ready_to_submit", "sent_waiting_reference"] as const)
                  .map((k) => <QueueItem key={k} testId={`queue-${k}`} label={t.queues[k]} count={data.queues[k]} to={queue(k)} />)}
                <QueueItem testId="queue-authorized_not_fully_paid" label={t.queues.authorized_not_fully_paid}
                  count={data.queues.authorized_not_fully_paid} to={queue("authorized_not_fully_paid")}
                  sub={t.authorizedSplit(data.queues.authorized_unpaid, data.queues.authorized_partial)}
                  amount={data.kpis.authorizedUnpaidAmount} />
                <QueueItem testId="queue-overruns" label={t.queues.overruns}
                  count={data.overruns.categories + data.overruns.sources}
                  to={report("report=plan&attention=overrun", BUDGET_ROUTES.planning)}
                  sub={t.overrunsSplit(data.overruns.categories, data.overruns.sources)} danger />
              </ul>
            </SectionCard>

            <div className="xl:col-span-2">
              <SectionCard title={t.alertsTitle}>
                {data.alerts.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-emerald-700" data-testid="dashboard-alerts-none">
                    <CheckCircle2 className="size-4" />
                    {t.alertsNone}
                  </p>
                ) : (
                  <ul className="space-y-2" data-testid="dashboard-alerts">
                    {data.alerts.map((a) => (
                      <li key={a.key} data-alert={a.key}>
                        <Link to={alertLink(a, canReports)}
                          className={cn("flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ring-1",
                            a.severity === "danger" ? "bg-opponent-soft text-rose-800 ring-rose-100"
                              : a.severity === "warning" ? "bg-potential-soft text-amber-900 ring-amber-100"
                                : "bg-slate-50 text-slate-700 ring-slate-200")}>
                          {a.severity === "danger" ? <CircleAlert className="size-4 shrink-0" />
                            : a.severity === "warning" ? <AlertTriangle className="size-4 shrink-0" /> : <Info className="size-4 shrink-0" />}
                          <span className="min-w-0 flex-1">{(t.alerts[a.key] ?? (() => a.key))(a.count, a.days ?? a.pct ?? 0)}</span>
                          {a.amount !== undefined && <Money value={a.amount} className="shrink-0" />}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <CategoryChart rows={data.charts.byCategory}
              onSelect={(id) => navigate(`${BUDGET_ROUTES.expenses}?statusGroup=obligations&categoryId=${id}`)} />
            <SourceChart rows={data.charts.bySource}
              onSelect={(id) => navigate(`${BUDGET_ROUTES.expenses}?statusGroup=obligations&sourceId=${id}`)} />
            <PlanChart rows={data.charts.byCategory}
              onSelect={(id) => navigate(`${BUDGET_ROUTES.expenses}?statusGroup=obligations&categoryId=${id}`)} />
            <TimeChart rows={data.charts.overTime} />
          </div>

          <SectionCard title={t.recentTitle}>
            {data.recent.length === 0 ? (
              <EmptyState icon={Receipt} title={t.recentEmpty} dense />
            ) : (
              <ul className="divide-y divide-slate-100" data-testid="dashboard-recent">
                {data.recent.map((r) => (
                  <li key={r.id}>
                    <Link to={`${BUDGET_ROUTES.expenses}/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:bg-slate-50">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-800">#{r.referenceNo} · {r.description}</p>
                        <p className="truncate text-xs text-slate-500">
                          {r.expenseDate ?? c.none} · {r.categoryName ?? c.none} · {r.supplierName ?? c.none}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          <ExpenseStatusBadge status={r.status} />
                          <PaymentBadge status={r.paymentStatus} />
                          {r.partyState && <SubmissionBadge state={r.partyState} />}
                        </div>
                      </div>
                      <div className="text-end">
                        <Money value={r.total} className="font-bold text-slate-800" />
                        {r.unfunded > 0 && r.status !== "draft" && (
                          <p className="text-xs text-rose-600">{BUDGET_TEXT.expenses.queues.unfunded}: <Money value={r.unfunded} /></p>
                        )}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}

function HeaderLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary-700 ring-1 ring-slate-200 hover:bg-slate-50">
      {icon}
      {label}
    </Link>
  );
}

function KpiTile({ testId, label, value, to, sub, danger, hint }: {
  testId: string;
  label: string;
  value: number;
  to: string;
  sub?: { label: string; value: number; to: string };
  danger?: boolean;
  hint?: string;
}) {
  return (
    <div data-testid={testId}>
      <Card className="flex h-full flex-col p-3.5">
        <Link to={to} className="group block min-h-11 rounded-lg" data-testid={`${testId}-link`}>
          <p className="truncate text-xs font-semibold text-slate-500 group-hover:text-primary-700">{label}</p>
          <p className={cn("mt-1.5 text-lg font-extrabold md:text-xl", danger ? "text-rose-600" : "text-slate-800")}>
            <Money value={value} />
          </p>
        </Link>
        {sub && (
          <Link to={sub.to} className="inline-flex min-h-11 items-center gap-1 text-xs text-slate-500 hover:text-primary-700" data-testid={`${testId}-sub`}>
            {sub.label}: <Money value={sub.value} />
          </Link>
        )}
        {hint && <p className="text-[11px] leading-snug text-slate-400">{hint}</p>}
      </Card>
    </div>
  );
}

function QueueItem({ testId, label, count, to, sub, amount, danger }: {
  testId: string;
  label: string;
  count: number;
  to: string;
  sub?: string;
  amount?: number;
  danger?: boolean;
}) {
  const body = (
    <>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{label}</p>
        {count === 0 ? (
          <p className="text-xs text-slate-400">{t.queueEmpty}</p>
        ) : (
          <>
            {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
            {amount !== undefined && amount > 0 && <p className="text-xs text-slate-500"><Money value={amount} /></p>}
          </>
        )}
      </div>
      <span className={cn("text-xl font-extrabold tabular-nums", count === 0 ? "text-slate-300" : danger ? "text-rose-600" : "text-slate-800")}
        data-testid="queue-count">
        {count}
      </span>
    </>
  );
  return (
    <li data-testid={testId}>
      {count === 0 ? (
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 text-slate-500">{body}</div>
      ) : (
        <Link to={to} className="flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 py-2 text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
          {body}
        </Link>
      )}
    </li>
  );
}

/** Every alert opens the list / report that shows exactly what it counts. */
function alertLink(a: DashboardAlert, canReports: boolean): string {
  const report = (q: string, fallback: string) => (canReports ? `${BUDGET_ROUTES.reports}?${q}` : fallback);
  switch (a.key) {
    case "total_overrun":
      return report("report=plan", BUDGET_ROUTES.planning);
    case "category_overrun":
      return report("report=plan&attention=overrun", BUDGET_ROUTES.planning);
    case "category_warning":
      return report("report=plan&attention=warning", BUDGET_ROUTES.planning);
    case "source_overrun":
      return report("report=sources&attention=overrun", BUDGET_ROUTES.planning);
    case "supplier_docs_expiring":
      return report("report=suppliers&docsExpiring=1", BUDGET_ROUTES.suppliers);
    case "plan_exceeds_budget":
      return BUDGET_ROUTES.planning;
    default:
      return `${BUDGET_ROUTES.expenses}?queue=${a.key}`;
  }
}
