import { useCallback, useMemo, useState } from "react";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { api } from "../../services/api";
import { parseSpreadsheet, parseJsonFile } from "../../services/excel/excel";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { parseElectionDaySheet } from "./electionDayImport";

export interface ElectionDayStats {
  total: number;
  arranged: number;
  remaining: number;
  coveragePct: number;
}

export interface CoordinatorBreakdown {
  coordinator: string;
  total: number;
  arranged: number;
}

export type ElectionDaySortKey = "city" | "status";
export type SortDir = "asc" | "desc";
export type RideStatusFilterValue = "arranged" | "notArranged";

/** Owns the election-day ride-coordination list: import, coordinator filter,
 * ride-status mutation, and the countdown deadline - so `ElectionDayPage`
 * stays a thin view. */
export function useElectionDay() {
  const fetchContacts = useCallback(() => api.listElectionDayVoters(), []);
  const {
    data: contacts,
    setData: setContacts,
    reload: reloadContacts,
  } = useAsyncData(fetchContacts);

  const fetchDeadline = useCallback(() => api.getElectionDayDeadline(), []);
  const { data: deadline, setData: setDeadline } = useAsyncData(fetchDeadline);

  const fetchEvents = useCallback(() => api.listRideStatusEvents(), []);
  const { data: events, reload: reloadEvents } = useAsyncData(fetchEvents);

  const [coordinatorFilter, setCoordinatorFilter] = useState<string[]>([]);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<RideStatusFilterValue[]>([]);
  const hasActiveFilters =
    coordinatorFilter.length > 0 || cityFilter.length > 0 || statusFilter.length > 0;

  // A single atomic { key, dir } state - toggling both from one updater
  // avoids the unreliable pattern of calling setState from inside another
  // state updater (which the previous two-state version did).
  const [sort, setSort] = useState<{ key: ElectionDaySortKey; dir: SortDir } | null>(
    null,
  );
  const sortBy = sort?.key ?? null;
  const sortDir = sort?.dir ?? "asc";

  const toggleSort = useCallback((key: ElectionDaySortKey) => {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const coordinators = useMemo(
    () =>
      [...new Set((contacts ?? []).map((c) => c.coordinator))].sort((a, b) =>
        a.localeCompare(b, "he"),
      ),
    [contacts],
  );

  const cities = useMemo(
    () =>
      [...new Set((contacts ?? []).map((c) => c.city).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, "he"),
      ),
    [contacts],
  );

  const filteredContacts = useMemo(() => {
    let base = contacts ?? [];
    if (coordinatorFilter.length)
      base = base.filter((c) => coordinatorFilter.includes(c.coordinator));
    if (cityFilter.length) base = base.filter((c) => cityFilter.includes(c.city));
    if (statusFilter.length)
      base = base.filter((c) =>
        statusFilter.includes(c.rideArranged ? "arranged" : "notArranged"),
      );

    if (!contacts) return null;
    if (!sortBy) return base;

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (sortBy === "city") return a.city.localeCompare(b.city, "he") * dir;
      return (Number(a.rideArranged) - Number(b.rideArranged)) * dir;
    });
  }, [contacts, coordinatorFilter, cityFilter, statusFilter, sortBy, sortDir]);

  // ---- pagination -----------------------------------------------------------
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState<number>(
    APP_CONFIG.defaultElectionDayPageSize,
  );

  const filteredTotal = filteredContacts?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));

  const pagedContacts = useMemo(
    () =>
      filteredContacts
        ? filteredContacts.slice((page - 1) * pageSize, page * pageSize)
        : filteredContacts,
    [filteredContacts, page, pageSize],
  );

  const goToPage = useCallback(
    (target: number) => setPage(Math.min(Math.max(1, target), totalPages)),
    [totalPages],
  );
  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  // Returns to page 1 whenever a filter or the sort changes - a fresh filter
  // shouldn't strand the user on a now-out-of-range page. Render-phase
  // compare (sanctioned alternative to a reset effect - see useVoterRegistry.ts).
  const [trackedQuery, setTrackedQuery] = useState<
    [string[], string[], RideStatusFilterValue[], ElectionDaySortKey | null, SortDir]
  >([coordinatorFilter, cityFilter, statusFilter, sortBy, sortDir]);
  const queryChanged =
    trackedQuery[0] !== coordinatorFilter ||
    trackedQuery[1] !== cityFilter ||
    trackedQuery[2] !== statusFilter ||
    trackedQuery[3] !== sortBy ||
    trackedQuery[4] !== sortDir;
  if (queryChanged) {
    setTrackedQuery([coordinatorFilter, cityFilter, statusFilter, sortBy, sortDir]);
    if (page !== 1) setPage(1);
  }

  // Dashboard figures always reflect the full dataset, independent of the
  // coordinator filter applied to the list below.
  const stats = useMemo((): ElectionDayStats => {
    const total = contacts?.length ?? 0;
    const arranged = (contacts ?? []).filter((c) => c.rideArranged).length;
    return {
      total,
      arranged,
      remaining: total - arranged,
      coveragePct: total ? Math.round((arranged / total) * 100) : 0,
    };
  }, [contacts]);

  const coordinatorBreakdown = useMemo((): CoordinatorBreakdown[] => {
    const byCoordinator = new Map<string, CoordinatorBreakdown>();
    for (const c of contacts ?? []) {
      const entry = byCoordinator.get(c.coordinator) ?? {
        coordinator: c.coordinator,
        total: 0,
        arranged: 0,
      };
      entry.total++;
      if (c.rideArranged) entry.arranged++;
      byCoordinator.set(c.coordinator, entry);
    }
    return [...byCoordinator.values()].sort((a, b) => b.total - a.total);
  }, [contacts]);

  const { run: runImport, busy: importing } = useAsyncAction(
    async (file: File) => {
      const sheet = file.name.toLowerCase().endsWith(".json")
        ? await parseJsonFile(file)
        : await parseSpreadsheet(file);
      const rows = parseElectionDaySheet(sheet);
      return api.importElectionDayVoters(rows);
    },
    { successMessage: (result) => ELECTION_DAY_TEXT.import.toast.loaded(result.count) },
  );

  const importFile = useCallback(
    async (file: File) => {
      const result = await runImport(file);
      if (result) {
        reloadContacts();
        reloadEvents();
      }
    },
    [runImport, reloadContacts, reloadEvents],
  );

  const { run: runSetDeadline } = useAsyncAction(
    (iso: string | null) => api.setElectionDayDeadline(iso),
    { successMessage: ELECTION_DAY_TEXT.countdown.toast.saved },
  );

  const setElectionDayDeadline = useCallback(
    async (iso: string | null) => {
      const result = await runSetDeadline(iso);
      if (result !== undefined) setDeadline(result);
    },
    [runSetDeadline, setDeadline],
  );

  const { run: runSetRideArranged } = useAsyncAction(
    (id: string, arranged: boolean) => api.setRideArranged(id, arranged),
    {
      successMessage: (contact) =>
        contact.rideArranged
          ? ELECTION_DAY_TEXT.status.toast.arranged
          : ELECTION_DAY_TEXT.status.toast.notArranged,
    },
  );

  const setRideArranged = useCallback(
    async (id: string, arranged: boolean) => {
      const updated = await runSetRideArranged(id, arranged);
      if (updated) {
        setContacts((prev) =>
          prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
        );
        reloadEvents();
      }
      return updated;
    },
    [runSetRideArranged, setContacts, reloadEvents],
  );

  return {
    contacts: pagedContacts,
    total: contacts?.length ?? 0,
    filteredTotal,
    loaded: contacts !== null,
    stats,
    coordinatorBreakdown,
    events: events ?? [],
    coordinators,
    coordinatorFilter,
    setCoordinatorFilter,
    cities,
    cityFilter,
    setCityFilter,
    hasActiveFilters,
    statusFilter,
    setStatusFilter,
    sortBy,
    sortDir,
    toggleSort,
    page,
    goToPage,
    pageSize,
    setPageSize,
    totalPages,
    pageSizeOptions: APP_CONFIG.electionDayPageSizeOptions,
    importFile,
    importing,
    deadline: deadline ?? null,
    setElectionDayDeadline,
    setRideArranged,
  };
}

export type ElectionDayHook = ReturnType<typeof useElectionDay>;
