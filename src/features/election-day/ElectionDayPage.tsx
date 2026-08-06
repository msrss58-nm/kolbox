import { useState } from "react";
import { X } from "lucide-react";
import { useOutletContext } from "react-router";
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
import type { ElectionDayOutletContext } from "./ElectionDayGuard";
import { ElectionDayImportButton } from "./ElectionDayImportButton";
import { ElectionDayList } from "./ElectionDayList";
import { useElectionDaySession } from "./electionDaySession";
import { NonVotingReasonDrillDownModal } from "./NonVotingReasonDrillDownModal";
import { NonVotingReasonsModal } from "./NonVotingReasonsModal";
import { PermissionUsersModal } from "./PermissionUsersModal";
import { RideCoordinatorsModal } from "./RideCoordinatorsModal";
import { RoleManagementModal } from "./RoleManagementModal";
import { roleDisplayName } from "./roleDisplayName";
import { usePermissions } from "../../permissions/usePermissions";
import { useCountdown } from "./useCountdown";
import { useElectionDay } from "./useElectionDay";
import { useNonVotingReasons } from "./useNonVotingReasons";
import { useRoleManagement } from "./useRoleManagement";

export function ElectionDayPage() {
  const { isBootstrap } = useOutletContext<ElectionDayOutletContext>();
  const electionDay = useElectionDay(isBootstrap);
  const countdownParts = useCountdown(electionDay.deadline);
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [coordinatorsModalOpen, setCoordinatorsModalOpen] = useState(false);
  const [permissionsModalOpen, setPermissionsModalOpen] = useState(false);
  const [rolesModalOpen, setRolesModalOpen] = useState(false);
  const [reasonsModalOpen, setReasonsModalOpen] = useState(false);
  // Which non-voting reason's drill-down is open (see
  // NonVotingReasonsReportCard / NonVotingReasonDrillDownModal) - `null` =
  // closed. Opening a voter from inside the drill-down closes this first
  // (see `onOpenVoter` below) so the single-contact modal never stacks on
  // top of it.
  const [reportReasonId, setReportReasonId] = useState<string | null>(null);
  const roleManagement = useRoleManagement();
  const reasonsManagement = useNonVotingReasons(
    electionDay.nonVotingReasons,
    electionDay.reloadNonVotingReasons,
  );

  const sessionUser = useElectionDaySession((s) => s.user);
  const logout = useElectionDaySession((s) => s.logout);
  const { can } = usePermissions();
  const showImport = can("electionDay.import");
  const showClearData = can("electionDay.clearData");
  const showManageRideCoordinators = can("electionDay.manageRideCoordinators");
  // `isBootstrap` (see ElectionDayGuard) only ever widens this one button -
  // the roster-empty "add the first account" escape hatch - never any other
  // permission below. `useElectionDay`'s `addPermissionUser` carries the
  // matching business-logic exception, so this button being visible and the
  // action it triggers actually being allowed stay in sync.
  const showManageUsers = can("electionDay.manageUsers") || isBootstrap;
  const showManageRoles = can("electionDay.manageRolesAndPermissions");
  const showManageReasons = can("electionDay.manageNonVotingReasons");
  const showExport = can("electionDay.export");
  const showControlPanelLeft =
    showImport ||
    showClearData ||
    showManageRideCoordinators ||
    showManageUsers ||
    showManageRoles ||
    showManageReasons;
  const showControlPanel = showControlPanelLeft || showExport;

  // Looks up against `allContacts` (the full, unfiltered/unpaginated fetched
  // list), not `contacts` (the filtered/paginated view the main table
  // renders) - a voter opened from elsewhere (e.g. the non-voting-reasons
  // report drill-down) is very often NOT present in the main list's current
  // filter (a "closed" reason's voter is excluded by the default "נותרו
  // לטיפול" follow-up filter, for instance), and must still be openable.
  const openContact = electionDay.allContacts.find((c) => c.id === openContactId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title={ELECTION_DAY_TEXT.title} subtitle={ELECTION_DAY_TEXT.subtitle} />

      <CountdownHeader
        deadline={electionDay.deadline}
        parts={countdownParts}
        onSetDeadline={(iso) => void electionDay.setElectionDayDeadline(iso)}
      />

      <Card className="mb-6 flex flex-col gap-4">
        {showControlPanel && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            {showControlPanelLeft && (
              <div className="flex flex-wrap items-center gap-2">
                {showImport && (
                  <ElectionDayImportButton
                    onFileSelected={(file) => setPendingImportFile(file)}
                    busy={electionDay.importing}
                  />
                )}
                {showClearData && (
                  <Button
                    variant="danger"
                    disabled={!electionDay.total}
                    onClick={() => setConfirmClearOpen(true)}
                  >
                    🗑️ {ELECTION_DAY_TEXT.clearAll.button}
                  </Button>
                )}
                {showManageRideCoordinators && (
                  <Button
                    variant="secondary"
                    onClick={() => setCoordinatorsModalOpen(true)}
                  >
                    👨‍💼 {ELECTION_DAY_TEXT.coordinatorsManager.button}
                  </Button>
                )}
                {showManageUsers && (
                  <Button
                    variant="secondary"
                    onClick={() => setPermissionsModalOpen(true)}
                  >
                    🔑 {ELECTION_DAY_TEXT.permissionsManager.button}
                  </Button>
                )}
                {showManageRoles && (
                  <Button variant="secondary" onClick={() => setRolesModalOpen(true)}>
                    🛡️ {ELECTION_DAY_TEXT.rolesManager.button}
                  </Button>
                )}
                {showManageReasons && (
                  <Button variant="secondary" onClick={() => setReasonsModalOpen(true)}>
                    🗳️ {ELECTION_DAY_TEXT.nonVotingReasonsManager.button}
                  </Button>
                )}
              </div>
            )}
            {showExport && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  className="bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
                  disabled={!electionDay.total}
                  onClick={electionDay.sendSnapshotReport}
                >
                  📲 {ELECTION_DAY_TEXT.snapshotReport.button}
                </Button>
                <Button
                  className="bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
                  disabled={!electionDay.total}
                  onClick={electionDay.exportReport}
                >
                  ⬇️ {ELECTION_DAY_TEXT.exportReport.button}
                </Button>
              </div>
            )}
          </div>
        )}

        {sessionUser && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>
              {sessionUser.name} ·{" "}
              {roleDisplayName(sessionUser.roleId, electionDay.roles)}
            </span>
            <button
              type="button"
              onClick={logout}
              className="font-semibold text-primary-600 hover:underline"
            >
              {ELECTION_DAY_TEXT.session.signOut}
            </button>
          </div>
        )}

        {showImport &&
          electionDay.lastImportSummary &&
          electionDay.lastImportSummary.rejected.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200">
              <span className="font-semibold">
                {ELECTION_DAY_TEXT.import.summary.title}:
              </span>
              <span>
                {ELECTION_DAY_TEXT.import.summary.imported(
                  electionDay.lastImportSummary.imported.length,
                )}
              </span>
              <span>
                {ELECTION_DAY_TEXT.import.summary.rejected(
                  electionDay.lastImportSummary.rejected.length,
                )}
              </span>
              <button
                type="button"
                onClick={electionDay.downloadRejectedRows}
                className="font-semibold text-amber-900 underline hover:no-underline"
              >
                {ELECTION_DAY_TEXT.import.summary.downloadButton}
              </button>
              <button
                type="button"
                onClick={electionDay.dismissImportSummary}
                className="ms-auto text-amber-600 hover:text-amber-900"
                aria-label={ELECTION_DAY_TEXT.import.summary.dismiss}
              >
                <X className="size-4" />
              </button>
            </div>
          )}

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
              nonVotingReasons={electionDay.nonVotingReasons}
              reasonFilter={electionDay.reasonFilter}
              onReasonFilterChange={electionDay.setReasonFilter}
              followUpFilter={electionDay.followUpFilter}
              onFollowUpFilterChange={electionDay.setFollowUpFilter}
            />
          </div>
        )}
      </Card>

      <ElectionDayDashboard
        stats={electionDay.stats}
        coordinatorBreakdown={electionDay.coordinatorBreakdown}
        rideCoordinationQueue={electionDay.rideCoordinationQueue}
        onToggleRideCompleted={(contact, completed) =>
          void electionDay.setRideCompleted(contact.id, completed)
        }
        nonVotingReasonReport={electionDay.nonVotingReasonReport}
        onOpenReasonReport={setReportReasonId}
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
      </ElectionDayDashboard>

      <ElectionDayContactModal
        contact={openContact}
        onClose={() => setOpenContactId(null)}
        onToggleRideRequested={(contact) => void electionDay.toggleRideRequested(contact)}
        onSendToDriver={(contact) => void electionDay.sendRideRequestToDriver(contact)}
        onCancelRideCoordination={(contact) =>
          void electionDay.cancelRideCoordination(contact)
        }
        onSetReminder={(contact, minutes) =>
          void electionDay.setReminder(contact.id, minutes)
        }
        onSetReminderAt={(contact, at) =>
          void electionDay.setReminderAt(contact.id, at.toISOString())
        }
        onCancelReminder={(contact) => void electionDay.setReminder(contact.id, null)}
        onToggleVoted={(contact, voted) => void electionDay.setVoted(contact.id, voted)}
        onSetNonVotingReason={(id, reasonId) =>
          void electionDay.setNonVotingReason(id, reasonId)
        }
        nonVotingReasons={electionDay.nonVotingReasons}
        onSetNotes={(id, notes) => void electionDay.setNotes(id, notes)}
        onSetPhone={electionDay.setPhone}
        settingPhone={electionDay.settingPhone}
        onIncrementCallAttempts={electionDay.incrementCallAttempts}
        onExtendCallAttemptsThreshold={electionDay.extendCallAttemptsThreshold}
      />

      <RideCoordinatorsModal
        open={coordinatorsModalOpen}
        onClose={() => setCoordinatorsModalOpen(false)}
        coordinators={electionDay.rideCoordinators}
        onAdd={electionDay.addRideCoordinator}
        onDelete={electionDay.deleteRideCoordinator}
      />

      <PermissionUsersModal
        open={permissionsModalOpen}
        onClose={() => setPermissionsModalOpen(false)}
        users={electionDay.permissionUsers}
        roles={electionDay.roles}
        onAdd={electionDay.addPermissionUser}
        onDelete={electionDay.deletePermissionUser}
      />

      <RoleManagementModal
        open={rolesModalOpen}
        onClose={() => setRolesModalOpen(false)}
        permissionUsers={electionDay.permissionUsers}
        roleManagement={roleManagement}
      />

      <NonVotingReasonsModal
        open={reasonsModalOpen}
        onClose={() => setReasonsModalOpen(false)}
        contacts={electionDay.allContacts}
        reasonsManagement={reasonsManagement}
      />

      <NonVotingReasonDrillDownModal
        open={reportReasonId !== null}
        onClose={() => setReportReasonId(null)}
        row={
          electionDay.nonVotingReasonReport.find((r) => r.reasonId === reportReasonId) ??
          null
        }
        onOpenVoter={(id) => {
          setReportReasonId(null);
          setOpenContactId(id);
        }}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        title={ELECTION_DAY_TEXT.clearAll.confirmTitle}
        message={ELECTION_DAY_TEXT.clearAll.confirmMessage}
        confirmLabel={ELECTION_DAY_TEXT.clearAll.confirmButton}
        danger
        busy={electionDay.clearing}
        onConfirm={async () => {
          // A blocked (no permission) or failed clear resolves to
          // `undefined` - the dialog must stay open, not close as if the
          // data had actually been wiped.
          const result = await electionDay.clearElectionDayData();
          if (result !== undefined) setConfirmClearOpen(false);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />

      <ConfirmDialog
        open={pendingImportFile !== null}
        title={ELECTION_DAY_TEXT.import.confirmTitle}
        message={ELECTION_DAY_TEXT.import.confirmMessage}
        confirmLabel={ELECTION_DAY_TEXT.import.confirmButton}
        danger
        busy={electionDay.importing}
        onConfirm={async () => {
          if (!pendingImportFile) return;
          // Same as clear-data above: a blocked or failed import resolves
          // to `undefined` - keep the dialog open rather than close it as
          // if the file had actually been loaded.
          const result = await electionDay.importFile(pendingImportFile);
          if (result !== undefined) setPendingImportFile(null);
        }}
        onCancel={() => setPendingImportFile(null)}
      />
    </div>
  );
}
