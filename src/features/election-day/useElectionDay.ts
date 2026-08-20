import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "../../components/ui/Toast";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { whatsAppShareHref } from "../../lib/phone";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api, ElectionDayReauthError } from "../../services/api";
import type { NewPermissionUser, NewRideCoordinator } from "../../services/api";
import {
  exportElectionDayVotersToExcel,
  parseSpreadsheet,
  parseJsonFile,
} from "../../services/excel/excel";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDaySession } from "./electionDaySession";
import { useElectionDayReauthProof } from "./electionDayReauthProof";
import { useElectionDayReauth } from "./useElectionDayReauth";
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
import {
  buildFollowUpBreakdown,
  buildClosedRemindersToday,
  buildCallAttemptsWatchlist,
} from "./followUpBreakdown";
import { buildRideStatusBreakdown } from "./rideStatusBreakdown";
import { buildAttentionAlerts } from "./attentionAlerts";
import { buildTurnoutPaceSeries } from "./turnoutPace";

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
  /** Coordinator worklist's "case closed" count, scoped to this coordinator
   * (same definition as `ElectionDayStats.closed` - see `followUpStatus.ts`). */
  closed: number;
  /** Coordinator worklist's "still needs follow-up" count, scoped to this
   * coordinator (same definition as `ElectionDayStats.remaining`). */
  remaining: number;
  votedPct: number;
}

export type ElectionDaySortKey = "city" | "status";
export type SortDir = "asc" | "desc";
export type RideStatusFilterValue = "arranged" | "notArranged";
export type VoteStatusFilterValue = "notVoted" | "voted";

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
 * Security Hardening (Reauth): this hook no longer takes an `isBootstrap`
 * parameter - `addPermissionUser` below carries no bootstrap exception of
 * any kind (one briefly existed, both here and server-side, and was
 * explicitly removed). `ElectionDayPermissionsPage` reads `isBootstrap`
 * directly from `ElectionDayShell`'s own outlet-context re-export instead,
 * purely to decide whether to render a static setup-required state - never
 * to widen what this hook's handlers are allowed to do. */
export function useElectionDay() {
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

  // Security Hardening (Reauth): the shared gate for the 4 admin/import
  // mutations this hook owns (addPermissionUser/deletePermissionUser/
  // resetPermissionUserPassword/importFile) - see useElectionDayReauth.ts's
  // own doc comment for the full flow. `reauthDialog` is rendered once, by
  // ElectionDayShell.tsx (which already renders this hook's other shared
  // dialog, ElectionDayContactModal).
  const reauth = useElectionDayReauth();

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
  const [voteStatusFilter, setVoteStatusFilterRaw] = useState<VoteStatusFilterValue[]>([
    "notVoted",
  ]);
  // Coordinator worklist filter. Defaults to "remaining" only, matching the
  // worklist's default "what still needs attention" view - unchanged from
  // before `voteStatusFilter` existed. Typed as `FollowUpStatus[]` (not a
  // loose `string[]`) - same pattern as `statusFilter`/`RideStatusFilterValue[]`
  // above.
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpStatus[]>(["remaining"]);
  // `voteStatusFilter`'s own setter, wrapped so selecting "voted" exclusively
  // (not "all", not the notVoted+voted interim state while toggling) also
  // clears `followUpFilter` - "remaining" never includes voted contacts
  // (`resolveFollowUpStatus`), so leaving it at its default would silently
  // zero out the very results the user just asked to see. One-directional by
  // design: going back to "notVoted" does NOT restore "remaining" - once
  // cleared, it stays cleared until the user picks it again themselves, so
  // there's no surprising state jumping back on its own.
  const setVoteStatusFilter = useCallback((values: VoteStatusFilterValue[]) => {
    setVoteStatusFilterRaw(values);
    if (values.length === 1 && values[0] === "voted") setFollowUpFilter([]);
  }, []);
  const hasActiveFilters =
    debouncedSearch.trim() !== "" ||
    coordinatorFilter.length > 0 ||
    cityFilter.length > 0 ||
    statusFilter.length > 0 ||
    reasonFilter.length > 0;

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
    if (voteStatusFilter.length)
      base = base.filter((c) =>
        voteStatusFilter.includes(c.voted ? "voted" : "notVoted"),
      );
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
    voteStatusFilter,
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
      VoteStatusFilterValue[],
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
    voteStatusFilter,
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
    trackedQuery[5] !== voteStatusFilter ||
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
      voteStatusFilter,
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
        closed: 0,
        remaining: 0,
        votedPct: 0,
      };
      entry.total++;
      if (c.rideArranged) entry.arranged++;
      const status = resolveFollowUpStatus(c, reasonsById);
      if (status === "voted") entry.voted++;
      else if (status === "closed") entry.closed++;
      else entry.remaining++;
      byCoordinator.set(c.coordinator, entry);
    }
    const rows = [...byCoordinator.values()];
    for (const row of rows) row.votedPct = row.total ? (row.voted / row.total) * 100 : 0;
    return rows.sort((a, b) => b.total - a.total);
  }, [scopedContacts, reasonsById]);

  // Dashboard rows 3/4 and the "מוקדי תשומת לב" alerts panel - all pure
  // derivations reading through `resolveFollowUpStatus`/`scopedContacts`, so
  // none of them can drift from `stats`/`closedReasonBreakdown` above.
  const followUpBreakdown = useMemo(
    () => buildFollowUpBreakdown(scopedContacts ?? [], reasonsById),
    [scopedContacts, reasonsById],
  );

  // Dashboard's "closed reminders today" tile - reads current-state fields
  // only (no events-table join), same "hot path stays fast" reasoning as
  // `closedReasonBreakdown` above. See `followUpBreakdown.ts` for the exact
  // local-calendar-day definition of "today".
  const closedRemindersToday = useMemo(
    () => buildClosedRemindersToday(scopedContacts ?? []),
    [scopedContacts],
  );

  // Dashboard "בוחרים עם 2+ ניסיונות חיוג" card - same filter as
  // `followUpBreakdown.callAttempts2Plus` above, returned as rows.
  const callAttemptsWatchlist = useMemo(
    () => buildCallAttemptsWatchlist(scopedContacts ?? [], reasonsById),
    [scopedContacts, reasonsById],
  );

  const rideStatusBreakdown = useMemo(
    () => buildRideStatusBreakdown(scopedContacts ?? []),
    [scopedContacts],
  );

  const attentionAlerts = useMemo(
    () =>
      buildAttentionAlerts(followUpBreakdown, rideStatusBreakdown, coordinatorBreakdown),
    [followUpBreakdown, rideStatusBreakdown, coordinatorBreakdown],
  );

  const turnoutPace = useMemo(
    () => buildTurnoutPaceSeries(scopedContacts ?? []),
    [scopedContacts],
  );

  // "עודכן לאחרונה" + manual refresh for the dashboard header - set from an
  // effect (never `Date.now()` during render, per the project's React
  // Compiler purity rule) whenever a fetch that feeds the dashboard resolves.
  // Deferred to a microtask (like `useCountdown`'s `now`) rather than called
  // synchronously in the effect body, per the set-state-in-effect rule.
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (contacts !== null) {
      Promise.resolve().then(() => setLastUpdatedAt(Date.now()));
    }
  }, [contacts]);

  const refresh = useCallback(() => {
    reloadContacts();
    reloadEvents();
  }, [reloadContacts, reloadEvents]);

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

  // Security Hardening (Reauth): the actual `importElectionDayVoters` call
  // reads the currently-cached proof directly from the store (rather than
  // having it threaded in as an argument) - by the time this action runs,
  // `reauth.gate` (see `importFileRaw` below) has already guaranteed a
  // valid proof is cached, either because one already was, or because the
  // gate's own dialog just obtained and cached a fresh one. On the RPC's own
  // `UNAUTHORIZED` (the proof was rejected server-side - expired/revoked
  // mid-flow), the stale proof is cleared here before the error propagates
  // to this `useAsyncAction`'s normal toast handling - see
  // `useElectionDayReauth.ts`'s doc comment for why this deliberately does
  // NOT auto-retry the import itself.
  const { run: runImport, busy: importing } = useAsyncAction(
    async (file: File) => {
      const sheet = file.name.toLowerCase().endsWith(".json")
        ? await parseJsonFile(file)
        : await parseSpreadsheet(file);
      const parsed = parseElectionDaySheet(sheet);
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        const { count } = await api.importElectionDayVoters(proof, parsed.imported);
        return { ...parsed, count };
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
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
      const result = await reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.importVoters,
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => runImport(file),
      );
      if (result) {
        setLastImportSummary(result);
        reloadContacts();
        reloadEvents();
      }
      return result;
    },
    [reauth, runImport, reloadContacts, reloadEvents],
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
    (id: string, minutes: number, actorName: string) =>
      api.setReminder(id, minutes, actorName),
    {
      successMessage: (_contact, _id, minutes) =>
        ELECTION_DAY_TEXT.reminder.toast.set(
          ELECTION_DAY_TEXT.reminder.options[
            minutes as keyof typeof ELECTION_DAY_TEXT.reminder.options
          ],
        ),
    },
  );

  const setReminderRaw = useCallback(
    async (id: string, minutes: number) => {
      const updated = await runSetReminder(id, minutes, sessionUser?.name ?? "");
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetReminder, applyContactUpdate, sessionUser],
  );
  const setReminder = guardedAction(
    "voter.manageReminder",
    setReminderRaw,
    "setReminder",
  );

  // The "קביעת שעה" custom-time counterpart to `setReminder` - `at` is a
  // full ISO timestamp (never a minutes-offset), written to `reminderAt`
  // as-is. Same permission/guard/state-update shape as `setReminder`.
  const { run: runSetReminderAt } = useAsyncAction(
    (id: string, at: string, actorName: string) => api.setReminderAt(id, at, actorName),
    {
      successMessage: (_contact, _id, at: string) =>
        ELECTION_DAY_TEXT.reminder.toast.setAt(formatReminderDisplay(at)),
    },
  );

  const setReminderAtRaw = useCallback(
    async (id: string, at: string) => {
      const updated = await runSetReminderAt(id, at, sessionUser?.name ?? "");
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetReminderAt, applyContactUpdate, sessionUser],
  );
  const setReminderAt = guardedAction(
    "voter.manageReminder",
    setReminderAtRaw,
    "setReminderAt",
  );

  // Cancel: the reminder is dropped without being counted as "handled" - a
  // real persisted event (`reminderClosedReason: "cancelled"`), distinct
  // from `closeReminder` below. Replaces the old "reuse setReminder(id,
  // null)" pattern, which silently discarded the reminder with no audit
  // trail and no way to tell "cancelled" apart from "never set".
  const { run: runCancelReminder } = useAsyncAction(
    (id: string, actorName: string) => api.cancelReminder(id, actorName),
    { successMessage: ELECTION_DAY_TEXT.reminder.toast.cancelled },
  );
  const cancelReminderRaw = useCallback(
    async (id: string) => {
      const updated = await runCancelReminder(id, sessionUser?.name ?? "");
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runCancelReminder, applyContactUpdate, sessionUser],
  );
  const cancelReminder = guardedAction(
    "voter.manageReminder",
    cancelReminderRaw,
    "cancelReminder",
  );

  // Close: marks a reminder as handled (`reminderClosedReason: "handled"`,
  // set by the RPC) - the "✓ סמן כטופל" action on a DUE reminder.
  const { run: runCloseReminder } = useAsyncAction(
    (id: string, actorName: string) => api.closeReminder(id, actorName),
    { successMessage: ELECTION_DAY_TEXT.reminder.toast.closed },
  );
  const closeReminderRaw = useCallback(
    async (id: string) => {
      const updated = await runCloseReminder(id, sessionUser?.name ?? "");
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runCloseReminder, applyContactUpdate, sessionUser],
  );
  const closeReminder = guardedAction(
    "voter.manageReminder",
    closeReminderRaw,
    "closeReminder",
  );

  const { run: runSetVoted } = useAsyncAction(
    (id: string, voted: boolean, actorName: string) => api.setVoted(id, voted, actorName),
    {
      successMessage: (contact) =>
        contact.voted
          ? ELECTION_DAY_TEXT.voted.toast.voted
          : ELECTION_DAY_TEXT.voted.toast.notVoted,
    },
  );

  const setVotedRaw = useCallback(
    async (id: string, voted: boolean) => {
      const updated = await runSetVoted(id, voted, sessionUser?.name ?? "");
      if (updated) applyContactUpdate(updated);
      return updated;
    },
    [runSetVoted, applyContactUpdate, sessionUser],
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
  const { run: runIncrementCallAttempts, busy: incrementingCallAttempts } =
    useAsyncAction((id: string) => api.incrementCallAttempts(id));
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

  // Security Hardening (Reauth): reads the currently-cached proof directly
  // from the store rather than taking it as an argument - same reasoning as
  // `runImport`/`runDeletePermissionUser`. No bootstrap fallback of any
  // kind - `election_day_create_permission_user_v2` has no empty-roster
  // exception (removed, see the Security Phase 1 audit), so `addPermissionUser`
  // below always goes through `reauth.gate` first and this always runs with
  // a real, freshly-verified proof. The very first account (fresh install /
  // local test bootstrap) is created out-of-band, never through this path -
  // see `ElectionDayPermissionsPage`'s setup-required state.
  const { run: runAddPermissionUser } = useAsyncAction(
    async (input: NewPermissionUser) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.createPermissionUser(proof, input);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
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
  // Security Hardening (Reauth): plain `guardedAction`, no bootstrap
  // widening of any kind - identical shape to `deletePermissionUser` below.
  // A denied session never sees a mutation attempted, let alone a call with
  // an empty/synthetic proof.
  const addPermissionUser = guardedAction(
    "electionDay.manageUsers",
    (input: NewPermissionUser) =>
      reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.addPermissionUser(input.name),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => addPermissionUserRaw(input),
      ),
    "addPermissionUser",
  );

  // Wrapped to resolve to an explicit `true` sentinel on success (the
  // underlying `api.deletePermissionUser` resolves void, otherwise
  // indistinguishable from a blocked/failed call) - same pattern as
  // `useRoleManagement.ts`'s `deleteRole`. Security Hardening (Reauth): reads
  // the cached proof from the store, same pattern as `runAddPermissionUser`
  // above - `deletePermissionUser` below carries no bootstrap exception, so
  // a session (and therefore an eventual valid proof) always exists by the
  // time this runs.
  const { run: runDeletePermissionUser, busy: deletingPermissionUser } = useAsyncAction(
    async (id: string) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        await api.deletePermissionUser(proof, id);
        return true;
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.deleted },
  );

  const deletePermissionUserRaw = useCallback(
    async (id: string) => {
      // Self-delete protection, second layer: even if this handler is ever
      // invoked outside the normal (already-disabled-for-self) row button,
      // never call the delete RPC against the signed-in session's own id.
      // Client-side only - the RPC itself takes no caller identity, see
      // task-plan.md's "Known Security Limitations".
      if (sessionUser && id === sessionUser.id) {
        toast.error(ELECTION_DAY_TEXT.permissionsManager.selfDelete.blockedError);
        return undefined;
      }
      const result = await runDeletePermissionUser(id);
      if (result === undefined) return undefined;
      reloadPermissionUsers();
      return true;
    },
    [runDeletePermissionUser, reloadPermissionUsers, sessionUser],
  );
  const deletePermissionUser = guardedAction(
    "electionDay.manageUsers",
    (id: string) => {
      const targetName = (permissionUsers ?? []).find((u) => u.id === id)?.name ?? "";
      return reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.deletePermissionUser(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => deletePermissionUserRaw(id),
      );
    },
    "deletePermissionUser",
  );

  // No `successMessage` - the dialog itself shows the success toast (needs
  // the target user's name, which this hook layer doesn't carry), same
  // division of responsibility documented in `ResetPasswordDialog.tsx`.
  // Security Hardening (Reauth): the acting manager's own password is no
  // longer collected by this dialog/handler at all - it's supplied once,
  // up front, by the shared `reauth.gate` flow (see `resetPermissionUserPassword`
  // below), and the RPC re-authenticates that password server-side via the
  // resulting proof, deriving `reset_by` from the verified actor - not from
  // any text this layer sends. The `!sessionUser` branch is unreachable in
  // practice (guardedAction's `can("electionDay.manageUsers")` check below
  // already requires a resolved session - see usePermissions.ts's
  // `sessionUser?.roleId ?? null`) - kept only so this closure never needs a
  // non-null assertion on `sessionUser`.
  const { run: runResetPermissionUserPassword } = useAsyncAction(
    async (targetId: string, newPassword: string) => {
      if (!sessionUser) {
        return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
      }
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.resetPermissionUserPassword(proof, targetId, newPassword);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
  );
  // No bootstrap exception here (unlike `addPermissionUser` above) - resetting
  // a password is never needed to stand up the very first account, so this is
  // a plain `can(...)` check like every other mutation.
  const resetPermissionUserPasswordRaw = useCallback(
    async (targetId: string, newPassword: string) => {
      const result = await runResetPermissionUserPassword(targetId, newPassword);
      if (result) reloadPermissionUsers();
      return result;
    },
    [runResetPermissionUserPassword, reloadPermissionUsers],
  );
  const resetPermissionUserPassword = guardedAction(
    "electionDay.manageUsers",
    (targetId: string, newPassword: string) => {
      const targetName =
        (permissionUsers ?? []).find((u) => u.id === targetId)?.name ?? "";
      return reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary:
            ELECTION_DAY_TEXT.reauth.dialogs.resetPermissionUserPassword(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => resetPermissionUserPasswordRaw(targetId, newPassword),
      );
    },
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

  // Persistent Reminders: the old "poll for freshly-DUE reminders and fire
  // a one-time, 4s-auto-dismissing toast" effect that used to live here has
  // been replaced by `OverdueReminderStack` (rendered in `ElectionDayShell`),
  // which derives its list straight from `scopedContacts` via
  // `resolveOverdueReminderPopups` on every render/tick - no separate
  // in-memory "already notified" tracking, and nothing that can silently
  // disappear on a timer or a reload.

  return {
    contacts: pagedContacts,
    // The full, unpaged/unfiltered fetched list - used by
    // `NonVotingReasonsModal`'s usage-count (a reason must be blocked from
    // deletion if ANY voter references it, not just the current page/filter
    // view) - `pagedContacts` above is deliberately narrower for the list.
    allContacts: contacts ?? [],
    // Session-scoped (role/coordinator-filtered) contacts, unpaged/
    // unfiltered by the Voters screen's own search/filters - used by
    // `OverdueReminderStack` so its due-reminder derivation respects the
    // exact same visibility rule as everything else (never the raw
    // unscoped `contacts`).
    scopedContacts: scopedContacts ?? [],
    total: contacts?.length ?? 0,
    filteredTotal,
    loaded: contacts !== null,
    search,
    setSearch,
    stats,
    coordinatorBreakdown,
    followUpBreakdown,
    rideStatusBreakdown,
    attentionAlerts,
    turnoutPace,
    lastUpdatedAt,
    refresh,
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
    closedRemindersToday,
    callAttemptsWatchlist,
    voteStatusFilter,
    setVoteStatusFilter,
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
    cancelReminder,
    closeReminder,
    listReminderEvents: (contactId: string) => api.listReminderEvents(contactId),
    setVoted,
    setNonVotingReason,
    setRideCompleted,
    setNotes,
    setPhone,
    settingPhone,
    incrementCallAttempts,
    incrementingCallAttempts,
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
    deletingPermissionUser,
    resetPermissionUserPassword,
    roles,
    // Security Hardening (Reauth): the shared password-reauth dialog for
    // this hook's 4 gated mutations - `null` while no reauth is pending.
    // Rendered once by `ElectionDayShell.tsx`.
    reauthDialog: reauth.reauthDialog,
  };
}

export type ElectionDayHook = ReturnType<typeof useElectionDay>;
