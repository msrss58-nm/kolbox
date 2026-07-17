import { useCallback, useMemo, useState } from "react";
import { CLASSIFICATION_LABELS } from "../../constants/labels";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, type Paged, type VoterSortKey } from "../../services/api";
import type { Classification, Voter } from "../../types";
import { VOTERS_TEXT } from "./voters.constants";

/**
 * Owns every piece of state the voter registry page needs: filters, the
 * fetched (and locally-patched) voter list, selection, and the
 * classify/bulk-classify mutations - so `VotersPage` stays a thin view.
 */
export function useVoterRegistry(activistId: string) {
  // ---- filters --------------------------------------------------------------
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [selectedClassifications, setSelectedClassifications] = useState<
    Classification[]
  >([]);
  const [sortBy, setSortBy] = useState<VoterSortKey>("lastName");
  const hasActiveFilters =
    selectedCities.length > 0 || selectedClassifications.length > 0;

  const resetFilters = useCallback(() => {
    setSearch("");
    setSelectedCities([]);
    setSelectedClassifications([]);
  }, []);

  // ---- reference lists (read-only, never locally mutated) -------------------
  const fetchCities = useCallback(() => api.listCities(), []);
  const fetchStations = useCallback(() => api.listStations(), []);
  const fetchActivists = useCallback(() => api.listActivists(), []);
  const { data: allCities } = useAsyncData(fetchCities);
  const { data: stations } = useAsyncData(fetchStations);
  const { data: activists } = useAsyncData(fetchActivists);

  const stationById = useMemo(
    () => new Map((stations ?? []).map((s) => [s.id, s])),
    [stations],
  );
  const activistById = useMemo(
    () => new Map((activists ?? []).map((a) => [a.id, a])),
    [activists],
  );

  // ---- pagination -------------------------------------------------------------
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<number>(APP_CONFIG.defaultVoterPageSize);

  // ---- voter list - classify/add patch this cache in place instead of ------
  // refetching, so rows don't jump/disappear mid-interaction ------------------
  const fetchVoters = useCallback(
    (): Promise<Paged<Voter>> =>
      api.listVoters({
        search: debouncedSearch,
        cities: selectedCities.length ? selectedCities : undefined,
        classifications: selectedClassifications.length
          ? selectedClassifications
          : undefined,
        sortBy,
        sortDir: sortBy === "classifiedAt" ? "desc" : "asc",
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
    [debouncedSearch, selectedCities, selectedClassifications, sortBy, page, pageSize],
  );
  const { data: votersPage, setData: setVotersPage } = useAsyncData(fetchVoters);
  const voters = votersPage?.items ?? null;
  const total = votersPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const goToPage = useCallback(
    (target: number) => setPage(Math.min(Math.max(1, target), totalPages)),
    [totalPages],
  );
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const applyChanged = useCallback(
    (changed: Voter[]) => {
      const byId = new Map(changed.map((v) => [v.id, v]));
      setVotersPage((prev) =>
        prev ? { ...prev, items: prev.items.map((v) => byId.get(v.id) ?? v) } : prev,
      );
    },
    [setVotersPage],
  );

  const addVoterLocally = useCallback(
    (voter: Voter) => {
      setVotersPage((prev) =>
        prev
          ? { items: [voter, ...prev.items], total: prev.total + 1 }
          : { items: [voter], total: 1 },
      );
    },
    [setVotersPage],
  );

  // ---- selection --------------------------------------------------------------
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Clears the selection whenever the filters or page change, and returns to
  // page 1 whenever the filters change (a fresh search shouldn't strand the
  // user on a now-out-of-range page) - a render-phase compare instead of a
  // reset effect (sanctioned alternative, see useAsyncData.ts).
  const [trackedFilters, setTrackedFilters] = useState<
    [string, string[], Classification[]]
  >([debouncedSearch, selectedCities, selectedClassifications]);
  const filtersChanged =
    trackedFilters[0] !== debouncedSearch ||
    trackedFilters[1] !== selectedCities ||
    trackedFilters[2] !== selectedClassifications;
  if (filtersChanged) {
    setTrackedFilters([debouncedSearch, selectedCities, selectedClassifications]);
    setSelected(new Set());
    if (page !== 1) setPage(1);
  }

  const [trackedPage, setTrackedPage] = useState(page);
  if (!filtersChanged && trackedPage !== page) {
    setTrackedPage(page);
    setSelected(new Set());
  }

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(
    (checked: boolean) =>
      setSelected(checked ? new Set(voters?.map((v) => v.id)) : new Set()),
    [voters],
  );

  // ---- classification mutations ------------------------------------------------
  const { run: runClassify } = useAsyncAction(
    (voterId: string, next: Classification, includeFamily: boolean) =>
      api.classifyVoter(voterId, next, activistId, { includeFamily }),
    {
      successMessage: (changed, _voterId, next) =>
        next === "unclassified"
          ? VOTERS_TEXT.toast.classificationRemoved
          : changed.length > 1
            ? VOTERS_TEXT.toast.familyClassified(
                changed.length,
                CLASSIFICATION_LABELS[next],
              )
            : VOTERS_TEXT.toast.classified(CLASSIFICATION_LABELS[next]),
    },
  );

  const classify = useCallback(
    async (voter: Voter, next: Classification, includeFamily = false) => {
      const changed = await runClassify(voter.id, next, includeFamily);
      if (changed) applyChanged(changed);
    },
    [runClassify, applyChanged],
  );

  const { run: runBulkClassify } = useAsyncAction(
    (voterIds: string[], next: Classification) =>
      api.bulkClassify(voterIds, next, activistId),
    {
      successMessage: (changed, _ids, next) =>
        VOTERS_TEXT.toast.bulkClassified(changed.length, CLASSIFICATION_LABELS[next]),
    },
  );

  const bulkClassify = useCallback(
    async (next: Classification) => {
      const changed = await runBulkClassify([...selected], next);
      if (changed) {
        applyChanged(changed);
        setSelected(new Set());
      }
    },
    [selected, runBulkClassify, applyChanged],
  );

  return {
    // filters
    search,
    setSearch,
    selectedCities,
    setSelectedCities,
    selectedClassifications,
    setSelectedClassifications,
    sortBy,
    setSortBy,
    hasActiveFilters,
    resetFilters,
    // reference data
    cities: allCities ?? [],
    stations: stations ?? [],
    stationById,
    activistById,
    // voters
    voters,
    total,
    addVoterLocally,
    // pagination
    page,
    goToPage,
    pageSize,
    setPageSize,
    totalPages,
    pageSizeOptions: APP_CONFIG.voterPageSizeOptions,
    // selection
    selected,
    toggleSelected,
    selectAll,
    clearSelection: () => setSelected(new Set()),
    // mutations
    classify,
    bulkClassify,
  };
}
