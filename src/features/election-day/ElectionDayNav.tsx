import { FileSpreadsheet } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Accordion, type AccordionSection } from "../../components/ui/Accordion";
import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayImportButton } from "./ElectionDayImportButton";

// `!` (Tailwind v4 important modifier) forces this green over `Button`'s
// default `variant="primary"` background - `cn()` is a plain `clsx` (no
// tailwind-merge dedup), so a later-in-string class isn't guaranteed to win
// on specificity/stylesheet order alone, which is exactly why these two
// report buttons rendered purple instead of green before this fix.
const exportButtonClass =
  "!bg-[#00a400] !text-white hover:!bg-[#008f00] active:!bg-[#007a00] disabled:!bg-slate-200 disabled:!text-slate-400";

function NavRow({
  icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      disabled={disabled}
      className={cn("touch-target w-full justify-start", className)}
    >
      {icon} {label}
    </Button>
  );
}

export function ElectionDayNav({
  showImport,
  showClearData,
  showManageRideCoordinators,
  showManageUsers,
  showManageRoles,
  showManageReasons,
  showReasonsReport,
  showExport,
  onFileSelected,
  importBusy,
  onClearData,
  clearDisabled,
  onOpenCoordinators,
  onOpenRideTable,
  onOpenPermissions,
  onOpenRoles,
  onOpenReasonsReport,
  onOpenReasonsCatalog,
  onSendSnapshotReport,
  onExportReport,
  exportDisabled,
}: {
  showImport: boolean;
  showClearData: boolean;
  showManageRideCoordinators: boolean;
  showManageUsers: boolean;
  showManageRoles: boolean;
  showManageReasons: boolean;
  /** The report sub-item's real gate - mirrors the dashboard card's own
   * `voter.viewVotedStatus` `PermissionGuard` (see `ElectionDayDashboard.tsx`),
   * computed at the page level (this component has no access to `can(...)`
   * itself) - deliberately separate from `showManageReasons` (the catalog's
   * gate) since a role can hold one without the other. */
  showReasonsReport: boolean;
  showExport: boolean;
  onFileSelected: (file: File) => void;
  importBusy: boolean;
  onClearData: () => void;
  clearDisabled: boolean;
  onOpenCoordinators: () => void;
  onOpenRideTable: () => void;
  onOpenPermissions: () => void;
  onOpenRoles: () => void;
  onOpenReasonsReport: () => void;
  onOpenReasonsCatalog: () => void;
  onSendSnapshotReport: () => void;
  onExportReport: () => void;
  exportDisabled: boolean;
}) {
  const showFiles = showImport || showClearData;
  const showPermissions = showManageUsers || showManageRoles;
  // The ride-table sub-item has no permission of its own - it's tied to
  // `showManageRideCoordinators` for now, same as every other sub-item in
  // this category (see task context: it mirrors dashboard-wide visibility,
  // not a dedicated gate).
  const showRides = showManageRideCoordinators;
  const showReasons = showManageReasons || showReasonsReport;
  const showReports = showExport;

  const sections: AccordionSection[] = [];

  if (showFiles) {
    sections.push({
      id: "files",
      icon: ELECTION_DAY_TEXT.nav.files.icon,
      label: ELECTION_DAY_TEXT.nav.files.label,
      content: (
        <div className="flex flex-col gap-2">
          {showImport && (
            <ElectionDayImportButton onFileSelected={onFileSelected} busy={importBusy} />
          )}
          {showClearData && (
            <Button
              variant="danger"
              disabled={clearDisabled}
              onClick={onClearData}
              className="touch-target w-full justify-start"
            >
              🗑️ {ELECTION_DAY_TEXT.clearAll.button}
            </Button>
          )}
        </div>
      ),
    });
  }

  if (showPermissions) {
    sections.push({
      id: "permissions",
      icon: ELECTION_DAY_TEXT.nav.permissions.icon,
      label: ELECTION_DAY_TEXT.nav.permissions.label,
      content: (
        <div className="flex flex-col gap-2">
          {showManageUsers && (
            <NavRow
              icon="🔑"
              label={ELECTION_DAY_TEXT.permissionsManager.button}
              onClick={onOpenPermissions}
            />
          )}
          {showManageRoles && (
            <NavRow
              icon="🛡️"
              label={ELECTION_DAY_TEXT.rolesManager.button}
              onClick={onOpenRoles}
            />
          )}
        </div>
      ),
    });
  }

  if (showRides) {
    sections.push({
      id: "rides",
      icon: ELECTION_DAY_TEXT.nav.rides.icon,
      label: ELECTION_DAY_TEXT.nav.rides.label,
      content: (
        <div className="flex flex-col gap-2">
          <NavRow
            icon="👨‍💼"
            label={ELECTION_DAY_TEXT.coordinatorsManager.button}
            onClick={onOpenCoordinators}
          />
          <NavRow
            icon="🚕"
            label={ELECTION_DAY_TEXT.rideTableModal.navButton}
            onClick={onOpenRideTable}
          />
        </div>
      ),
    });
  }

  if (showReasons) {
    sections.push({
      id: "reasons",
      icon: ELECTION_DAY_TEXT.nav.reasons.icon,
      label: ELECTION_DAY_TEXT.nav.reasons.label,
      content: (
        <div className="flex flex-col gap-2">
          {showReasonsReport && (
            <NavRow
              icon="📊"
              label={ELECTION_DAY_TEXT.nonVotingReasonsReport.navButton}
              onClick={onOpenReasonsReport}
            />
          )}
          {showManageReasons && (
            <NavRow
              icon="⚙️"
              label={ELECTION_DAY_TEXT.nonVotingReasonsManager.button}
              onClick={onOpenReasonsCatalog}
            />
          )}
        </div>
      ),
    });
  }

  if (showReports) {
    sections.push({
      id: "reports",
      icon: ELECTION_DAY_TEXT.nav.reports.icon,
      label: ELECTION_DAY_TEXT.nav.reports.label,
      content: (
        <div className="flex flex-col gap-2">
          <Button
            className={cn("touch-target w-full justify-start", exportButtonClass)}
            onClick={onSendSnapshotReport}
          >
            📲 {ELECTION_DAY_TEXT.snapshotReport.button}
            <FileSpreadsheet className="size-4 shrink-0" />
          </Button>
          <Button
            className={cn("touch-target w-full justify-start", exportButtonClass)}
            disabled={exportDisabled}
            onClick={onExportReport}
          >
            ⬇️ {ELECTION_DAY_TEXT.exportReport.button}
            <FileSpreadsheet className="size-4 shrink-0" />
          </Button>
        </div>
      ),
    });
  }

  if (sections.length === 0) return null;

  return <Accordion sections={sections} />;
}
