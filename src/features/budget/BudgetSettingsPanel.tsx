import { useCallback, useState } from "react";
import { ChevronDown, ChevronUp, PackageX, Plus, Trash2 } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { useAsyncData } from "../../hooks/useAsyncData";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT } from "./budget.constants";
import {
  BudgetApiError,
  budgetCall,
  type BudgetCategory,
  type BudgetPrincipal,
  type BudgetSettings,
  type DocumentRule,
  type FundingKind,
  type FundingSource,
} from "./budgetClient";
import { agorotToInput } from "./budgetMoney";
import { budgetCan, useBudgetSession } from "./budgetSession";
import { KindBadge, LoadError, Money, MoneyInput, SectionCard, useBudgetAction } from "./budgetUi";

const t = BUDGET_TEXT.settings;
const c = BUDGET_TEXT.common;

interface SettingsData {
  settings: BudgetSettings;
  categories: BudgetCategory[];
  sources: FundingSource[];
}

/**
 * Budget settings - ONE canonical store, edited from two places:
 *   - the Budget module's Settings page (principal "worker", a PermissionUser
 *     holding budget.manageSettings), and
 *   - the Election Owner's "הגדרות תקציב" section (principal "owner").
 * Both call the same server ops; only the authenticating principal differs.
 */
export function BudgetSettingsPanel({ principal }: { principal: BudgetPrincipal }) {
  const call = useCallback(
    <T,>(op: string, args: Record<string, unknown> = {}) => budgetCall<T>(op, args, principal),
    [principal],
  );
  const fetchData = useCallback(async (): Promise<SettingsData> => {
    const [settings, categories, sources] = await Promise.all([
      call<BudgetSettings>("get_settings"),
      call<BudgetCategory[]>("list_categories"),
      call<FundingSource[]>("list_sources"),
    ]);
    return { settings, categories, sources };
  }, [call]);
  const { data, error, reload } = useAsyncData(fetchData);
  const { run, busy } = useBudgetAction();
  // Money is plan authority: the Owner, or a worker with budget.managePlan,
  // may set a source amount here; a settings-only worker edits name/kind/active.
  const session = useBudgetSession((s) => s.session);
  const canSetAmount = principal === "owner" || budgetCan(session, "budget.managePlan");
  const [newCategory, setNewCategory] = useState("");
  const [renaming, setRenaming] = useState<BudgetCategory | null>(null);
  const [sourceDialog, setSourceDialog] = useState<FundingSource | "new" | null>(null);

  if (error && !data) {
    return error instanceof BudgetApiError && error.code === "MODULE_NOT_ENABLED" ? (
      <EmptyState icon={PackageX} title={BUDGET_TEXT.guard.unavailableTitle} hint={BUDGET_TEXT.guard.unavailableHint} />
    ) : (
      <LoadError onRetry={reload} />
    );
  }
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const { settings, categories, sources } = data;
  const typeName = (id: string) => settings.documentTypes.find((d) => d.id === id)?.name ?? c.none;

  const move = (index: number, delta: number) => {
    const ids = categories.map((x) => x.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    void run(() => call("reorder_categories", { categoryIds: ids })).then(reload);
  };

  return (
    <div className="space-y-4" data-testid="budget-settings">
      <SectionCard title={t.categories}>
        <form className="mb-3 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          void run(() => call("create_category", { name: newCategory.trim() }), c.saved).then((r) => {
            if (r !== undefined) setNewCategory("");
            reload();
          });
        }}>
          <Input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder={t.newCategory}
            aria-label={t.categoryName} maxLength={100} />
          <Button type="submit" loading={busy} disabled={!newCategory.trim()}><Plus className="size-4" />{c.add}</Button>
        </form>
        <ul className="divide-y divide-slate-100" data-testid="category-settings">
          {categories.map((cat, i) => (
            <li key={cat.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2", !cat.isActive && "opacity-60")}>
              <span className="min-w-0 font-semibold text-slate-800">
                {cat.name}
                {cat.inUse && <span className="ms-2 text-xs font-normal text-slate-500">{t.inUse}</span>}
              </span>
              <span className="flex items-center gap-1">
                <IconBtn label={t.moveUp} onClick={() => move(i, -1)} disabled={busy || i === 0}><ChevronUp className="size-4" /></IconBtn>
                <IconBtn label={t.moveDown} onClick={() => move(i, 1)} disabled={busy || i === categories.length - 1}><ChevronDown className="size-4" /></IconBtn>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(cat)}>{c.edit}</Button>
                <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => void run(() => call("update_category", { categoryId: cat.id, isActive: !cat.isActive }), c.saved).then(reload)}>
                  {cat.isActive ? c.deactivate : c.activate}
                </Button>
                {!cat.inUse && (
                  <IconBtn label={c.delete} danger disabled={busy}
                    onClick={() => void run(() => call("delete_category", { categoryId: cat.id }), c.saved).then(reload)}>
                    <Trash2 className="size-4" />
                  </IconBtn>
                )}
              </span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t.sources} actions={
        <Button size="sm" variant="secondary" onClick={() => setSourceDialog("new")}><Plus className="size-4" />{BUDGET_TEXT.planning.newSource}</Button>}>
        <ul className="divide-y divide-slate-100">
          {sources.map((s) => (
            <li key={s.id} className={cn("flex flex-wrap items-center justify-between gap-2 py-2", !s.isActive && "opacity-60")}>
              <span className="flex items-center gap-2 font-semibold text-slate-800">{s.name}<KindBadge kind={s.kind} /></span>
              <span className="flex items-center gap-2">
                <Money value={s.currentAmount} />
                <Button size="sm" variant="ghost" onClick={() => setSourceDialog(s)}>{c.edit}</Button>
              </span>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title={t.rules}>
        <ul className="divide-y divide-slate-100" data-testid="document-rules">
          {settings.documentRules.map((r) => (
            <RuleRow key={r.id} rule={r} typeName={typeName(r.documentTypeId)} busy={busy}
              onSave={(args) => void run(() => call("update_document_rule", { ruleId: r.id, expectedVersion: r.version, ...args }), c.saved).then(reload)} />
          ))}
        </ul>
      </SectionCard>

      <GeneralSettings settings={settings} busy={busy}
        onSave={(args) => void run(() => call("update_settings", { expectedVersion: settings.version, ...args }), c.saved).then(reload)} />

      {renaming && (
        <RenameDialog name={renaming.name} busy={busy} onClose={() => setRenaming(null)}
          onSubmit={(name) => void run(() => call("update_category", { categoryId: renaming.id, name }), c.saved)
            .then((r) => { if (r !== undefined) setRenaming(null); reload(); })} />
      )}
      {sourceDialog && (
        <SourceDialog source={sourceDialog === "new" ? null : sourceDialog} canSetAmount={canSetAmount} busy={busy} onClose={() => setSourceDialog(null)}
          onSubmit={(args) => void run(() => (sourceDialog === "new"
            ? call("create_source", args)
            : call("update_source", { sourceId: sourceDialog.id, expectedVersion: sourceDialog.version, ...args })), c.saved)
            .then((r) => { if (r !== undefined) setSourceDialog(null); reload(); })} />
      )}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, danger, children }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className={cn("touch-target grid place-items-center rounded-lg text-slate-400 disabled:opacity-30",
        danger ? "hover:bg-opponent-soft hover:text-opponent" : "hover:bg-slate-100 hover:text-slate-700")}>
      {children}
    </button>
  );
}

function RuleRow({ rule, typeName, busy, onSave }: {
  rule: DocumentRule; typeName: string; busy: boolean; onSave: (args: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(agorotToInput(rule.threshold));
  const [value, setValue] = useState<number | null>(rule.threshold);
  const isAmount = rule.condition === "amount_gt" || rule.condition === "amount_gte";
  const condition = {
    always: t.ruleAlways, amount_gt: t.ruleAbove, amount_gte: t.ruleAboveOrEqual, category: t.ruleCategory, manual: t.ruleManual,
  }[rule.condition];
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-2 py-2", !rule.isActive && "opacity-60")}>
      <span className="min-w-0 text-sm">
        <span className="font-semibold text-slate-800">{typeName}</span>
        <span className="ms-2 text-slate-500">
          {t.documentKinds[rule.fundingKind ?? "any"]} · {condition}
          {isAmount && rule.threshold !== null && <> <Money value={rule.threshold} /></>}
        </span>
      </span>
      <span className="flex items-center gap-2">
        {isAmount && (
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (value !== null) onSave({ threshold: value }); }}>
            <div className="w-32"><MoneyInput value={text} aria-label={t.threshold} onChange={(v, n) => { setText(v); setValue(n); }} /></div>
            <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={value === null || value === rule.threshold}>{c.save}</Button>
          </form>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSave({ isActive: !rule.isActive })}>
          {rule.isActive ? c.deactivate : c.activate}
        </Button>
      </span>
    </li>
  );
}

function GeneralSettings({ settings, busy, onSave }: {
  settings: BudgetSettings; busy: boolean; onSave: (args: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    periodStart: settings.periodStart ?? "",
    periodEnd: settings.periodEnd ?? "",
    branchName: settings.branchName ?? "",
    branchNumber: settings.branchNumber ?? "",
    defaultOrderer: settings.defaultOrderer ?? "",
    electionYearLabel: settings.electionYearLabel ?? "",
    whatsappFunderPhone: settings.whatsappFunderPhone ?? "",
    alertMissingDocsDays: String(settings.alertMissingDocsDays),
    alertSupplierFormDays: String(settings.alertSupplierFormDays),
    alertNoReferenceDays: String(settings.alertNoReferenceDays),
    alertUnpaidDays: String(settings.alertUnpaidDays),
    categoryUsageWarningPct: String(settings.categoryUsageWarningPct),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const int = (s: string) => (/^\d{1,3}$/.test(s) ? Number(s) : undefined);
  return (
    <SectionCard title={`${t.period} · ${t.orderForm} · ${t.alerts}`}>
      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(e) => {
        e.preventDefault();
        onSave({
          periodStart: form.periodStart || null, periodEnd: form.periodEnd || null,
          branchName: form.branchName || null, branchNumber: form.branchNumber || null,
          defaultOrderer: form.defaultOrderer || null, electionYearLabel: form.electionYearLabel || null,
          whatsappFunderPhone: form.whatsappFunderPhone || null,
          alertMissingDocsDays: int(form.alertMissingDocsDays), alertSupplierFormDays: int(form.alertSupplierFormDays),
          alertNoReferenceDays: int(form.alertNoReferenceDays), alertUnpaidDays: int(form.alertUnpaidDays),
          categoryUsageWarningPct: int(form.categoryUsageWarningPct),
        });
      }}>
        <Field label={t.periodStart}><Input type="date" value={form.periodStart} onChange={set("periodStart")} /></Field>
        <Field label={t.periodEnd}><Input type="date" value={form.periodEnd} onChange={set("periodEnd")} /></Field>
        <p className="self-end text-xs text-slate-500">{t.periodHint}</p>
        <Field label={t.branchName}><Input value={form.branchName} onChange={set("branchName")} maxLength={200} /></Field>
        <Field label={t.branchNumber}><Input value={form.branchNumber} onChange={set("branchNumber")} maxLength={50} /></Field>
        <Field label={t.defaultOrderer}><Input value={form.defaultOrderer} onChange={set("defaultOrderer")} maxLength={200} /></Field>
        <Field label={t.electionYearLabel}><Input value={form.electionYearLabel} onChange={set("electionYearLabel")} maxLength={50} /></Field>
        <Field label={t.funderPhone}><Input dir="ltr" value={form.whatsappFunderPhone} onChange={set("whatsappFunderPhone")} maxLength={32} /></Field>
        <Field label={t.usageWarning}><Input inputMode="numeric" value={form.categoryUsageWarningPct} onChange={set("categoryUsageWarningPct")} /></Field>
        <Field label={t.alertMissingDocs}><Input inputMode="numeric" value={form.alertMissingDocsDays} onChange={set("alertMissingDocsDays")} /></Field>
        <Field label={t.alertSupplierForm}><Input inputMode="numeric" value={form.alertSupplierFormDays} onChange={set("alertSupplierFormDays")} /></Field>
        <Field label={t.alertNoReference}><Input inputMode="numeric" value={form.alertNoReferenceDays} onChange={set("alertNoReferenceDays")} /></Field>
        <Field label={t.alertUnpaid}><Input inputMode="numeric" value={form.alertUnpaidDays} onChange={set("alertUnpaidDays")} /></Field>
        <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" loading={busy}>{c.save}</Button></div>
      </form>
    </SectionCard>
  );
}

function RenameDialog({ name, busy, onClose, onSubmit }: { name: string; busy: boolean; onClose: () => void; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <Modal open onClose={onClose} title={c.edit}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit(value.trim()); }}>
        <Field label={t.categoryName}><Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={100} required /></Field>
        <Button type="submit" className="w-full" loading={busy} disabled={!value.trim()}>{c.save}</Button>
      </form>
    </Modal>
  );
}

function SourceDialog({ source, canSetAmount, busy, onClose, onSubmit }: {
  source: FundingSource | null; canSetAmount: boolean; busy: boolean; onClose: () => void; onSubmit: (args: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [kind, setKind] = useState<FundingKind>(source?.kind ?? "party");
  const [isActive, setIsActive] = useState(source?.isActive ?? true);
  const [text, setText] = useState(agorotToInput(source?.originalAmount ?? 0));
  const [amount, setAmount] = useState<number | null>(source?.originalAmount ?? 0);
  const lockedOriginal = !canSetAmount || Boolean(source && source.adjustments !== 0);
  return (
    <Modal open onClose={onClose} title={source ? c.edit : BUDGET_TEXT.planning.newSource}>
      <form className="space-y-3" onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: name.trim(), kind, ...(source ? { isActive } : {}), ...(!lockedOriginal && amount !== null ? { originalAmount: amount } : {}) });
      }}>
        <Field label={BUDGET_TEXT.planning.sourceName}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></Field>
        <Field label={BUDGET_TEXT.planning.sourceKind}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as FundingKind)}>
            {(["party", "donation", "personal"] as const).map((k) => <option key={k} value={k}>{BUDGET_TEXT.kinds[k]}</option>)}
          </Select>
        </Field>
        {!lockedOriginal && (
          <Field label={BUDGET_TEXT.planning.originalAmount}><MoneyInput value={text} onChange={(v, n) => { setText(v); setAmount(n); }} /></Field>
        )}
        {source && (
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="size-4 accent-primary-600" />
            {c.active}
          </label>
        )}
        <Button type="submit" className="w-full" loading={busy} disabled={!name.trim() || amount === null}>{c.save}</Button>
      </form>
    </Modal>
  );
}
