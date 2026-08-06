import { MultiSelectDropdown } from "../../components/ui/MultiSelectDropdown";
import { PermissionGuard } from "../../permissions/PermissionGuard";
import type { NonVotingReason } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { RideStatusFilterValue } from "./useElectionDay";

const STATUS_OPTIONS: { value: RideStatusFilterValue; label: string }[] = [
  { value: "arranged", label: ELECTION_DAY_TEXT.status.arranged },
  { value: "notArranged", label: ELECTION_DAY_TEXT.status.notArranged },
];

export function ElectionDayFilters({
  coordinators,
  coordinatorFilter,
  onCoordinatorFilterChange,
  cities,
  cityFilter,
  onCityFilterChange,
  statusFilter,
  onStatusFilterChange,
  nonVotingReasons,
  reasonFilter,
  onReasonFilterChange,
}: {
  coordinators: string[];
  coordinatorFilter: string[];
  onCoordinatorFilterChange: (values: string[]) => void;
  cities: string[];
  cityFilter: string[];
  onCityFilterChange: (values: string[]) => void;
  statusFilter: RideStatusFilterValue[];
  onStatusFilterChange: (values: RideStatusFilterValue[]) => void;
  nonVotingReasons: readonly NonVotingReason[];
  reasonFilter: string[];
  onReasonFilterChange: (values: string[]) => void;
}) {
  return (
    <>
      <PermissionGuard permission="voter.viewCoordinator">
        <MultiSelectDropdown
          emptyLabel={ELECTION_DAY_TEXT.coordinatorFilter.all}
          options={coordinators.map((c) => ({ value: c, label: c }))}
          selected={coordinatorFilter}
          onChange={onCoordinatorFilterChange}
          className="md:w-52"
        />
      </PermissionGuard>
      <MultiSelectDropdown
        emptyLabel={ELECTION_DAY_TEXT.cityFilter.all}
        options={cities.map((c) => ({ value: c, label: c }))}
        selected={cityFilter}
        onChange={onCityFilterChange}
        className="md:w-52"
      />
      <PermissionGuard permission="voter.viewRideStatus">
        <MultiSelectDropdown
          emptyLabel={ELECTION_DAY_TEXT.statusFilter.all}
          options={STATUS_OPTIONS}
          selected={statusFilter}
          onChange={(values) => onStatusFilterChange(values as RideStatusFilterValue[])}
          className="md:w-52"
        />
      </PermissionGuard>
      {/* No separate permission (product decision) - same gate as the
       * voted/not-voted badge itself, which the reason is metadata of. */}
      <PermissionGuard permission="voter.viewVotedStatus">
        <MultiSelectDropdown
          emptyLabel={ELECTION_DAY_TEXT.reasonFilter.all}
          options={nonVotingReasons.map((r) => ({ value: r.id, label: r.name }))}
          selected={reasonFilter}
          onChange={onReasonFilterChange}
          className="md:w-52"
        />
      </PermissionGuard>
    </>
  );
}
