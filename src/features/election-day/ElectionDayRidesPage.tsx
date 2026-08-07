import { Tabs } from "../../components/ui/Tabs";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";
import { RideCoordinationTable } from "./RideCoordinationTable";
import { RideCoordinatorsPanel } from "./RideCoordinatorsPanel";

/** Navigation Refactor: `/election-day/rides` - the old accordion's "ניהול
 * אחראי הסעות" category, now a standalone page with a coordinators/table tab
 * pair instead of two separate modals. `RideCoordinationTable` is reused
 * directly (no `RideTableModal` wrapper needed - this whole screen already
 * is the ride view). */
export function ElectionDayRidesPage() {
  const electionDay = useElectionDayShell();

  return (
    <Tabs
      tabs={[
        {
          id: "coordinators",
          label: ELECTION_DAY_TEXT.ridesPage.coordinatorsTab,
          content: (
            <RideCoordinatorsPanel
              coordinators={electionDay.rideCoordinators}
              onAdd={electionDay.addRideCoordinator}
              onDelete={electionDay.deleteRideCoordinator}
            />
          ),
        },
        {
          id: "table",
          label: ELECTION_DAY_TEXT.ridesPage.tableTab,
          content: (
            <RideCoordinationTable
              contacts={electionDay.rideCoordinationQueue}
              onToggleCompleted={(contact, completed) =>
                void electionDay.setRideCompleted(contact.id, completed)
              }
            />
          ),
        },
      ]}
    />
  );
}
