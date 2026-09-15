import { AdminSection } from "../../components/admin/AdminSection";
import { BUDGET_TEXT } from "./budget.constants";
import { BudgetSettingsPanel } from "./BudgetSettingsPanel";
import { OwnerBudgetExportCard } from "./OwnerBudgetExportCard";

/** The Election Owner's Budget settings ("הגדרות תקציב"). The Owner holds
 * primary authority over the workspace's Budget settings; this edits the SAME
 * store as the in-module Settings page, authenticated as the Owner. The
 * deletion export (Stage 7A) is Owner-only and lives here too. */
export function OwnerBudgetSettingsSection() {
  return (
    <AdminSection
      testId="owner-budget-settings-section"
      title={BUDGET_TEXT.settings.title}
      description={BUDGET_TEXT.settings.subtitle}
    >
      <div className="max-w-4xl space-y-4">
        <BudgetSettingsPanel principal="owner" />
        <OwnerBudgetExportCard />
      </div>
    </AdminSection>
  );
}
