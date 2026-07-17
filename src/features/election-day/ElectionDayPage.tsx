import { useState } from "react";
import { X } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Input } from "../../components/ui/Field";
import { Pagination } from "../../components/ui/Pagination";
import { CountdownHeader } from "./CountdownHeader";
import { ElectionDayContactModal } from "./ElectionDayContactModal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ElectionDayDashboard } from "./ElectionDayDashboard";
import { ElectionDayFilters } from "./ElectionDayFilters";
import { ElectionDayImportButton } from "./ElectionDayImportButton";
import { ElectionDayList } from "./ElectionDayList";
import { RideCoordinatorsModal } from "./RideCoordinatorsModal";
import { useCountdown } from "./useCountdown";
import { useElectionDay } from "./useElectionDay";

export function ElectionDayPage() {
  const electionDay = useElectionDay();
  const countdownParts = useCountdown(electionDay.deadline);
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [coordinatorsModalOpen, setCoordinatorsModalOpen] = useState(false);

  const openContact = electionDay.contacts?.find((c) => c.id === openContactId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title={ELECTION_DAY_TEXT.title} subtitle={ELECTION_DAY_TEXT.subtitle} />

      <CountdownHeader
        deadline={electionDay.deadline}
        parts={countdownParts}
        onSetDeadline={(iso) => void electionDay.setElectionDayDeadline(iso)}
      />

      <Card className="mb-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ElectionDayImportButton
              onFileSelected={(file) => void electionDay.importFile(file)}
              busy={electionDay.importing}
            />
            <Button
              variant="danger"
              disabled={!electionDay.total}
              onClick={() => setConfirmClearOpen(true)}
            >
              🗑️ {ELECTION_DAY_TEXT.clearAll.button}
            </Button>
            <Button variant="secondary" onClick={() => setCoordinatorsModalOpen(true)}>
              👨‍💼 {ELECTION_DAY_TEXT.coordinatorsManager.button}
            </Button>
          </div>
          <Button
            className="bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
            disabled={!electionDay.total}
            onClick={electionDay.exportReport}
          >
            ⬇️ {ELECTION_DAY_TEXT.exportReport.button}
          </Button>
        </div>

        {electionDay.coordinators.length > 0 && (
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
          </div>
        )}
      </Card>

      <ElectionDayDashboard
        stats={electionDay.stats}
        coordinatorBreakdown={electionDay.coordinatorBreakdown}
        loaded={electionDay.loaded}
      >
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-100">
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
      </ElectionDayDashboard>

      <ElectionDayContactModal
        contact={openContact}
        onClose={() => setOpenContactId(null)}
        onToggleRideArranged={(contact, arranged) =>
          void electionDay.setRideArranged(contact.id, arranged)
        }
        onSetReminder={(contact, minutes) =>
          void electionDay.setReminder(contact.id, minutes)
        }
        onCancelReminder={(contact) => void electionDay.setReminder(contact.id, null)}
        onToggleVoted={(contact, voted) => void electionDay.setVoted(contact.id, voted)}
        onSetNotes={(id, notes) => void electionDay.setNotes(id, notes)}
        rideCoordinators={electionDay.rideCoordinators}
        onSendToDriver={(contact, coordinatorId) =>
          void electionDay.sendRideRequestToDriver(contact, coordinatorId)
        }
      />

      <RideCoordinatorsModal
        open={coordinatorsModalOpen}
        onClose={() => setCoordinatorsModalOpen(false)}
        coordinators={electionDay.rideCoordinators}
        onAdd={electionDay.addRideCoordinator}
        onDelete={electionDay.deleteRideCoordinator}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        title={ELECTION_DAY_TEXT.clearAll.confirmTitle}
        message={ELECTION_DAY_TEXT.clearAll.confirmMessage}
        confirmLabel={ELECTION_DAY_TEXT.clearAll.confirmButton}
        danger
        busy={electionDay.clearing}
        onConfirm={async () => {
          await electionDay.clearElectionDayData();
          setConfirmClearOpen(false);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
}
