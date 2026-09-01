import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { toast } from "../../components/ui/Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api, ElectionDayReauthError } from "../../services/api";
import type {
  AllocationAssignment,
  CoordinatorAction,
  EndCoordinatorActivityMode,
} from "../../services/api";
import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { useCoordinatorAllocationReauthProof } from "./coordinatorAllocationReauthProof";
import {
  buildCoordinatorAllocationStats,
  countUnassignedVoters,
} from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  applyInitialAllocationTrusted,
  endCoordinatorActivityTrusted,
  fetchCoordinatorsTrusted,
  manageCoordinatorsTrusted,
  rebalanceAssignmentsTrusted,
} from "./electionDayTrustedCoordinatorAllocationClient";
import { useCoordinatorAllocationReauth } from "./useCoordinatorAllocationReauth";

/** Caller-supplied copy for the shared re-auth dialog (see
 * `useCoordinatorAllocationReauth.ts`) - each allocation mutation's own
 * confirmation summary (already computed by the calling component from its
 * own local state, e.g. "add coordinator X") doubles as the reauth dialog's
 * copy when no valid proof is cached yet; mirrors `useElectionDay.ts`'s
 * inline `reauth.gate({title, summary, confirmLabel}, ...)` calls, just
 * threaded in from the caller instead of being hardcoded per-action inside
 * this hook, since a single generic `manageCoordinators`/etc. entry point is
 * shared by
 * several different UI flows (roster editor, initial-allocation setup,
 * rebalance, end-coordinator) each with their own specific summary text. */
export interface ReauthCopy {
  title: string;
  summary: ReactNode;
  confirmLabel: string;
}

/**
 * Coordinator Allocation Management (Phase 4 data layer): owns the
 * coordinator roster and the 4 proof-authenticated allocation mutations,
 * gated end-to-end on `electionDay.manageCoordinatorAllocation` - mirrors
 * `useRoleManagement.ts`'s `guardedAction` pattern exactly (checks
 * `can(permission)` before any API call, reports a denial, never a silent
 * no-op). A dedicated sibling hook to `useElectionDay`, not folded into it -
 * same shape of separation as `useRoleManagement`/`useNonVotingReasons` for
 * their own management surfaces.
 *
 * `contacts`/`reasonsById` must be the FULL, unscoped data
 * (`useElectionDay`'s `allContacts`, not `scopedContacts`/`pagedContacts` -
 * and its own `reasonsById`) - allocation stats are a manager-only,
 * whole-picture view, same reasoning as `NonVotingReasonsModal`'s
 * usage-count in `useElectionDay.ts`'s own comment.
 *
 * Coordinator/Allocation V3 Frontend Cutover: the roster read and all 4
 * mutations go through the trusted, session-derived v3 HTTP path
 * (`electionDayTrustedCoordinatorAllocationClient.ts`,
 * `api/election-day/coordinator-allocation.ts`) instead of the legacy
 * direct `_v2` RPC calls - the legacy `_v2` functions remain live,
 * untouched, and reachable only via `supabaseElectionDayApi.ts`'s own
 * unused methods now (rollback capability). Reauth is a SEPARATE,
 * feature-scoped gate (`useCoordinatorAllocationReauth`'s `gate()`, backed
 * by `coordinatorAllocationReauthProof.ts`'s dedicated 5-minute cache) -
 * never the legacy shared 15-minute `useElectionDayReauth`/
 * `electionDayReauthProof.ts` cache still serving the other `_v2`
 * reauth-gated actions. Each mutation is `guardedAction`-wrapped (unchanged
 * permission-check contract) around a `reauth.gate(copy, () => rawFn(...))`
 * call, where `copy` is supplied by the calling component (it already knows
 * the specific per-action confirmation summary). The first action after a
 * page load - or after the cached proof expires/is rejected - opens the
 * shared `AllocationPasswordDialog` (via this hook's own `reauthDialog`,
 * rendered once by `CoordinatorAllocationView.tsx`); every further action
 * within the proof's 5-minute TTL runs immediately with no dialog at all.
 */
export function useCoordinatorAllocation(
  contacts: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
) {
  const { can, role } = usePermissions();
  const reauth = useCoordinatorAllocationReauth();

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

  // Coordinator/Allocation V3 Frontend Cutover: the trusted GET (session-
  // derived, no reauth proof needed for a read). Multi-Tenant Phase 4B
  // Frontend Cutover: `CoordinatorReminderSupervisionCard.tsx` now uses this
  // same `fetchCoordinatorsTrusted()` too (previously kept on the legacy
  // `api.listCoordinators()` global plain SELECT as a separate consumer -
  // see that file's own comment for why the roster-empty bootstrap window
  // this was worried about turns out to be a no-op either way).
  const fetchCoordinators = useCallback(() => fetchCoordinatorsTrusted(), []);
  const { data: coordinators, reload: reloadCoordinators } =
    useAsyncData(fetchCoordinators);

  // Live cross-device sync (Supabase Realtime) - a coordinator change on
  // another device/tab (add/edit/remove/link/relink/unlink/end, or an
  // allocation/rebalance/end mutation's own roster refresh) refetches here
  // too. Feature-detected the same way (`?.`) since `MockApi` doesn't
  // implement it. Deliberately its OWN dedicated subscription method/channel
  // (`subscribeToCoordinatorChanges`, not `useElectionDay.ts`'s
  // `subscribeToElectionDayChanges`) - two independently mounted/unmounted
  // hooks must not share one channel object, or either one's cleanup could
  // tear down the other's subscription (see
  // `SupabaseElectionDayApi.subscribeToCoordinatorChanges`'s own comment for
  // the full mechanism this avoids). Realtime subscription itself is
  // unaffected by the v3 read cutover - it only triggers `reloadCoordinators`,
  // which now calls the trusted GET instead of the legacy plain SELECT.
  useEffect(() => {
    const unsubscribe = api.subscribeToCoordinatorChanges?.(() => {
      reloadCoordinators();
    });
    return unsubscribe;
  }, [reloadCoordinators]);

  const activeCoordinators = useMemo(
    () => (coordinators ?? []).filter((c) => c.status === "active"),
    [coordinators],
  );

  const coordinatorStats = useMemo(
    () => buildCoordinatorAllocationStats(coordinators ?? [], contacts, reasonsById),
    [coordinators, contacts, reasonsById],
  );

  const unassignedCount = useMemo(() => countUnassignedVoters(contacts), [contacts]);
  const assignedCount = contacts.length - unassignedCount;

  // Security Hardening (Reauth), Phase 2: each mutation below reads the
  // currently-cached proof directly from the store (rather than having it
  // threaded in as an argument) - by the time it runs, `reauth.gate` (see
  // each `*Raw` wrapper below) has already guaranteed a valid proof is
  // cached, either because one already was, or because the gate's own dialog
  // just obtained and cached a fresh one. On the RPC's own `UNAUTHORIZED`
  // (the proof was rejected server-side - expired/revoked mid-flow), the
  // stale proof is cleared here before the error propagates to this
  // `useAsyncAction`'s normal toast handling - mirrors `useElectionDay.ts`'s
  // identical pattern for its own 8 admin/import mutations exactly.
  const { run: runManageCoordinators, busy: managingCoordinators } = useAsyncAction(
    async (actions: CoordinatorAction[]) => {
      const proof = useCoordinatorAllocationReauthProof.getState().proof ?? "";
      try {
        return await manageCoordinatorsTrusted(proof, actions);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useCoordinatorAllocationReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.coordinatorsSaved },
  );
  const manageCoordinatorsRaw = useCallback(
    async (actions: CoordinatorAction[]) => {
      const result = await runManageCoordinators(actions);
      if (result) reloadCoordinators();
      return result;
    },
    [runManageCoordinators, reloadCoordinators],
  );
  const manageCoordinators = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    (actions: CoordinatorAction[], copy: ReauthCopy) =>
      reauth.gate(copy, () => manageCoordinatorsRaw(actions)),
    "manageCoordinators",
  );

  const { run: runApplyInitialAllocation, busy: applyingInitialAllocation } =
    useAsyncAction(
      async (assignments: AllocationAssignment[]) => {
        const proof = useCoordinatorAllocationReauthProof.getState().proof ?? "";
        try {
          return await applyInitialAllocationTrusted(proof, assignments);
        } catch (err) {
          if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
            useCoordinatorAllocationReauthProof.getState().clearProof();
          }
          throw err;
        }
      },
      {
        successMessage:
          ELECTION_DAY_TEXT.coordinatorAllocation.toast.initialAllocationApplied,
      },
    );
  const applyInitialAllocationRaw = useCallback(
    async (assignments: AllocationAssignment[]) => {
      const result = await runApplyInitialAllocation(assignments);
      if (result) reloadCoordinators();
      return result;
    },
    [runApplyInitialAllocation, reloadCoordinators],
  );
  const applyInitialAllocation = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    (assignments: AllocationAssignment[], copy: ReauthCopy) =>
      reauth.gate(copy, () => applyInitialAllocationRaw(assignments)),
    "applyInitialAllocation",
  );

  const { run: runRebalanceAssignments, busy: rebalancing } = useAsyncAction(
    async (sources: AllocationAssignment[], destinations: AllocationAssignment[]) => {
      const proof = useCoordinatorAllocationReauthProof.getState().proof ?? "";
      try {
        return await rebalanceAssignmentsTrusted(proof, sources, destinations);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useCoordinatorAllocationReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.rebalanced },
  );
  const rebalanceAssignmentsRaw = useCallback(
    async (sources: AllocationAssignment[], destinations: AllocationAssignment[]) => {
      const result = await runRebalanceAssignments(sources, destinations);
      if (result) reloadCoordinators();
      return result;
    },
    [runRebalanceAssignments, reloadCoordinators],
  );
  const rebalanceAssignments = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    (
      sources: AllocationAssignment[],
      destinations: AllocationAssignment[],
      copy: ReauthCopy,
    ) => reauth.gate(copy, () => rebalanceAssignmentsRaw(sources, destinations)),
    "rebalanceAssignments",
  );

  const { run: runEndCoordinatorActivity, busy: endingCoordinatorActivity } =
    useAsyncAction(
      async (
        coordinatorId: string,
        mode: EndCoordinatorActivityMode,
        targetCoordinatorId: string | null,
      ) => {
        const proof = useCoordinatorAllocationReauthProof.getState().proof ?? "";
        try {
          return await endCoordinatorActivityTrusted(
            proof,
            coordinatorId,
            mode,
            targetCoordinatorId,
          );
        } catch (err) {
          if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
            useCoordinatorAllocationReauthProof.getState().clearProof();
          }
          throw err;
        }
      },
      { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.coordinatorEnded },
    );
  const endCoordinatorActivityRaw = useCallback(
    async (
      coordinatorId: string,
      mode: EndCoordinatorActivityMode,
      targetCoordinatorId: string | null,
    ) => {
      const result = await runEndCoordinatorActivity(
        coordinatorId,
        mode,
        targetCoordinatorId,
      );
      if (result) reloadCoordinators();
      return result;
    },
    [runEndCoordinatorActivity, reloadCoordinators],
  );
  const endCoordinatorActivity = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    (
      coordinatorId: string,
      mode: EndCoordinatorActivityMode,
      targetCoordinatorId: string | null,
      copy: ReauthCopy,
    ) =>
      reauth.gate(copy, () =>
        endCoordinatorActivityRaw(coordinatorId, mode, targetCoordinatorId),
      ),
    "endCoordinatorActivity",
  );

  return {
    coordinators: coordinators ?? [],
    coordinatorsLoaded: coordinators !== null,
    activeCoordinators,
    coordinatorStats,
    unassignedCount,
    assignedCount,
    reloadCoordinators,
    managingCoordinators,
    manageCoordinators,
    applyingInitialAllocation,
    applyInitialAllocation,
    rebalancing,
    rebalanceAssignments,
    endingCoordinatorActivity,
    endCoordinatorActivity,
    reauthDialog: reauth.reauthDialog,
  };
}

export type CoordinatorAllocationHook = ReturnType<typeof useCoordinatorAllocation>;
