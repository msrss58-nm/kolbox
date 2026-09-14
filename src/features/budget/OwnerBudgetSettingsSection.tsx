import { AdminSection } from "../../components/admin/AdminSection";
import { BUDGET_TEXT } from "./budget.constants";
import { BudgetSettingsPanel } from "./BudgetSettingsPanel";

/** The Election Owner's Budget settings ("הגדרות תקציב"). The Owner holds
 * primary authority over the workspace's Budget settings; this edits the SAME
 * store as the in-module Settings page, authenticated as the Owner. */
export function OwnerBudgetSettingsSection() {
  return (
    <AdminSection
      testId="owner-budget-settings-section"
      title={BUDGET_TEXT.settings.title}
      description={BUDGET_TEXT.settings.subtitle}
    >
      <div className="max-w-4xl">
        <BudgetSettingsPanel principal="owner" />
      </div>
    </AdminSection>
  );
}
