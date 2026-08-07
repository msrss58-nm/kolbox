import { X } from "lucide-react";
import { Accordion } from "../../components/ui/Accordion";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { Pagination } from "../../components/ui/Pagination";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayFilters } from "./ElectionDayFilters";
import { ElectionDayList } from "./ElectionDayList";
import { useElectionDayShell } from "./ElectionDayShell";

export function ElectionDayVotersPage() {
  const electionDay = useElectionDayShell();

  return (
    <>
      {electionDay.coordinators.length > 0 && (
        <div className="mb-6 space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 md:max-w-sm">
              <Input
                value={electionDay.search}
                onChange={(e) => electionDay.setSearch(e.target.value)}
                placeholder={ELECTION_DAY_TEXT.searchPlaceholder}
                className="pe-9"
                aria-label={ELECTION_DAY_TEXT.searchAriaLabel}
              />
              {electionDay.search && (
                <button
                  onClick={() => electionDay.setSearch("")}
                  className="absolute end-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
                  aria-label={ELECTION_DAY_TEXT.clearSearchAriaLabel}
                >
                  <X className="size-4" />
                </button>
              )}
            </div>

            <Button
              type="button"
              variant={electionDay.showUnvotedOnly ? "primary" : "secondary"}
              onClick={() => electionDay.setShowUnvotedOnly((v) => !v)}
            >
              📞 {ELECTION_DAY_TEXT.voted.showUnvotedOnly}
            </Button>
          </div>

          {/* Collapsed by default (product spec: "אזור סינון מתקפל") - a
              single-section Accordion doubles as a collapsible block without
              a bespoke expand/collapse implementation. */}
          <Accordion
            sections={[
              {
                id: "filters",
                icon: "🔍",
                label: ELECTION_DAY_TEXT.filters.sectionLabel,
                content: (
                  <div className="flex flex-wrap gap-2">
                    <ElectionDayFilters
                      coordinators={electionDay.coordinators}
                      coordinatorFilter={electionDay.coordinatorFilter}
                      onCoordinatorFilterChange={electionDay.setCoordinatorFilter}
                      cities={electionDay.cities}
                      cityFilter={electionDay.cityFilter}
                      onCityFilterChange={electionDay.setCityFilter}
                      statusFilter={electionDay.statusFilter}
                      onStatusFilterChange={electionDay.setStatusFilter}
                      nonVotingReasons={electionDay.nonVotingReasons}
                      reasonFilter={electionDay.reasonFilter}
                      onReasonFilterChange={electionDay.setReasonFilter}
                      followUpFilter={electionDay.followUpFilter}
                      onFollowUpFilterChange={electionDay.setFollowUpFilter}
                    />
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
        <ElectionDayList
          contacts={electionDay.contacts}
          hasActiveFilters={electionDay.hasActiveFilters}
          sortBy={electionDay.sortBy}
          sortDir={electionDay.sortDir}
          onSort={electionDay.toggleSort}
          onOpen={electionDay.openContact}
          nonVotingReasons={electionDay.nonVotingReasons}
        />

        <Pagination
          page={electionDay.page}
          totalPages={electionDay.totalPages}
          pageSize={electionDay.pageSize}
          pageSizeOptions={electionDay.pageSizeOptions}
          totalItems={electionDay.filteredTotal}
          onPageChange={electionDay.goToPage}
          onPageSizeChange={electionDay.setPageSize}
        />
      </div>
    </>
  );
}
