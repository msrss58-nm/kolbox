import { useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { Pagination } from "../../components/ui/Pagination";
import { CountdownHeader } from "./CountdownHeader";
import { ElectionDayContactModal } from "./ElectionDayContactModal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayDashboard } from "./ElectionDayDashboard";
import { ElectionDayFilters } from "./ElectionDayFilters";
import { ElectionDayImportButton } from "./ElectionDayImportButton";
import { ElectionDayList } from "./ElectionDayList";
import { useCountdown } from "./useCountdown";
import { useElectionDay } from "./useElectionDay";

export function ElectionDayPage() {
  const electionDay = useElectionDay();
  const countdownParts = useCountdown(electionDay.deadline);
  const [openContactId, setOpenContactId] = useState<string | null>(null);

  const openContact = electionDay.contacts?.find((c) => c.id === openContactId) ?? null;

  return (
    <div>
      <PageHeader
        title={ELECTION_DAY_TEXT.title}
        subtitle={
          electionDay.contacts
            ? ELECTION_DAY_TEXT.subtitle(electionDay.total)
            : ELECTION_DAY_TEXT.loadingSubtitle
        }
        actions={
          <ElectionDayImportButton
            onFileSelected={(file) => void electionDay.importFile(file)}
            busy={electionDay.importing}
          />
        }
      />

      <CountdownHeader
        deadline={electionDay.deadline}
        parts={countdownParts}
        onSetDeadline={(iso) => void electionDay.setElectionDayDeadline(iso)}
      />

      <ElectionDayDashboard
        stats={electionDay.stats}
        coordinatorBreakdown={electionDay.coordinatorBreakdown}
        events={electionDay.events}
        loaded={electionDay.loaded}
      />

      {electionDay.coordinators.length > 0 && (
        <ElectionDayFilters
          coordinators={electionDay.coordinators}
          coordinatorFilter={electionDay.coordinatorFilter}
          onCoordinatorFilterChange={electionDay.setCoordinatorFilter}
          cities={electionDay.cities}
          cityFilter={electionDay.cityFilter}
          onCityFilterChange={electionDay.setCityFilter}
          statusFilter={electionDay.statusFilter}
          onStatusFilterChange={electionDay.setStatusFilter}
        />
      )}

      <div className="overflow-hidden rounded-xl ring-1 ring-slate-100">
        <ElectionDayList
          contacts={electionDay.contacts}
          hasActiveFilters={electionDay.hasActiveFilters}
          sortBy={electionDay.sortBy}
          sortDir={electionDay.sortDir}
          onSort={electionDay.toggleSort}
          onOpen={setOpenContactId}
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

      <ElectionDayContactModal
        contact={openContact}
        onClose={() => setOpenContactId(null)}
        onToggleRideArranged={(contact, arranged) =>
          void electionDay.setRideArranged(contact.id, arranged)
        }
      />
    </div>
  );
}
