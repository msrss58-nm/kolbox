import { MultiSelectDropdown } from "../../components/ui/MultiSelectDropdown";
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
}: {
  coordinators: string[];
  coordinatorFilter: string[];
  onCoordinatorFilterChange: (values: string[]) => void;
  cities: string[];
  cityFilter: string[];
  onCityFilterChange: (values: string[]) => void;
  statusFilter: RideStatusFilterValue[];
  onStatusFilterChange: (values: RideStatusFilterValue[]) => void;
}) {
  return (
    <>
      <MultiSelectDropdown
        emptyLabel={ELECTION_DAY_TEXT.coordinatorFilter.all}
        options={coordinators.map((c) => ({ value: c, label: c }))}
        selected={coordinatorFilter}
        onChange={onCoordinatorFilterChange}
        className="md:w-52"
      />
      <MultiSelectDropdown
        emptyLabel={ELECTION_DAY_TEXT.cityFilter.all}
        options={cities.map((c) => ({ value: c, label: c }))}
        selected={cityFilter}
        onChange={onCityFilterChange}
        className="md:w-52"
      />
      <MultiSelectDropdown
        emptyLabel={ELECTION_DAY_TEXT.statusFilter.all}
        options={STATUS_OPTIONS}
        selected={statusFilter}
        onChange={(values) => onStatusFilterChange(values as RideStatusFilterValue[])}
        className="md:w-52"
      />
    </>
  );
}
