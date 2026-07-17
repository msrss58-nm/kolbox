import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { whatsAppHref } from "../../lib/phone";
import { api } from "../../services/api";
import type { NewRideCoordinator } from "../../services/api";
import {
  exportElectionDayVotersToExcel,
  parseSpreadsheet,
  parseJsonFile,
} from "../../services/excel/excel";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { parseElectionDaySheet } from "./electionDayImport";

export interface ElectionDayStats {
  total: number;
  arranged: number;
  remaining: number;
  coveragePct: number;
  voted: number;
  notVoted: number;
  votedPct: number;
}

export interface CoordinatorBreakdown {
  coordinator: string;
  total: number;
  arranged: number;
  voted: number;
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

  const fetchRideCoordinators = useCallback(() => api.listRideCoordinators(), []);
  const { data: rideCoordinators, reload: reloadRideCoordinators } =
    useAsyncData(fetchRideCoordinators);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [coordinatorFilter, setCoordinatorFilter] = useState<string[]>([]);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<RideStatusFilterValue[]>([]);
  const [showUnvotedOnly, setShowUnvotedOnly] = useState(false);
  const hasActiveFilters =
    debouncedSearch.trim() !== "" ||
    coordinatorFilter.length > 0 ||
    cityFilter.length > 0 ||
    statusFilter.length > 0 ||
    showUnvotedOnly;

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
    const s = debouncedSearch.trim();
    if (s) {
      const sLower = s.toLowerCase();
      const sDigits = s.replace(/\D/g, "");
      base = base.filter(
        (c) =>
          `${c.firstName} ${c.lastName}`.toLowerCase().includes(sLower) ||
          (sDigits && c.phone.replace(/\D/g, "").includes(sDigits)),
      );
    }
    if (coordinatorFilter.length)
      base = base.filter((c) => coordinatorFilter.includes(c.coordinator));
    if (cityFilter.length) base = base.filter((c) => cityFilter.includes(c.city));
    if (statusFilter.length)
      base = base.filter((c) =>
        statusFilter.includes(c.rideArranged ? "arranged" : "notArranged"),
      );
    if (showUnvotedOnly) base = base.filter((c) => !c.voted);

    if (!contacts) return null;
    if (!sortBy) return base;

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      if (sortBy === "city") return a.city.localeCompare(b.city, "he") * dir;
      return (Number(a.rideArranged) - Number(b.rideArranged)) * dir;
    });
  }, [
    contacts,
    debouncedSearch,
    coordinatorFilter,
    cityFilter,
    statusFilter,
    showUnvotedOnly,
    sortBy,
    sortDir,
  ]);

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
    [
      string,
      string[],
      string[],
      RideStatusFilterValue[],
      boolean,
      ElectionDaySortKey | null,
      SortDir,
    ]
  >([
    debouncedSearch,
    coordinatorFilter,
    cityFilter,
    statusFilter,
    showUnvotedOnly,
    sortBy,
    sortDir,
  ]);
  const queryChanged =
    trackedQuery[0] !== debouncedSearch ||
    trackedQuery[1] !== coordinatorFilter ||
    trackedQuery[2] !== cityFilter ||
    trackedQuery[3] !== statusFilter ||
    trackedQuery[4] !== showUnvotedOnly ||
    trackedQuery[5] !== sortBy ||
    trackedQuery[6] !== sortDir;
  if (queryChanged) {
    setTrackedQuery([
      debouncedSearch,
      coordinatorFilter,
      cityFilter,
      statusFilter,
      showUnvotedOnly,
      sortBy,
      sortDir,
    ]);
    if (page !== 1) setPage(1);
  }

  // Dashboard figures always reflect the full dataset, independent of the
  // coordinator filter applied to the list below.
  const stats = useMemo((): ElectionDayStats => {
    const total = contacts?.length ?? 0;
    const arranged = (contacts ?? []).filter((c) => c.rideArranged).length;
    const voted = (contacts ?? []).filter((c) => c.voted).length;
    return {
      total,
      arranged,
      remaining: total - arranged,
      coveragePct: total ? Math.round((arranged / total) * 100) : 0,
      voted,
      notVoted: total - voted,
      votedPct: total ? Math.round((voted / total) * 100) : 0,
    };
  }, [contacts]);

  const coordinatorBreakdown = useMemo((): CoordinatorBreakdown[] => {
    const byCoordinator = new Map<string, CoordinatorBreakdown>();
    for (const c of contacts ?? []) {
      const entry = byCoordinator.get(c.coordinator) ?? {
        coordinator: c.coordinator,
        total: 0,
        arranged: 0,
        voted: 0,
      };
      entry.total++;
      if (c.rideArranged) entry.arranged++;
      if (c.voted) entry.voted++;
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

  const { run: runClearAll, busy: clearing } = useAsyncAction(
    () => api.clearElectionDayVoters(),
    { successMessage: ELECTION_DAY_TEXT.clearAll.toast.cleared },
  );

  const clearElectionDayData = useCallback(async () => {
    await runClearAll();
    reloadContacts();
    reloadEvents();
  }, [runClearAll, reloadContacts, reloadEvents]);

  const exportReport = useCallback(() => {
    if (!contacts || contacts.length === 0) {
      toast.info(ELECTION_DAY_TEXT.exportReport.toast.empty);
      return;
    }
    exportElectionDayVotersToExcel(contacts);
  }, [contacts]);

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

  const applyContactUpdate = useCallback(
    (updated: ElectionDayVoter) => {
      setContacts((prev) =>
        prev ? prev.map((c) => (c.id === updated.id ? updated : c)) : prev,
      );
    },
    [setContacts],
  );

  const { run: runSetReminder } = useAsyncAction(
    (id: string, minutes: number | null) => api.setReminder(id, minutes),
    {
      successMessage: (_contact, _id, minutes) =>
        minutes === null
          ? ELECTION_DAY_TEXT.reminder.toast.cancelled
          : ELECTION_DAY_TEXT.reminder.toast.set(
              ELECTION_DAY_TEXT.reminder.options[
                minutes as keyof typeof ELECTION_DAY_TEXT.reminder.options
              ],
            ),
    },
  );

  const setReminder = useCallback(
    async (id: string, minutes: number | null) => {
      const updated = await runSetReminder(id, minutes);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetReminder, applyContactUpdate],
  );

  const { run: runSetVoted } = useAsyncAction(
    (id: string, voted: boolean) => api.setVoted(id, voted),
    {
      successMessage: (contact) =>
        contact.voted
          ? ELECTION_DAY_TEXT.voted.toast.voted
          : ELECTION_DAY_TEXT.voted.toast.notVoted,
    },
  );

  const setVoted = useCallback(
    async (id: string, voted: boolean) => {
      const updated = await runSetVoted(id, voted);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetVoted, applyContactUpdate],
  );

  const { run: runSetNotes } = useAsyncAction((id: string, notes: string) =>
    api.setElectionDayNotes(id, notes),
  );

  const setNotes = useCallback(
    async (id: string, notes: string) => {
      const updated = await runSetNotes(id, notes);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetNotes, applyContactUpdate],
  );

  const { run: runAddRideCoordinator } = useAsyncAction(
    (input: NewRideCoordinator) => api.addRideCoordinator(input),
    { successMessage: ELECTION_DAY_TEXT.coordinatorsManager.toast.added },
  );

  const addRideCoordinator = useCallback(
    async (input: NewRideCoordinator) => {
      const result = await runAddRideCoordinator(input);
      if (result) reloadRideCoordinators();
      return result;
    },
    [runAddRideCoordinator, reloadRideCoordinators],
  );

  const { run: runDeleteRideCoordinator } = useAsyncAction(
    (id: string) => api.deleteRideCoordinator(id),
    { successMessage: ELECTION_DAY_TEXT.coordinatorsManager.toast.deleted },
  );

  const deleteRideCoordinator = useCallback(
    async (id: string) => {
      await runDeleteRideCoordinator(id);
      reloadRideCoordinators();
    },
    [runDeleteRideCoordinator, reloadRideCoordinators],
  );

  /** Opens WhatsApp (pre-filled, one tap from sending) to a chosen fixed
   * ride-coordinator with the voter's full pickup details, then marks the
   * ride as arranged and stamps the notes field - matching the reference
   * app's driver-request flow, but routed to a pre-registered contact
   * instead of a one-off typed name. */
  const sendRideRequestToDriver = useCallback(
    async (contact: ElectionDayVoter, coordinatorId: string) => {
      const driver = (rideCoordinators ?? []).find((c) => c.id === coordinatorId);
      if (!driver) return;
      const address = [contact.street, contact.houseNumber || "", contact.city]
        .filter(Boolean)
        .join(" ");
      const message = ELECTION_DAY_TEXT.driver.message({
        name: `${contact.firstName} ${contact.lastName}`,
        address,
        phone: contact.phone,
        masad: contact.masad,
        coordinator: contact.coordinator,
      });
      window.open(whatsAppHref(driver.phone, message), "_blank", "noreferrer");
      await Promise.all([
        setRideArranged(contact.id, true),
        setNotes(contact.id, ELECTION_DAY_TEXT.driver.rideArrangedNote),
      ]);
      toast.success(ELECTION_DAY_TEXT.driver.toast.sent(driver.name));
    },
    [rideCoordinators, setRideArranged, setNotes],
  );

  // Polls for due reminders and fires a toast for each (clearing it so it
  // doesn't repeat) - only while this tab is open, no browser-notification
  // permission involved. Reads the latest contacts via a ref so the interval
  // itself never needs to be torn down/recreated when the list changes.
  const contactsRef = useRef(contacts);
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    const checkReminders = () => {
      const due = (contactsRef.current ?? []).filter(
        (c) => c.reminderAt && new Date(c.reminderAt).getTime() <= Date.now(),
      );
      for (const c of due) {
        toast.info(
          ELECTION_DAY_TEXT.reminder.toast.due(
            `${c.firstName} ${c.lastName}`,
            c.coordinator,
          ),
        );
        void api.setReminder(c.id, null).then(applyContactUpdate);
      }
    };
    const id = setInterval(checkReminders, 15_000);
    return () => clearInterval(id);
  }, [applyContactUpdate]);

  return {
    contacts: pagedContacts,
    total: contacts?.length ?? 0,
    filteredTotal,
    loaded: contacts !== null,
    search,
    setSearch,
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
    showUnvotedOnly,
    setShowUnvotedOnly,
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
    clearElectionDayData,
    clearing,
    exportReport,
    deadline: deadline ?? null,
    setElectionDayDeadline,
    setRideArranged,
    setReminder,
    setVoted,
    setNotes,
    rideCoordinators: rideCoordinators ?? [],
    addRideCoordinator,
    deleteRideCoordinator,
    sendRideRequestToDriver,
  };
}

export type ElectionDayHook = ReturnType<typeof useElectionDay>;
