import { Lock } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { BUDGET_TEXT } from "./budget.constants";
import { BudgetSettingsPanel } from "./BudgetSettingsPanel";
import { budgetCan, useBudgetSession } from "./budgetSession";

/** The Budget module's Settings page - for PermissionUsers the Owner granted
 * budget.manageSettings. The Owner edits the same store from the Owner
 * administration area (OwnerBudgetSettingsSection). */
export function BudgetSettingsPage() {
  const session = useBudgetSession((s) => s.session);
  return (
    <div className="space-y-4">
      <PageHeader title={BUDGET_TEXT.settings.title} subtitle={BUDGET_TEXT.settings.subtitle} />
      {budgetCan(session, "budget.manageSettings") ? (
        <BudgetSettingsPanel principal="worker" />
      ) : (
        <EmptyState icon={Lock} title={BUDGET_TEXT.guard.forbiddenTitle} hint={BUDGET_TEXT.guard.forbiddenHint} />
      )}
    </div>
  );
}
