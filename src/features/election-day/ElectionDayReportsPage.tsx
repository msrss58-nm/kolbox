import { NavLink } from "react-router";
import { ELECTION_DAY_ROUTES } from "../../constants/routes";
import { cn } from "../../lib/utils";
import { usePermissions } from "../../permissions/usePermissions";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";

// Same click-target-is-the-card pattern as `ElectionDayFilesPage.tsx`'s
// `ElectionDayImportButton`/clear-data/allocation-entry cards - the title +
// description area IS the action, no separate paired button (UX fix,
// 2026-08-22: the old layout duplicated the action across a right-side title
// and a left-side button, wasting space). `border-s-4 border-s-transparent`
// + `focus-visible:border-s-primary-500`/`active:border-s-primary-500` gives
// the same right-edge active stripe the Files screen already established.
const actionCardClass =
  "flex w-full items-center justify-between gap-3 rounded-2xl border-s-4 border-s-transparent bg-white p-5 text-start ring-1 ring-slate-200 transition hover:bg-slate-50 focus-visible:border-s-primary-500 focus-visible:outline-none active:border-s-primary-500 disabled:pointer-events-none disabled:opacity-50";

export function ElectionDayReportsPage() {
  const electionDay = useElectionDayShell();
  const { can } = usePermissions();
  const showExport = can("electionDay.export");

  return (
    <div className="flex flex-col gap-6">
      {showExport && (
        <button
          type="button"
          onClick={electionDay.sendSnapshotReport}
          className={cn(actionCardClass)}
        >
          <div className="min-w-0 flex-1">
            <p className="font-bold text-slate-800">
              📲 {ELECTION_DAY_TEXT.snapshotReport.button}
            </p>
          </div>
        </button>
      )}

      {showExport && (
        <button
          type="button"
          onClick={electionDay.exportReport}
          disabled={!electionDay.total}
          className={cn(actionCardClass)}
        >
          <div className="min-w-0 flex-1">
            <p className="font-bold text-slate-800">
              ⬇️ {ELECTION_DAY_TEXT.exportReport.button}
            </p>
          </div>
        </button>
      )}

      {/* Per the Blueprint, "דוח היסעים" was deliberately resolved to just
       * open the existing ride table rather than build a new export - now
       * that the ride table has its own dedicated screen (`/election-day/rides`),
       * this is a plain navigation link there, not an export action. Not
       * gated by `showExport`: the sidebar already gates `/election-day/rides`
       * on its own permission. */}
      <NavLink to={ELECTION_DAY_ROUTES.rides} className={cn(actionCardClass)}>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800">
            {ELECTION_DAY_TEXT.rideTableModal.navButton}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {ELECTION_DAY_TEXT.nav.rides.label}
          </p>
        </div>
      </NavLink>
    </div>
  );
}
