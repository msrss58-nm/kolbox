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
import {
  buildCoordinatorAllocationStats,
  countUnassignedVoters,
} from "./coordinatorAllocationStats";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayReauthProof } from "./electionDayReauthProof";
import { useElectionDayReauth } from "./useElectionDayReauth";

/** Caller-supplied copy for the shared re-auth dialog (see
 * `useElectionDayReauth.ts`) - each allocation mutation's own confirmation
 * summary (already computed by the calling component from its own local
 * state, e.g. "add coordinator X") doubles as the reauth dialog's copy when
 * no valid proof is cached yet; mirrors `useElectionDay.ts`'s inline
 * `reauth.gate({title, summary, confirmLabel}, ...)` calls, just threaded in
 * from the caller instead of being hardcoded per-action inside this hook,
 * since a single generic `manageCoordinators`/etc. entry point is shared by
 * several different UI flows (roster editor, initial-allocation setup,
 * rebalance, end-coordinator) each with their own specific summary text. */
export interface ReauthCopy {
  title: string;
  summary: ReactNode;
  confirmLabel: string;
}

/**
 * Coordinator Allocation Management (Phase 4 data layer): owns the
 * coordinator roster and the 4 proof-authenticated allocation RPCs
 * (`election_day_manage_coordinators_v2` / `apply_initial_allocation_v2` /
 * `rebalance_assignments_v2` / `end_coordinator_activity_v2`), gated end-to-end on
 * `electionDay.manageCoordinatorAllocation` - mirrors `useRoleManagement.ts`'s
 * `guardedAction` pattern exactly (checks `can(permission)` before any API
 * call, reports a denial, never a silent no-op). A dedicated sibling hook to
 * `useElectionDay`, not folded into it - same shape of separation as
 * `useRoleManagement`/`useNonVotingReasons` for their own management
 * surfaces.
 *
 * `contacts`/`reasonsById` must be the FULL, unscoped data
 * (`useElectionDay`'s `allContacts`, not `scopedContacts`/`pagedContacts` -
 * and its own `reasonsById`) - allocation stats are a manager-only,
 * whole-picture view, same reasoning as `NonVotingReasonsModal`'s
 * usage-count in `useElectionDay.ts`'s own comment.
 *
 * Security Hardening (Reauth), Phase 2: all 4 mutations now go through the
 * same shared short-lived re-auth proof system `useElectionDay.ts`'s own 8
 * admin/import mutations already use (`useElectionDayReauth`'s `gate()`) -
 * no `actorId`/`actorPassword` is collected or forwarded by this hook at
 * all anymore. Each mutation is `guardedAction`-wrapped (unchanged
 * permission-check contract) around a `reauth.gate(copy, () => rawFn(...))`
 * call, where `copy` is supplied by the calling component (it already knows
 * the specific per-action confirmation summary). The first action after a
 * page load - or after the cached proof expires/is revoked - opens the
 * shared `AllocationPasswordDialog` (via this hook's own `reauthDialog`,
 * rendered once by `CoordinatorAllocationView.tsx`, mirroring
 * `ElectionDayShell.tsx`'s pattern for `useElectionDay`'s dialog); every
 * further action within the ~15-minute proof lifetime runs immediately with
 * no dialog at all - same trade-off already established for the admin/import
 * flows.
 */
export function useCoordinatorAllocation(
  contacts: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
) {
  const { can, role } = usePermissions();
  const reauth = useElectionDayReauth();

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

  const fetchCoordinators = useCallback(() => api.listCoordinators(), []);
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
  // the full mechanism this avoids).
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
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.manageCoordinators(proof, actions);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
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
        const proof = useElectionDayReauthProof.getState().proof ?? "";
        try {
          return await api.applyInitialAllocation(proof, assignments);
        } catch (err) {
          if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
            useElectionDayReauthProof.getState().clearProof();
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
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.rebalanceAssignments(proof, sources, destinations);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
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
        const proof = useElectionDayReauthProof.getState().proof ?? "";
        try {
          return await api.endCoordinatorActivity(
            proof,
            coordinatorId,
            mode,
            targetCoordinatorId,
          );
        } catch (err) {
          if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
            useElectionDayReauthProof.getState().clearProof();
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
