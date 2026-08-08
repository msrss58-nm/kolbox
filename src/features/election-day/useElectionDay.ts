import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../components/ui/Toast";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { whatsAppShareHref } from "../../lib/phone";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api } from "../../services/api";
import type { NewPermissionUser, NewRideCoordinator } from "../../services/api";
import {
  exportElectionDayVotersToExcel,
  parseSpreadsheet,
  parseJsonFile,
} from "../../services/excel/excel";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDaySession } from "./electionDaySession";
import { resolveVisibleContacts } from "./electionDayScope";
import { matchesElectionDaySearch } from "./electionDaySearch";
import {
  exportRejectedElectionDayRowsToExcel,
  parseElectionDaySheet,
  type ElectionDayImportResult,
} from "./electionDayImport";
import { addNoteTag, hasNoteTag, removeNoteTag } from "./notesTags";
import { resolveFollowUpStatus, type FollowUpStatus } from "./followUpStatus";
import { buildClosedReasonBreakdown } from "./closedReasonBreakdown";
import { buildNonVotingReasonReport } from "./nonVotingReasonReport";
import { formatReminderDisplay } from "./reminderDisplay";

export interface ElectionDayStats {
  total: number;
  arranged: number;
  /** Coordinator worklist's "still needs follow-up" count (see
   * `followUpStatus.ts`) - NOT ride-arrangement remaining. This field
   * existed before the worklist feature but had no consumer anywhere in the
   * app, so its meaning is repurposed here rather than adding a
   * same-shaped duplicate field. `total` above doubles as "assigned" for
   * worklist purposes - no separate field needed for that. */
  remaining: number;
  /** Coordinator worklist's "case closed, no further follow-up" count. */
  closed: number;
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

/** Where a contact sits in the ride-coordination table's pipeline - lower
 * numbers surface first (least progressed, most in need of attention). */
function ridePipelineStage(c: ElectionDayVoter): number {
  if (c.rideCompleted) return 2;
  if (c.rideArranged) return 1;
  return 0; // only rideRequested
}

/** Owns the election-day ride-coordination list: import, coordinator filter,
 * ride-status mutation, and the countdown deadline - so `ElectionDayPage`
 * stays a thin view.
 *
 * @param isBootstrap - from `ElectionDayGuard`'s Outlet context: true only
 * while the `PermissionUser` roster is empty and no one is signed in. Used
 * exclusively to allow `addPermissionUser` (create the first account) - see
 * that function below. Not a role, not passed to anything else. */
export function useElectionDay(isBootstrap: boolean) {
  const { can, role, catalogStatus, roles } = usePermissions();

  /** Every mutation exposed by this hook goes through this - checks
   * `permission` before calling `action` at all: on denial, 0 API calls,
   * 0 state changes, an audit entry, and a Hebrew toast; the returned
   * function's `Promise<R | undefined>` shape is unchanged from before
   * (matches `useAsyncAction`'s own "undefined on failure" contract), so no
   * consumer needs to change how it reads the result. */
  function guardedAction<Args extends unknown[], R>(
    permission: Permission,
    action: (...args: Args) => Promise<R>,
    context: string,
  ): (...args: Args) => Promise<R | undefined> {
    return async (...args: Args) => {
      if (!can(permission)) {
        reportPermissionDenied({ role, permission, context });
        toast.error(ELECTION_DAY_TEXT.permissionDenied);
        return undefined;
      }
      return action(...args);
    };
  }

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

  // Live cross-device sync (Supabase Realtime) - another device changing a
  // contact or ride-status event refetches here too. Just a plain refetch,
  // not a merge of the live payload into local state - simpler and safer
  // for this internal tool's scale (see subscribeToElectionDayChanges).
  useEffect(() => {
    const unsubscribe = api.subscribeToElectionDayChanges?.(() => {
      reloadContacts();
      reloadEvents();
    });
    return unsubscribe;
  }, [reloadContacts, reloadEvents]);

  const fetchRideCoordinators = useCallback(() => api.listRideCoordinators(), []);
  const { data: rideCoordinators, reload: reloadRideCoordinators } =
    useAsyncData(fetchRideCoordinators);

  const fetchPermissionUsers = useCallback(() => api.listPermissionUsers(), []);
  const { data: permissionUsers, reload: reloadPermissionUsers } =
    useAsyncData(fetchPermissionUsers);

  // Dynamic Non-Voting Reasons: not security-critical (unlike `roles`) so
  // just a plain `useAsyncData` fetch, no dedicated catalog-status state
  // machine - nothing downstream makes a fail-closed access decision based
  // on this list.
  const fetchNonVotingReasons = useCallback(() => api.listNonVotingReasons(), []);
  const { data: nonVotingReasons, reload: reloadNonVotingReasons } =
    useAsyncData(fetchNonVotingReasons);

  // Which contacts a signed-in session sees is governed by its resolved
  // role's `scopeType` (Dynamic Roles & Permissions Phase 1) - fail-closed
  // via `resolveVisibleContacts`: only an explicit `scopeType === "all"`
  // sees everything; loading/error/an unmatched role/an unrecognized scope
  // all return `[]`, never the unfiltered list. Single choke point every
  // derived value below reads through instead of `contacts` directly.
  const sessionUser = useElectionDaySession((s) => s.user);
  const scopedContacts = useMemo(
    () => resolveVisibleContacts(contacts, sessionUser, catalogStatus, role),
    [contacts, sessionUser, catalogStatus, role],
  );

  // Single source of truth for id -> NonVotingReason lookups - shared by
  // `stats`, `filteredContacts`'s follow-up filter, and anything else below
  // that needs to resolve a contact's `notVotingReasonId` without
  // re-scanning the catalog array each time.
  const reasonsById = useMemo(
    () => new Map((nonVotingReasons ?? []).map((r) => [r.id, r])),
    [nonVotingReasons],
  );

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [coordinatorFilter, setCoordinatorFilter] = useState<string[]>([]);
  const [cityFilter, setCityFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<RideStatusFilterValue[]>([]);
  const [reasonFilter, setReasonFilter] = useState<string[]>([]);
  const [showUnvotedOnly, setShowUnvotedOnly] = useState(false);
  // Coordinator worklist filter (additive - does not replace
  // `showUnvotedOnly`, which stays exactly as-is). Defaults to "remaining"
  // only, matching the worklist's default "what still needs attention" view.
  // Typed as `FollowUpStatus[]` (not a loose `string[]`) - same pattern as
  // `statusFilter`/`RideStatusFilterValue[]` above.
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpStatus[]>(["remaining"]);
  const hasActiveFilters =
    debouncedSearch.trim() !== "" ||
    coordinatorFilter.length > 0 ||
    cityFilter.length > 0 ||
    statusFilter.length > 0 ||
    reasonFilter.length > 0 ||
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
      [...new Set((scopedContacts ?? []).map((c) => c.coordinator))].sort((a, b) =>
        a.localeCompare(b, "he"),
      ),
    [scopedContacts],
  );

  const cities = useMemo(
    () =>
      [...new Set((scopedContacts ?? []).map((c) => c.city).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, "he"),
      ),
    [scopedContacts],
  );

  const filteredContacts = useMemo(() => {
    let base = scopedContacts ?? [];
    if (debouncedSearch.trim()) {
      base = base.filter((c) => matchesElectionDaySearch(c, debouncedSearch));
    }
    if (coordinatorFilter.length)
      base = base.filter((c) => coordinatorFilter.includes(c.coordinator));
    if (cityFilter.length) base = base.filter((c) => cityFilter.includes(c.city));
    if (statusFilter.length)
      base = base.filter((c) =>
        statusFilter.includes(c.rideArranged ? "arranged" : "notArranged"),
      );
    if (reasonFilter.length)
      base = base.filter(
        (c) => c.notVotingReasonId && reasonFilter.includes(c.notVotingReasonId),
      );
    if (showUnvotedOnly) base = base.filter((c) => !c.voted);
    if (followUpFilter.length > 0)
      base = base.filter((c) =>
        followUpFilter.includes(resolveFollowUpStatus(c, reasonsById)),
      );

    if (!scopedContacts) return null;

    // Voted contacts always sink to the bottom, regardless of the active
    // sort - keeps whoever's left to call at the top of the list.
    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const votedDiff = Number(a.voted) - Number(b.voted);
      if (votedDiff !== 0) return votedDiff;
      if (!sortBy) return 0;
      if (sortBy === "city") return a.city.localeCompare(b.city, "he") * dir;
      return (Number(a.rideArranged) - Number(b.rideArranged)) * dir;
    });
  }, [
    scopedContacts,
    debouncedSearch,
    coordinatorFilter,
    cityFilter,
    statusFilter,
    reasonFilter,
    showUnvotedOnly,
    followUpFilter,
    reasonsById,
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
      string[],
      boolean,
      FollowUpStatus[],
      ElectionDaySortKey | null,
      SortDir,
    ]
  >([
    debouncedSearch,
    coordinatorFilter,
    cityFilter,
    statusFilter,
    reasonFilter,
    showUnvotedOnly,
    followUpFilter,
    sortBy,
    sortDir,
  ]);
  const queryChanged =
    trackedQuery[0] !== debouncedSearch ||
    trackedQuery[1] !== coordinatorFilter ||
    trackedQuery[2] !== cityFilter ||
    trackedQuery[3] !== statusFilter ||
    trackedQuery[4] !== reasonFilter ||
    trackedQuery[5] !== showUnvotedOnly ||
    trackedQuery[6] !== followUpFilter ||
    trackedQuery[7] !== sortBy ||
    trackedQuery[8] !== sortDir;
  if (queryChanged) {
    setTrackedQuery([
      debouncedSearch,
      coordinatorFilter,
      cityFilter,
      statusFilter,
      reasonFilter,
      showUnvotedOnly,
      followUpFilter,
      sortBy,
      sortDir,
    ]);
    if (page !== 1) setPage(1);
  }

  // Dashboard figures reflect the signed-in session's scope ("user" sees
  // only their own coordinator's contacts) - independent of the coordinator
  // FILTER control applied to the list below, which is a separate, narrower
  // view on top of this scope.
  const stats = useMemo((): ElectionDayStats => {
    const total = scopedContacts?.length ?? 0;
    const arranged = (scopedContacts ?? []).filter((c) => c.rideArranged).length;
    const voted = (scopedContacts ?? []).filter((c) => c.voted).length;
    let closed = 0;
    let remaining = 0;
    for (const c of scopedContacts ?? []) {
      const status = resolveFollowUpStatus(c, reasonsById);
      if (status === "closed") closed++;
      else if (status === "remaining") remaining++;
    }
    return {
      total,
      arranged,
      remaining,
      closed,
      coveragePct: total ? Math.round((arranged / total) * 100) : 0,
      voted,
      notVoted: total - voted,
      // Raw, unrounded ratio - rounding is a display concern (fmtVotedPct),
      // not part of this calculation, so it's never applied here.
      votedPct: total ? (voted / total) * 100 : 0,
    };
  }, [scopedContacts, reasonsById]);

  // Reason -> coordinator -> voter drill-down for the dashboard's "סיבות
  // אי-הצבעה" report card. Reads through `scopedContacts` (session scope),
  // independent of the list's own filters/pagination.
  const nonVotingReasonReport = useMemo(
    () => buildNonVotingReasonReport(scopedContacts ?? [], nonVotingReasons ?? []),
    [scopedContacts, nonVotingReasons],
  );

  // Dashboard KPI row 2's "closed by reason" tiles - reads through the same
  // `reasonsById`/`resolveFollowUpStatus` the `stats.closed` total above
  // uses, so the two can never disagree.
  const closedReasonBreakdown = useMemo(
    () =>
      buildClosedReasonBreakdown(
        scopedContacts ?? [],
        nonVotingReasons ?? [],
        reasonsById,
      ),
    [scopedContacts, nonVotingReasons, reasonsById],
  );

  const coordinatorBreakdown = useMemo((): CoordinatorBreakdown[] => {
    const byCoordinator = new Map<string, CoordinatorBreakdown>();
    for (const c of scopedContacts ?? []) {
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
  }, [scopedContacts]);

  // Everyone who either needs a ride or has one coordinated, and hasn't
  // voted yet - shown in the dashboard's ride-coordination table. Sorted by
  // stage (just requested → coordinated → completed) so the least-progressed
  // rows surface first; voting removes the contact from this list entirely.
  const rideCoordinationQueue = useMemo(
    () =>
      (scopedContacts ?? [])
        .filter((c) => (c.rideRequested || c.rideArranged) && !c.voted)
        .sort((a, b) => ridePipelineStage(a) - ridePipelineStage(b)),
    [scopedContacts],
  );

  const [lastImportSummary, setLastImportSummary] =
    useState<ElectionDayImportResult | null>(null);

  const { run: runImport, busy: importing } = useAsyncAction(
    async (file: File) => {
      const sheet = file.name.toLowerCase().endsWith(".json")
        ? await parseJsonFile(file)
        : await parseSpreadsheet(file);
      const parsed = parseElectionDaySheet(sheet);
      const { count } = await api.importElectionDayVoters(parsed.imported);
      return { ...parsed, count };
    },
    {
      successMessage: (result) =>
        ELECTION_DAY_TEXT.import.toast.loaded(
          result.count,
          result.totalRows,
          result.rejected.length,
        ),
    },
  );

  const importFileRaw = useCallback(
    async (file: File) => {
      const result = await runImport(file);
      if (result) {
        setLastImportSummary(result);
        reloadContacts();
        reloadEvents();
      }
      return result;
    },
    [runImport, reloadContacts, reloadEvents],
  );
  const importFile = guardedAction("electionDay.import", importFileRaw, "importFile");

  // Wrapped to resolve to an explicit `true` sentinel on success (instead of
  // the underlying `void`) - `clearElectionDayDataRaw` below needs a way to
  // tell "succeeded" apart from "blocked/failed" (both otherwise `undefined`)
  // so its `ConfirmDialog` caller never closes as if a blocked/failed clear
  // had gone through.
  const { run: runClearAll, busy: clearing } = useAsyncAction(
    async () => {
      await api.clearElectionDayVoters();
      return true;
    },
    { successMessage: ELECTION_DAY_TEXT.clearAll.toast.cleared },
  );

  const clearElectionDayDataRaw = useCallback(async () => {
    const result = await runClearAll();
    if (result === undefined) return undefined;
    setLastImportSummary(null);
    reloadContacts();
    reloadEvents();
    return true;
  }, [runClearAll, reloadContacts, reloadEvents]);
  const clearElectionDayData = guardedAction(
    "electionDay.clearData",
    clearElectionDayDataRaw,
    "clearElectionDayData",
  );

  const downloadRejectedRows = useCallback(() => {
    if (lastImportSummary && lastImportSummary.rejected.length > 0) {
      exportRejectedElectionDayRowsToExcel(lastImportSummary.rejected);
    }
  }, [lastImportSummary]);

  const dismissImportSummary = useCallback(() => setLastImportSummary(null), []);

  const exportReport = useCallback(() => {
    if (!can("electionDay.export")) {
      reportPermissionDenied({
        role,
        permission: "electionDay.export",
        context: "exportReport",
      });
      toast.error(ELECTION_DAY_TEXT.permissionDenied);
      return;
    }
    if (!contacts || contacts.length === 0) {
      toast.info(ELECTION_DAY_TEXT.exportReport.toast.empty);
      return;
    }
    exportElectionDayVotersToExcel(contacts);
  }, [can, role, contacts]);

  /** Opens WhatsApp with an aggregate-turnout summary (no per-voter data) -
   * moved in from `ElectionDayPage.tsx` so it goes through the same
   * `electionDay.export` guard as `exportReport` instead of a separate,
   * locally-duplicated check. */
  const sendSnapshotReport = useCallback(() => {
    if (!can("electionDay.export")) {
      reportPermissionDenied({
        role,
        permission: "electionDay.export",
        context: "sendSnapshotReport",
      });
      toast.error(ELECTION_DAY_TEXT.permissionDenied);
      return;
    }
    const time = new Date().toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const message = ELECTION_DAY_TEXT.snapshotReport.message({
      time,
      total: stats.total,
      voted: stats.voted,
      votedPct: stats.votedPct,
      coordinators: coordinatorBreakdown.map((c) => ({
        name: c.coordinator,
        total: c.total,
        voted: c.voted,
      })),
    });
    window.open(whatsAppShareHref(message), "_blank", "noreferrer");
  }, [can, role, stats, coordinatorBreakdown]);

  const { run: runSetDeadline } = useAsyncAction(
    (iso: string | null) => api.setElectionDayDeadline(iso),
    { successMessage: ELECTION_DAY_TEXT.countdown.toast.saved },
  );

  const setElectionDayDeadlineRaw = useCallback(
    async (iso: string | null) => {
      const result = await runSetDeadline(iso);
      if (result !== undefined) setDeadline(result);
      return result;
    },
    [runSetDeadline, setDeadline],
  );
  const setElectionDayDeadline = guardedAction(
    "electionDay.manageSettings",
    setElectionDayDeadlineRaw,
    "setElectionDayDeadline",
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

  // Raw (unguarded) primitive - called directly both by the public
  // `setRideArranged` below and by the ride-coordination composites
  // (`toggleRideRequested`/`sendRideRequestToDriver`/`cancelRideCoordination`),
  // which each carry their own single `voter.manageRide` guard at their own
  // top instead of relying on this one's.
  const applyRideArrangedRaw = useCallback(
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
  const setRideArranged = guardedAction(
    "voter.manageRide",
    applyRideArrangedRaw,
    "setRideArranged",
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

  const setReminderRaw = useCallback(
    async (id: string, minutes: number | null) => {
      const updated = await runSetReminder(id, minutes);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetReminder, applyContactUpdate],
  );
  // Also covers "cancel reminder" - callers pass `minutes: null` for that,
  // same guarded function, same `voter.manageReminder` permission.
  const setReminder = guardedAction(
    "voter.manageReminder",
    setReminderRaw,
    "setReminder",
  );

  // The "קביעת שעה" custom-time counterpart to `setReminder` - `at` is a
  // full ISO timestamp (never a minutes-offset), written to `reminderAt`
  // as-is. Same permission/guard/state-update shape as `setReminder`.
  const { run: runSetReminderAt } = useAsyncAction(
    (id: string, at: string) => api.setReminderAt(id, at),
    {
      successMessage: (_contact, _id, at: string) =>
        ELECTION_DAY_TEXT.reminder.toast.setAt(formatReminderDisplay(at)),
    },
  );

  const setReminderAtRaw = useCallback(
    async (id: string, at: string) => {
      const updated = await runSetReminderAt(id, at);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetReminderAt, applyContactUpdate],
  );
  const setReminderAt = guardedAction(
    "voter.manageReminder",
    setReminderAtRaw,
    "setReminderAt",
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

  const setVotedRaw = useCallback(
    async (id: string, voted: boolean) => {
      const updated = await runSetVoted(id, voted);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetVoted, applyContactUpdate],
  );
  const setVoted = guardedAction("voter.markVoted", setVotedRaw, "setVoted");

  // Rides on the same `voter.markVoted` permission as `setVoted` itself (no
  // separate permission by product decision - see PERMISSION type's comment)
  // - the reason is edited from the same control (the mark-voted area of
  // `ElectionDayContactModal`) that already requires this permission.
  const { run: runSetNonVotingReason } = useAsyncAction(
    (id: string, reasonId: string | null) =>
      api.setNonVotingReason(id, reasonId, sessionUser?.name ?? null),
    { successMessage: ELECTION_DAY_TEXT.voted.toast.reasonSet },
  );
  const setNonVotingReasonRaw = useCallback(
    async (id: string, reasonId: string | null) => {
      const updated = await runSetNonVotingReason(id, reasonId);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetNonVotingReason, applyContactUpdate],
  );
  const setNonVotingReason = guardedAction(
    "voter.markVoted",
    setNonVotingReasonRaw,
    "setNonVotingReason",
  );

  const { run: runSetRideCompleted } = useAsyncAction(
    (id: string, completed: boolean) => api.setRideCompleted(id, completed),
    {
      successMessage: (contact) =>
        contact.rideCompleted
          ? ELECTION_DAY_TEXT.dashboard.rideCoordination.toast.done
          : ELECTION_DAY_TEXT.dashboard.rideCoordination.toast.undone,
    },
  );

  const setRideCompletedRaw = useCallback(
    async (id: string, completed: boolean) => {
      const updated = await runSetRideCompleted(id, completed);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetRideCompleted, applyContactUpdate],
  );
  const setRideCompleted = guardedAction(
    "voter.manageRide",
    setRideCompletedRaw,
    "setRideCompleted",
  );

  const { run: runSetRideRequested } = useAsyncAction((id: string, requested: boolean) =>
    api.setRideRequested(id, requested),
  );

  const { run: runSetNotes } = useAsyncAction((id: string, notes: string) =>
    api.setElectionDayNotes(id, notes),
  );

  // Raw primitive - see `applyRideArrangedRaw`'s comment above; used both by
  // the public `setNotes` and by the ride-coordination composites, which
  // guard themselves once at their own top rather than through this.
  const applyNotesRaw = useCallback(
    async (id: string, notes: string) => {
      const updated = await runSetNotes(id, notes);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetNotes, applyContactUpdate],
  );
  const setNotes = guardedAction("voter.editNotes", applyNotesRaw, "setNotes");

  const { run: runSetPhone, busy: settingPhone } = useAsyncAction(
    (id: string, phone: string) => api.setPhone(id, phone),
    { successMessage: ELECTION_DAY_TEXT.phoneEditor.toast.saved },
  );

  const setPhoneRaw = useCallback(
    async (id: string, phone: string) => {
      const updated = await runSetPhone(id, phone);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetPhone, applyContactUpdate],
  );
  const setPhone = guardedAction("voter.editPhone", setPhoneRaw, "setPhone");

  // Call Attempts Counter: every click of the call button is itself a "dial
  // attempt" - no confirmation toast (would fire on every single click, too
  // noisy), just a silent counter bump. Gated on the same `voter.viewPhone`
  // permission as the call button itself (rather than a dedicated
  // permission) - whoever can see/dial the phone number is exactly who can
  // record an attempt against it.
  const { run: runIncrementCallAttempts } = useAsyncAction((id: string) =>
    api.incrementCallAttempts(id),
  );
  const incrementCallAttemptsRaw = useCallback(
    async (id: string) => {
      const updated = await runIncrementCallAttempts(id);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runIncrementCallAttempts, applyContactUpdate],
  );
  const incrementCallAttempts = guardedAction(
    "voter.viewPhone",
    incrementCallAttemptsRaw,
    "incrementCallAttempts",
  );

  // "המשך ניסיונות (+3)" - advances the threshold (3 -> 6 -> 9…) from the
  // auto-opened `CallAttemptsDialog`. Same permission gate as above - anyone
  // who could trigger the dialog by dialing can always choose this option.
  const { run: runExtendCallAttemptsThreshold } = useAsyncAction((id: string) =>
    api.extendCallAttemptsThreshold(id),
  );
  const extendCallAttemptsThresholdRaw = useCallback(
    async (id: string) => {
      const updated = await runExtendCallAttemptsThreshold(id);
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runExtendCallAttemptsThreshold, applyContactUpdate],
  );
  const extendCallAttemptsThreshold = guardedAction(
    "voter.viewPhone",
    extendCallAttemptsThresholdRaw,
    "extendCallAttemptsThreshold",
  );

  /** Marking "יש דרישה להסעה" is a lighter-weight signal than actually
   * coordinating with a driver - just a note that this voter needs a ride.
   * Reversible (click again to clear), tagging/untagging the notes field
   * to match without disturbing anything else typed there. */
  const toggleRideRequestedRaw = useCallback(
    async (contact: ElectionDayVoter) => {
      const nextRequested = !contact.rideRequested;
      const updated = await runSetRideRequested(contact.id, nextRequested);
      if (!updated) return;
      applyContactUpdate(updated);
      const nextNotes = nextRequested
        ? addNoteTag(updated.notes, ELECTION_DAY_TEXT.noteTags.rideRequested)
        : removeNoteTag(updated.notes, ELECTION_DAY_TEXT.noteTags.rideRequested);
      await applyNotesRaw(contact.id, nextNotes);
    },
    [runSetRideRequested, applyContactUpdate, applyNotesRaw],
  );
  const toggleRideRequested = guardedAction(
    "voter.manageRide",
    toggleRideRequestedRaw,
    "toggleRideRequested",
  );

  const { run: runAddRideCoordinator } = useAsyncAction(
    (input: NewRideCoordinator) => api.addRideCoordinator(input),
    { successMessage: ELECTION_DAY_TEXT.coordinatorsManager.toast.added },
  );

  const addRideCoordinatorRaw = useCallback(
    async (input: NewRideCoordinator) => {
      const result = await runAddRideCoordinator(input);
      if (result) reloadRideCoordinators();
      return result;
    },
    [runAddRideCoordinator, reloadRideCoordinators],
  );
  const addRideCoordinator = guardedAction(
    "electionDay.manageRideCoordinators",
    addRideCoordinatorRaw,
    "addRideCoordinator",
  );

  const { run: runDeleteRideCoordinator } = useAsyncAction(
    (id: string) => api.deleteRideCoordinator(id),
    { successMessage: ELECTION_DAY_TEXT.coordinatorsManager.toast.deleted },
  );

  const deleteRideCoordinatorRaw = useCallback(
    async (id: string) => {
      await runDeleteRideCoordinator(id);
      reloadRideCoordinators();
    },
    [runDeleteRideCoordinator, reloadRideCoordinators],
  );
  const deleteRideCoordinator = guardedAction(
    "electionDay.manageRideCoordinators",
    deleteRideCoordinatorRaw,
    "deleteRideCoordinator",
  );

  const { run: runAddPermissionUser } = useAsyncAction(
    (input: NewPermissionUser) => api.createPermissionUser(input),
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.added },
  );

  const addPermissionUserRaw = useCallback(
    async (input: NewPermissionUser) => {
      const result = await runAddPermissionUser(input);
      if (result) reloadPermissionUsers();
      return result;
    },
    [runAddPermissionUser, reloadPermissionUsers],
  );
  // `permissionUsers` here is the raw fetched value (not the `?? []` default
  // used in the returned object below) so "still loading" is never confused
  // with "genuinely empty" - same distinction `ElectionDayGuard` makes.
  const rosterStillEmpty = permissionUsers !== null && permissionUsers.length === 0;
  // The one deliberate exception in the whole permission model: creating the
  // very first `PermissionUser` is allowed with no session at all, but only
  // while `isBootstrap` (no session *and* the roster was empty when the page
  // loaded - see `ElectionDayGuard`) *and* the roster is still empty right
  // now. That second, live check is what makes the exception self-cancel
  // after the first account is created - `isBootstrap` alone wouldn't, since
  // it doesn't change again until the next full page load. This is not a
  // role-based grant - every other permission still resolves through `can`
  // exactly as it does everywhere else, and `deletePermissionUser` below
  // deliberately has no such exception.
  const addPermissionUser = useCallback(
    async (input: NewPermissionUser) => {
      const allowed = can("electionDay.manageUsers") || (isBootstrap && rosterStillEmpty);
      if (!allowed) {
        reportPermissionDenied({
          role,
          permission: "electionDay.manageUsers",
          context: "addPermissionUser",
        });
        toast.error(ELECTION_DAY_TEXT.permissionDenied);
        return undefined;
      }
      return addPermissionUserRaw(input);
    },
    [can, role, isBootstrap, rosterStillEmpty, addPermissionUserRaw],
  );

  const { run: runDeletePermissionUser } = useAsyncAction(
    (id: string) => api.deletePermissionUser(id),
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.deleted },
  );

  const deletePermissionUserRaw = useCallback(
    async (id: string) => {
      await runDeletePermissionUser(id);
      reloadPermissionUsers();
    },
    [runDeletePermissionUser, reloadPermissionUsers],
  );
  const deletePermissionUser = guardedAction(
    "electionDay.manageUsers",
    deletePermissionUserRaw,
    "deletePermissionUser",
  );

  // No `successMessage` - the dialog itself shows the success toast (needs
  // the target user's name, which this hook layer doesn't carry), same
  // division of responsibility documented in `ResetPasswordDialog.tsx`.
  // `actorId` is this session's own id, never client-typed - the acting
  // manager only re-enters their own PASSWORD (`actorPassword`, collected by
  // the dialog); the RPC itself re-authenticates that password server-side
  // and derives `reset_by` from the verified actor row, not from any text
  // this layer sends. The `!sessionUser` branch is unreachable in practice
  // (guardedAction's `can("electionDay.manageUsers")` check below already
  // requires a resolved session - see usePermissions.ts's
  // `sessionUser?.roleId ?? null`) - kept only so this closure never needs a
  // non-null assertion on `sessionUser`.
  const { run: runResetPermissionUserPassword } = useAsyncAction(
    (targetId: string, newPassword: string, actorPassword: string) => {
      if (!sessionUser) {
        return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
      }
      return api.resetPermissionUserPassword(
        sessionUser.id,
        actorPassword,
        targetId,
        newPassword,
      );
    },
  );
  // No bootstrap exception here (unlike `addPermissionUser` above) - resetting
  // a password is never needed to stand up the very first account, so this is
  // a plain `can(...)` check like every other mutation.
  const resetPermissionUserPasswordRaw = useCallback(
    async (targetId: string, newPassword: string, actorPassword: string) => {
      const result = await runResetPermissionUserPassword(
        targetId,
        newPassword,
        actorPassword,
      );
      if (result) reloadPermissionUsers();
      return result;
    },
    [runResetPermissionUserPassword, reloadPermissionUsers],
  );
  const resetPermissionUserPassword = guardedAction(
    "electionDay.manageUsers",
    resetPermissionUserPasswordRaw,
    "resetPermissionUserPassword",
  );

  /** Opens WhatsApp with the voter's pickup details pre-filled but no target
   * contact - the activist picks the driver by name inside WhatsApp itself
   * and sends it manually. Then marks the ride as arranged and tags the
   * notes field (additive, not overwriting whatever was already typed). */
  const sendRideRequestToDriverRaw = useCallback(
    async (contact: ElectionDayVoter) => {
      const address = [contact.street, contact.houseNumber || "", contact.city]
        .filter(Boolean)
        .join(" ");
      const message = ELECTION_DAY_TEXT.driver.message({
        name: `${contact.firstName} ${contact.lastName}`,
        address,
        phone: contact.phone,
      });
      window.open(whatsAppShareHref(message), "_blank", "noreferrer");
      const updated = await applyRideArrangedRaw(contact.id, true);
      if (updated) {
        await applyNotesRaw(
          contact.id,
          addNoteTag(updated.notes, ELECTION_DAY_TEXT.noteTags.rideArranged),
        );
      }
      toast.success(ELECTION_DAY_TEXT.driver.toast.sent);
    },
    [applyRideArrangedRaw, applyNotesRaw],
  );
  const sendRideRequestToDriver = guardedAction(
    "voter.manageRide",
    sendRideRequestToDriverRaw,
    "sendRideRequestToDriver",
  );

  /** Reverses a ride coordination (the "בטל תיאום" button) - always clears
   * both the arranged and requested flags (dropping the contact out of the
   * ride-coordination table entirely) and wipes the notes field completely
   * (not just the ride-related tags). Only opens WhatsApp with a
   * cancellation message when the notes actually carried the "תואם" tag -
   * i.e. a driver had really been contacted, not just a bare ride request. */
  const cancelRideCoordinationRaw = useCallback(
    async (contact: ElectionDayVoter) => {
      const wasArranged = hasNoteTag(
        contact.notes,
        ELECTION_DAY_TEXT.noteTags.rideArranged,
      );

      if (wasArranged) {
        const address = [contact.street, contact.houseNumber || "", contact.city]
          .filter(Boolean)
          .join(" ");
        const message = ELECTION_DAY_TEXT.driver.cancelMessage({
          name: `${contact.firstName} ${contact.lastName}`,
          address,
          phone: contact.phone,
        });
        window.open(whatsAppShareHref(message), "_blank", "noreferrer");
      }

      await applyRideArrangedRaw(contact.id, false);
      const updated = await runSetRideRequested(contact.id, false);
      if (updated) applyContactUpdate(updated);
      await applyNotesRaw(contact.id, "");
    },
    [applyRideArrangedRaw, runSetRideRequested, applyContactUpdate, applyNotesRaw],
  );
  const cancelRideCoordination = guardedAction(
    "voter.manageRide",
    cancelRideCoordinationRaw,
    "cancelRideCoordination",
  );

  // Polls for due reminders and fires a toast for each (clearing it so it
  // doesn't repeat) - only while this tab is open, no browser-notification
  // permission involved. Reads the latest contacts via a ref so the interval
  // itself never needs to be torn down/recreated when the list changes.
  const contactsRef = useRef(scopedContacts);
  useEffect(() => {
    contactsRef.current = scopedContacts;
  }, [scopedContacts]);

  useEffect(() => {
    const checkReminders = () => {
      // A role that can't see reminder status shouldn't have one silently
      // cleared, or a toast revealing a voter's name/coordinator, in the
      // background - not a guardedAction denial (nothing was attempted),
      // just a visibility gate on an automatic process.
      if (!can("voter.viewReminderStatus")) return;
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
  }, [applyContactUpdate, can]);

  return {
    contacts: pagedContacts,
    // The full, unpaged/unfiltered fetched list - used by
    // `NonVotingReasonsModal`'s usage-count (a reason must be blocked from
    // deletion if ANY voter references it, not just the current page/filter
    // view) - `pagedContacts` above is deliberately narrower for the list.
    allContacts: contacts ?? [],
    total: contacts?.length ?? 0,
    filteredTotal,
    loaded: contacts !== null,
    search,
    setSearch,
    stats,
    coordinatorBreakdown,
    rideCoordinationQueue,
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
    reasonFilter,
    setReasonFilter,
    nonVotingReasons: nonVotingReasons ?? [],
    reloadNonVotingReasons,
    nonVotingReasonReport,
    closedReasonBreakdown,
    showUnvotedOnly,
    setShowUnvotedOnly,
    followUpFilter,
    setFollowUpFilter,
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
    lastImportSummary,
    downloadRejectedRows,
    dismissImportSummary,
    clearElectionDayData,
    clearing,
    exportReport,
    sendSnapshotReport,
    deadline: deadline ?? null,
    setElectionDayDeadline,
    setRideArranged,
    setReminder,
    setReminderAt,
    setVoted,
    setNonVotingReason,
    setRideCompleted,
    setNotes,
    setPhone,
    settingPhone,
    incrementCallAttempts,
    extendCallAttemptsThreshold,
    toggleRideRequested,
    cancelRideCoordination,
    rideCoordinators: rideCoordinators ?? [],
    addRideCoordinator,
    deleteRideCoordinator,
    sendRideRequestToDriver,
    permissionUsers: permissionUsers ?? [],
    addPermissionUser,
    deletePermissionUser,
    resetPermissionUserPassword,
    roles,
  };
}

export type ElectionDayHook = ReturnType<typeof useElectionDay>;
