import { useMemo } from "react";
import { Field, Select } from "../../components/ui/Field";
import { MultiSelectDropdown } from "../../components/ui/MultiSelectDropdown";
import { CLASSIFICATION_LABELS, CLASSIFICATIONS } from "../../constants/labels";
import type { VoterSortKey } from "../../services/api";
import type { Classification } from "../../types";
import { SORT_LABELS, VOTERS_TEXT } from "./voters.constants";

interface VoterFiltersProps {
  /** compact = bare inline controls (desktop toolbar); full = labeled stack (mobile sheet). */
  variant: "compact" | "full";
  selectedCities: string[];
  onCitiesChange: (values: string[]) => void;
  selectedClassifications: Classification[];
  onClassificationsChange: (values: Classification[]) => void;
  sortBy: VoterSortKey;
  onSortByChange: (value: VoterSortKey) => void;
  cities: string[];
}

const SORT_KEYS = Object.keys(SORT_LABELS) as VoterSortKey[];

export function VoterFilters({
  variant,
  selectedCities,
  onCitiesChange,
  selectedClassifications,
  onClassificationsChange,
  sortBy,
  onSortByChange,
  cities,
}: VoterFiltersProps) {
  const cityOptions = useMemo(
    () => cities.map((c) => ({ value: c, label: c })),
    [cities],
  );
  const classificationOptions = useMemo(
    () => CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABELS[c] })),
    [],
  );

  if (variant === "full") {
    return (
      <>
        <Field label={VOTERS_TEXT.columns.city}>
          <MultiSelectDropdown
            emptyLabel={VOTERS_TEXT.allCities}
            options={cityOptions}
            selected={selectedCities}
            onChange={onCitiesChange}
          />
        </Field>
        <Field label={VOTERS_TEXT.columns.classification}>
          <MultiSelectDropdown
            emptyLabel={VOTERS_TEXT.allClassifications}
            options={classificationOptions}
            selected={selectedClassifications}
            onChange={(values) => onClassificationsChange(values as Classification[])}
          />
        </Field>
        <Field label="מיון לפי">
          <Select
            value={sortBy}
            onChange={(e) => onSortByChange(e.target.value as VoterSortKey)}
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {SORT_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
      </>
    );
  }

  return (
    <div className="hidden items-end gap-2 md:flex">
      <MultiSelectDropdown
        emptyLabel={VOTERS_TEXT.allCities}
        options={cityOptions}
        selected={selectedCities}
        onChange={onCitiesChange}
        className="w-40"
      />
      <MultiSelectDropdown
        emptyLabel={VOTERS_TEXT.allClassifications}
        options={classificationOptions}
        selected={selectedClassifications}
        onChange={(values) => onClassificationsChange(values as Classification[])}
        className="w-36"
      />
      <Select
        value={sortBy}
        onChange={(e) => onSortByChange(e.target.value as VoterSortKey)}
        className="w-36"
      >
        {SORT_KEYS.map((k) => (
          <option key={k} value={k}>
            {VOTERS_TEXT.sortByPrefix} {SORT_LABELS[k]}
          </option>
        ))}
      </Select>
    </div>
  );
}
