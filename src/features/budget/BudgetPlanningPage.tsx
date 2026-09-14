import { useCallback, useState } from "react";
import { ArrowLeftRight, Plus, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsyncData } from "../../hooks/useAsyncData";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import {
  budgetCall,
  type BudgetCategory,
  type BudgetOverview,
  type FundingKind,
  type FundingSource,
  type PlanAdjustment,
} from "./budgetClient";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { KindBadge, LoadError, Money, MoneyInput, SectionCard, StatTile, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.planning;
const c = BUDGET_TEXT.common;

interface PlanningData {
  overview: BudgetOverview;
  sources: FundingSource[];
  categories: BudgetCategory[];
  history: PlanAdjustment[];
}

type Dialog =
  | { kind: "newSource" }
  | { kind: "adjustSource"; source: FundingSource }
  | { kind: "setPlan"; category: BudgetCategory }
  | { kind: "adjustPlan"; category: BudgetCategory }
  | { kind: "transfer" }
  | null;

export function BudgetPlanningPage() {
  const session = useBudgetSession((s) => s.session);
  const canPlan = budgetCan(session, "budget.managePlan");
  const canSources = canPlan || budgetCan(session, "budget.manageSettings");

  const fetchData = useCallback(async (): Promise<PlanningData> => {
    const [overview, sources, categories, history] = await Promise.all([
      budgetCall<BudgetOverview>("get_overview"),
      budgetCall<FundingSource[]>("list_sources"),
      budgetCall<BudgetCategory[]>("list_categories"),
      budgetCall<PlanAdjustment[]>("list_plan_adjustments"),
    ]);
    return { overview, sources, categories, history };
  }, []);
  const { data, error, reload } = useAsyncData(fetchData);
  const [dialog, setDialog] = useState<Dialog>(null);
  const done = () => {
    setDialog(null);
    reload();
  };

  const categoryName = (id: string) => data?.categories.find((x) => x.id === id)?.name ?? c.none;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        subtitle={t.subtitle}
        actions={
          canPlan && (data?.categories.length ?? 0) > 1 ? (
            <Button variant="secondary" onClick={() => setDialog({ kind: "transfer" })}>
              <ArrowLeftRight className="size-4" />
              {t.transfer}
            </Button>
          ) : undefined
        }
      />

      {error && <LoadError onRetry={reload} />}

      {!data && !error ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="planning-summary">
            <StatTile label={t.totalBudget} value={<Money value={data.overview.totalBudget} />} />
            <StatTile label={t.planned} value={<Money value={data.overview.plannedInCategories} />} />
            <StatTile
              label={t.unallocated}
              value={<Money value={data.overview.unallocatedPlan} />}
              tone={data.overview.unallocatedPlan < 0 ? "danger" : "slate"}
            />
            <StatTile label={t.usage} value={<Money value={data.overview.committed + data.overview.actual} />} />
          </div>

          <SectionCard
            title={t.sources}
            actions={
              canSources ? (
                <Button size="sm" onClick={() => setDialog({ kind: "newSource" })}>
                  <Plus className="size-4" />
                  {t.newSource}
                </Button>
              ) : undefined
            }
          >
            {data.sources.length === 0 ? (
              <EmptyState icon={SlidersHorizontal} title={t.noSources} dense />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="source-list">
                {data.sources.map((s) => (
                  <li key={s.id}>
                    <Card className={cn("space-y-2 p-4", !s.isActive && "opacity-60")}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-bold text-slate-800">{s.name}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            <KindBadge kind={s.kind} />
                            {!s.isActive && <span className="text-xs text-slate-500">{c.inactive}</span>}
                          </div>
                        </div>
                        {canPlan && (
                          <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "adjustSource", source: s })}>
                            {t.adjust}
                          </Button>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                        <dt className="text-slate-500">{t.currentAmount}</dt>
                        <dd className="text-end font-bold"><Money value={s.currentAmount} /></dd>
                        <dt className="text-slate-500">{t.originalAmount}</dt>
                        <dd className="text-end"><Money value={s.originalAmount} /></dd>
                        <dt className="text-slate-500">{t.adjustments}</dt>
                        <dd className="text-end"><Money value={s.adjustments} /></dd>
                        <dt className="text-slate-500">{t.remaining}</dt>
                        <dd className={cn("text-end font-bold", s.overrun && "text-rose-600")}><Money value={s.remaining} /></dd>
                      </dl>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard title={t.categories}>
            {data.categories.length === 0 ? (
              <EmptyState icon={SlidersHorizontal} title={t.noCategories} dense />
            ) : (
              <div className="-mx-4 overflow-x-auto md:mx-0">
                <table className="w-full min-w-[640px] text-sm" data-testid="category-plan-table">
                  <thead>
                    <tr className="border-b border-slate-100 text-xs text-slate-500">
                      <th className="px-3 py-2 text-start font-semibold">{t.category}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.originalPlan}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.adjustments}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.currentPlan}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.committed}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.actual}</th>
                      <th className="px-3 py-2 text-end font-semibold">{t.remaining}</th>
                      {canPlan && <th className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.categories.map((cat) => (
                      <tr key={cat.id} className={cn(!cat.isActive && "opacity-60")}>
                        <td className="px-3 py-2.5 font-semibold text-slate-800">
                          {cat.name}
                          {cat.overrun && (
                            <span className="ms-2 rounded-full bg-opponent-soft px-2 py-0.5 text-xs font-semibold text-rose-800">
                              {t.overrun}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-end"><Money value={cat.originalPlan} /></td>
                        <td className="px-3 py-2.5 text-end"><Money value={cat.adjustments} /></td>
                        <td className="px-3 py-2.5 text-end font-bold"><Money value={cat.currentPlan} /></td>
                        <td className="px-3 py-2.5 text-end"><Money value={cat.committed} /></td>
                        <td className="px-3 py-2.5 text-end"><Money value={cat.actual} /></td>
                        <td className={cn("px-3 py-2.5 text-end font-bold", cat.overrun && "text-rose-600")}>
                          <Money value={cat.remaining} />
                        </td>
                        {canPlan && (
                          <td className="px-3 py-2.5">
                            <div className="flex justify-end gap-1.5">
                              {cat.adjustments === 0 && (
                                <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "setPlan", category: cat })}>
                                  {t.setPlan}
                                </Button>
                              )}
                              <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: "adjustPlan", category: cat })}>
                                {t.adjustPlan}
                              </Button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title={t.history}>
            {data.history.length === 0 ? (
              <p className="text-sm text-slate-500">{c.noHistory}</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm" data-testid="plan-history">
                {data.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-semibold text-slate-800">{categoryName(h.categoryId)}</span>
                      <span className="ms-2 text-slate-500">
                        {h.kind === "transfer" ? t.kindTransfer : h.kind === "increase" ? t.kindIncrease : t.kindDecrease}
                        {" · "}
                        {h.reason}
                        {" · "}
                        {h.actorName}
                      </span>
                    </span>
                    <Money value={h.delta} className={cn("font-bold", h.delta < 0 ? "text-rose-600" : "text-emerald-600")} />
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      ) : null}

      {dialog?.kind === "newSource" && <NewSourceDialog onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "adjustSource" && (
        <AmountReasonDialog
          title={`${t.adjust} - ${dialog.source.name}`}
          signed
          onClose={() => setDialog(null)}
          submit={(delta, reason) => budgetCall("adjust_source", { sourceId: dialog.source.id, delta, reason })}
          onDone={done}
        />
      )}
      {dialog?.kind === "adjustPlan" && (
        <AmountReasonDialog
          title={`${t.adjustPlan} - ${dialog.category.name}`}
          signed
          onClose={() => setDialog(null)}
          submit={(delta, reason) => budgetCall("adjust_category_plan", { categoryId: dialog.category.id, delta, reason })}
          onDone={done}
        />
      )}
      {dialog?.kind === "setPlan" && (
        <AmountReasonDialog
          title={`${t.setPlan} - ${dialog.category.name}`}
          withoutReason
          onClose={() => setDialog(null)}
          submit={(amount) => budgetCall("set_category_plan", { categoryId: dialog.category.id, originalPlan: amount })}
          onDone={done}
        />
      )}
      {dialog?.kind === "transfer" && data && (
        <TransferDialog categories={data.categories} onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}

function NewSourceDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FundingKind>("party");
  const [amountText, setAmountText] = useState("");
  const [amount, setAmount] = useState<number | null>(0);
  const { run, busy } = useBudgetAction();
  const valid = name.trim() !== "" && (amountText === "" || amount !== null);
  return (
    <Modal open onClose={onClose} title={t.newSource}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => budgetCall("create_source", { name, kind, originalAmount: amountText === "" ? 0 : amount }), c.saved).then(
            (r) => r && onDone(),
          );
        }}
      >
        <Field label={t.sourceName}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </Field>
        <Field label={t.sourceKind}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as FundingKind)}>
            {(["party", "donation", "personal"] as const).map((k) => (
              <option key={k} value={k}>
                {BUDGET_TEXT.kinds[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.originalAmount}>
          <MoneyInput value={amountText} onChange={(text, a) => { setAmountText(text); setAmount(a); }} />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>
          {c.save}
        </Button>
      </form>
    </Modal>
  );
}

function AmountReasonDialog({
  title,
  signed = false,
  withoutReason = false,
  onClose,
  submit,
  onDone,
}: {
  title: string;
  signed?: boolean;
  withoutReason?: boolean;
  onClose: () => void;
  submit: (agorot: number, reason: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const { run, busy } = useBudgetAction();
  const valid = amount !== null && (signed ? amount !== 0 : true) && (withoutReason || reason.trim() !== "");
  return (
    <Modal open onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (amount === null) return;
          void run(() => submit(amount, reason.trim()), c.saved).then((r) => r !== undefined && onDone());
        }}
      >
        <Field label={c.amount}>
          <MoneyInput value={text} signed={signed} placeholder={signed ? t.adjustHint : undefined}
            onChange={(v, a) => { setText(v); setAmount(a); }} />
        </Field>
        {!withoutReason && (
          <Field label={c.reason}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
          </Field>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>
          {c.save}
        </Button>
      </form>
    </Modal>
  );
}

function TransferDialog({ categories, onClose, onDone }: { categories: BudgetCategory[]; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(categories[0]?.id ?? "");
  const [to, setTo] = useState(categories[1]?.id ?? "");
  const [text, setText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const { run, busy } = useBudgetAction();
  const fromCat = categories.find((x) => x.id === from);
  const valid = from && to && from !== to && amount !== null && amount > 0 && reason.trim() !== "";
  return (
    <Modal open onClose={onClose} title={t.transfer}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => budgetCall("transfer_plan", { fromCategoryId: from, toCategoryId: to, amount, reason: reason.trim() }), c.saved)
            .then((r) => r !== undefined && onDone());
        }}
      >
        <Field label={t.transferFrom}>
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {categories.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        {fromCat && (
          <p className="text-xs text-slate-500">
            {t.remaining}: <Money value={fromCat.remaining} />
          </p>
        )}
        <Field label={t.transferTo}>
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {categories.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={c.amount}>
          <MoneyInput value={text} onChange={(v, a) => { setText(v); setAmount(a); }} />
        </Field>
        <Field label={c.reason}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
        </Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!valid}>
          {c.save}
        </Button>
      </form>
    </Modal>
  );
}
