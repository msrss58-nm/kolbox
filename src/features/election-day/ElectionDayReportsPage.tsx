import { FileSpreadsheet } from "lucide-react";
import { NavLink } from "react-router";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ELECTION_DAY_ROUTES } from "../../constants/routes";
import { usePermissions } from "../../permissions/usePermissions";
import { cn } from "../../lib/utils";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";

// Same green as `ElectionDayNav.tsx`'s retired accordion reports section -
// `!` (Tailwind v4 important modifier) forces this over `Button`'s default
// `variant="primary"` background, since `cn()` doesn't dedupe classes.
const exportButtonClass =
  "!bg-[#00a400] !text-white hover:!bg-[#008f00] active:!bg-[#007a00] disabled:!bg-slate-200 disabled:!text-slate-400";

export function ElectionDayReportsPage() {
  const electionDay = useElectionDayShell();
  const { can } = usePermissions();
  const showExport = can("electionDay.export");

  return (
    <div className="flex flex-col gap-6">
      {showExport && (
        <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{ELECTION_DAY_TEXT.snapshotReport.button}</CardTitle>
          </div>
          <Button
            className={cn(exportButtonClass)}
            onClick={electionDay.sendSnapshotReport}
          >
            📲 {ELECTION_DAY_TEXT.snapshotReport.button}
            <FileSpreadsheet className="size-4 shrink-0" />
          </Button>
        </Card>
      )}

      {showExport && (
        <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>{ELECTION_DAY_TEXT.exportReport.button}</CardTitle>
          </div>
          <Button
            className={cn(exportButtonClass)}
            disabled={!electionDay.total}
            onClick={electionDay.exportReport}
          >
            ⬇️ {ELECTION_DAY_TEXT.exportReport.button}
            <FileSpreadsheet className="size-4 shrink-0" />
          </Button>
        </Card>
      )}

      {/* Per the Blueprint, "דוח היסעים" was deliberately resolved to just
       * open the existing ride table rather than build a new export - now
       * that the ride table has its own dedicated screen (`/election-day/rides`),
       * this is a plain navigation link there, not an export action -
       * styled as a secondary/neutral card to read as "go to a screen",
       * not "generate a report". Not gated by `showExport`: the sidebar
       * already gates `/election-day/rides` on its own permission. */}
      <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>{ELECTION_DAY_TEXT.rideTableModal.navButton}</CardTitle>
          <p className="mt-1 text-sm text-slate-500">
            {ELECTION_DAY_TEXT.nav.rides.label}
          </p>
        </div>
        <NavLink
          to={ELECTION_DAY_ROUTES.rides}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 transition-all duration-150 hover:bg-slate-50 active:bg-slate-100"
        >
          {ELECTION_DAY_TEXT.rideTableModal.navButton}
        </NavLink>
      </Card>
    </div>
  );
}
