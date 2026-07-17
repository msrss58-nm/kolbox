import { useState } from "react";
import { Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { PageHeader } from "../../components/PageHeader";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Pagination } from "../../components/ui/Pagination";
import { useAuth } from "../auth/authStore";
import { AddVoterModal } from "./AddVoterModal";
import { BulkActionsBar } from "./BulkActionsBar";
import { useVoterRegistry } from "./useVoterRegistry";
import { VOTERS_TEXT } from "./voters.constants";
import { VoterDrawer } from "./VoterDrawer";
import { VoterFilters } from "./VoterFilters";
import { VoterList } from "./VoterList";
import { VoterListHeader } from "./VoterListHeader";

export function VotersPage() {
  const user = useAuth((s) => s.user);
  const activistId = user?.activistId ?? "act-1";
  const registry = useVoterRegistry(activistId);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drawerVoterId, setDrawerVoterId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const drawerVoter = registry.voters?.find((v) => v.id === drawerVoterId) ?? null;
  const isFiltered = registry.hasActiveFilters || registry.search !== "";

  return (
    <div>
      <PageHeader
        title={VOTERS_TEXT.title}
        subtitle={
          registry.voters
            ? VOTERS_TEXT.subtitle(registry.total, isFiltered)
            : VOTERS_TEXT.loadingSubtitle
        }
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {VOTERS_TEXT.addVoter}
          </Button>
        }
      />

      {/* Search + filters bar */}
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1 md:max-w-sm">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={registry.search}
            onChange={(e) => registry.setSearch(e.target.value)}
            placeholder={VOTERS_TEXT.searchPlaceholder}
            className="ps-10"
            aria-label={VOTERS_TEXT.searchAriaLabel}
          />
          {registry.search && (
            <button
              onClick={() => registry.setSearch("")}
              className="absolute end-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-slate-400 hover:bg-slate-100"
              aria-label={VOTERS_TEXT.clearSearchAriaLabel}
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        <VoterFilters
          variant="compact"
          selectedCities={registry.selectedCities}
          onCitiesChange={registry.setSelectedCities}
          selectedClassifications={registry.selectedClassifications}
          onClassificationsChange={registry.setSelectedClassifications}
          sortBy={registry.sortBy}
          onSortByChange={registry.setSortBy}
          cities={registry.cities}
        />

        <Button
          variant="secondary"
          className="md:hidden"
          onClick={() => setFiltersOpen(true)}
          aria-label={VOTERS_TEXT.filtersAriaLabel}
        >
          <SlidersHorizontal className="size-4" />
          {registry.hasActiveFilters && (
            <span className="size-2 rounded-full bg-primary-500" aria-hidden />
          )}
        </Button>
      </div>

      {registry.selected.size > 0 && (
        <BulkActionsBar
          selectedCount={registry.selected.size}
          onClassify={(c) => void registry.bulkClassify(c)}
          onClear={registry.clearSelection}
        />
      )}

      <div className="overflow-hidden rounded-xl ring-1 ring-slate-100">
        <VoterListHeader
          allSelected={
            registry.voters !== null &&
            registry.voters.length > 0 &&
            registry.selected.size === registry.voters.length
          }
          onSelectAll={registry.selectAll}
        />

        <VoterList
          voters={registry.voters}
          selected={registry.selected}
          onToggleSelect={registry.toggleSelected}
          onOpen={setDrawerVoterId}
          onClassify={(voter, c) => void registry.classify(voter, c)}
          showResetFilters={isFiltered}
          onResetFilters={registry.resetFilters}
        />

        <Pagination
          page={registry.page}
          totalPages={registry.totalPages}
          pageSize={registry.pageSize}
          pageSizeOptions={registry.pageSizeOptions}
          totalItems={registry.total}
          onPageChange={registry.goToPage}
          onPageSizeChange={registry.setPageSize}
        />
      </div>

      {/* Mobile filters bottom sheet */}
      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title={VOTERS_TEXT.filtersSheetTitle}
      >
        <div className="space-y-4">
          <VoterFilters
            variant="full"
            selectedCities={registry.selectedCities}
            onCitiesChange={registry.setSelectedCities}
            selectedClassifications={registry.selectedClassifications}
            onClassificationsChange={registry.setSelectedClassifications}
            sortBy={registry.sortBy}
            onSortByChange={registry.setSortBy}
            cities={registry.cities}
          />
          <Button className="w-full" onClick={() => setFiltersOpen(false)}>
            {VOTERS_TEXT.showResults(registry.total)}
          </Button>
        </div>
      </Modal>

      <VoterDrawer
        voter={drawerVoter}
        station={
          drawerVoter
            ? (registry.stationById.get(drawerVoter.pollingStationId) ?? null)
            : null
        }
        activistById={registry.activistById}
        onClose={() => setDrawerVoterId(null)}
        onClassify={(c, includeFamily) =>
          drawerVoter && void registry.classify(drawerVoter, c, includeFamily)
        }
      />

      <AddVoterModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        cities={registry.cities}
        stations={registry.stations}
        onAdded={registry.addVoterLocally}
      />
    </div>
  );
}
