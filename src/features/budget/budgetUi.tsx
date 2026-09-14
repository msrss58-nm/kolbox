import { useCallback, useState, type ReactNode } from "react";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/utils";
import { BUDGET_TEXT, budgetErrorMessage } from "./budget.constants";
import { BudgetApiError, type ExpenseStatus, type FundingKind, type PaymentStatus, type SubmissionDisplayState } from "./budgetClient";
import { formatAgorot, parseShekelInput, parseSignedShekelInput } from "./budgetMoney";

/** Runs a Budget mutation with one busy flag, a success toast and a Hebrew
 * error toast mapped from the server's fixed code. Returns the result, or
 * undefined when it failed. */
export function useBudgetAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, successMessage?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      if (successMessage) toast.success(successMessage);
      return result;
    } catch (e) {
      if (e instanceof BudgetApiError && e.code === "CLOSE_BLOCKED" && e.details.blockers?.length) {
        toast.error(
          `${BUDGET_TEXT.expense.closeBlocked} ${e.details.blockers
            .map((b) => BUDGET_TEXT.expense.blockers[b] ?? b)
            .join(" · ")}`,
        );
      } else {
        toast.error(budgetErrorMessage(e instanceof BudgetApiError ? e.code : undefined));
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy };
}

export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  return (
    <span dir="ltr" className={cn("tabular-nums", className)}>
      {formatAgorot(value)}
    </span>
  );
}

const PILL = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";

const STATUS_TONE: Record<ExpenseStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  committed: "bg-potential-soft text-amber-800",
  incurred: "bg-primary-50 text-primary-700",
  closed: "bg-supporter-soft text-emerald-800",
  cancelled: "bg-opponent-soft text-rose-800",
};
export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  return <span className={cn(PILL, STATUS_TONE[status])}>{BUDGET_TEXT.expenseStatus[status]}</span>;
}

const KIND_TONE: Record<FundingKind, string> = {
  party: "bg-primary-50 text-primary-700",
  donation: "bg-purple-50 text-purple-700",
  personal: "bg-slate-100 text-slate-700",
};
export function KindBadge({ kind }: { kind: FundingKind }) {
  return <span className={cn(PILL, KIND_TONE[kind])}>{BUDGET_TEXT.kinds[kind]}</span>;
}

const PAYMENT_TONE: Record<PaymentStatus, string> = {
  unpaid: "bg-slate-100 text-slate-600",
  partial: "bg-potential-soft text-amber-800",
  paid: "bg-supporter-soft text-emerald-800",
};
export function PaymentBadge({ status }: { status: PaymentStatus }) {
  return <span className={cn(PILL, PAYMENT_TONE[status])}>{BUDGET_TEXT.paymentStatus[status]}</span>;
}

export function SubmissionBadge({ state }: { state: SubmissionDisplayState }) {
  return (
    <span className={cn(PILL, state === "reference_received" ? "bg-supporter-soft text-emerald-800" : "bg-primary-50 text-primary-700")}>
      {BUDGET_TEXT.submissionState[state]}
    </span>
  );
}

export function SectionCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-800">{title}</h2>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

/** Shekel text input; `onValue` receives agorot (or null while invalid). */
export function MoneyInput({
  value,
  onChange,
  signed = false,
  placeholder,
  ...rest
}: {
  value: string;
  onChange: (text: string, agorot: number | null) => void;
  signed?: boolean;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const parse = signed ? parseSignedShekelInput : parseShekelInput;
  return (
    <Input
      inputMode="decimal"
      dir="ltr"
      value={value}
      placeholder={placeholder}
      invalid={value !== "" && parse(value) === null}
      onChange={(e) => onChange(e.target.value, parse(e.target.value))}
      {...rest}
    />
  );
}

export function StatTile({ label, value, tone = "slate" }: { label: string; value: ReactNode; tone?: "slate" | "danger" | "success" }) {
  return (
    <Card className="p-3.5">
      <p className="truncate text-xs font-semibold text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-xl font-extrabold",
          tone === "danger" ? "text-rose-600" : tone === "success" ? "text-emerald-600" : "text-slate-800",
        )}
      >
        {value}
      </p>
    </Card>
  );
}

export function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 text-sm text-slate-700 ring-1 ring-slate-200">
      <span>{BUDGET_TEXT.common.loadError}</span>
      <button onClick={onRetry} className="min-h-11 rounded-xl px-3 font-semibold text-primary-700 ring-1 ring-slate-200">
        {BUDGET_TEXT.common.retry}
      </button>
    </div>
  );
}
