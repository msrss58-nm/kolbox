import { useCallback, useEffect, useMemo } from "react";
import { toast } from "../../components/ui/Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api } from "../../services/api";
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
import { useElectionDaySession } from "./electionDaySession";

/**
 * Coordinator Allocation Management (Phase 4 data layer): owns the
 * coordinator roster and the 4 actor-password-authenticated allocation RPCs
 * (`election_day_manage_coordinators` / `apply_initial_allocation` /
 * `rebalance_assignments` / `end_coordinator_activity`), gated end-to-end on
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
 * Never holds a password in state - every mutation takes `actorPassword` as
 * a direct call argument, forwarded straight to the API layer and never
 * stored anywhere in this hook; `actorId` is read from the existing
 * Election Day session, never client-typed (mirrors
 * `resetPermissionUserPassword` in `useElectionDay.ts`). The future Phase 5
 * password dialog owns collecting `actorPassword` from the user - this hook
 * only accepts and forwards it.
 */
export function useCoordinatorAllocation(
  contacts: readonly ElectionDayVoter[],
  reasonsById: ReadonlyMap<string, NonVotingReason>,
) {
  const { can, role } = usePermissions();
  const sessionUser = useElectionDaySession((s) => s.user);

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

  // The `!sessionUser` branch in each runner below is unreachable in
  // practice - `guardedAction`'s `can("electionDay.manageCoordinatorAllocation")`
  // check already requires a resolved session (see `usePermissions.ts`'s
  // `sessionUser?.roleId ?? null`) - kept only so these closures never need
  // a non-null assertion, mirroring `resetPermissionUserPassword`'s
  // identical comment in `useElectionDay.ts`.
  const { run: runManageCoordinators, busy: managingCoordinators } = useAsyncAction(
    (actorPassword: string, actions: CoordinatorAction[]) => {
      if (!sessionUser) {
        return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
      }
      return api.manageCoordinators(sessionUser.id, actorPassword, actions);
    },
    { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.coordinatorsSaved },
  );
  const manageCoordinatorsRaw = useCallback(
    async (actorPassword: string, actions: CoordinatorAction[]) => {
      const result = await runManageCoordinators(actorPassword, actions);
      if (result) reloadCoordinators();
      return result;
    },
    [runManageCoordinators, reloadCoordinators],
  );
  const manageCoordinators = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    manageCoordinatorsRaw,
    "manageCoordinators",
  );

  const { run: runApplyInitialAllocation, busy: applyingInitialAllocation } =
    useAsyncAction(
      (actorPassword: string, assignments: AllocationAssignment[]) => {
        if (!sessionUser) {
          return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
        }
        return api.applyInitialAllocation(sessionUser.id, actorPassword, assignments);
      },
      {
        successMessage:
          ELECTION_DAY_TEXT.coordinatorAllocation.toast.initialAllocationApplied,
      },
    );
  const applyInitialAllocationRaw = useCallback(
    async (actorPassword: string, assignments: AllocationAssignment[]) => {
      const result = await runApplyInitialAllocation(actorPassword, assignments);
      if (result) reloadCoordinators();
      return result;
    },
    [runApplyInitialAllocation, reloadCoordinators],
  );
  const applyInitialAllocation = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    applyInitialAllocationRaw,
    "applyInitialAllocation",
  );

  const { run: runRebalanceAssignments, busy: rebalancing } = useAsyncAction(
    (
      actorPassword: string,
      sources: AllocationAssignment[],
      destinations: AllocationAssignment[],
    ) => {
      if (!sessionUser) {
        return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
      }
      return api.rebalanceAssignments(
        sessionUser.id,
        actorPassword,
        sources,
        destinations,
      );
    },
    { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.rebalanced },
  );
  const rebalanceAssignmentsRaw = useCallback(
    async (
      actorPassword: string,
      sources: AllocationAssignment[],
      destinations: AllocationAssignment[],
    ) => {
      const result = await runRebalanceAssignments(actorPassword, sources, destinations);
      if (result) reloadCoordinators();
      return result;
    },
    [runRebalanceAssignments, reloadCoordinators],
  );
  const rebalanceAssignments = guardedAction(
    "electionDay.manageCoordinatorAllocation",
    rebalanceAssignmentsRaw,
    "rebalanceAssignments",
  );

  const { run: runEndCoordinatorActivity, busy: endingCoordinatorActivity } =
    useAsyncAction(
      (
        actorPassword: string,
        coordinatorId: string,
        mode: EndCoordinatorActivityMode,
        targetCoordinatorId: string | null,
      ) => {
        if (!sessionUser) {
          return Promise.reject(new Error(ELECTION_DAY_TEXT.permissionDenied));
        }
        return api.endCoordinatorActivity(
          sessionUser.id,
          actorPassword,
          coordinatorId,
          mode,
          targetCoordinatorId,
        );
      },
      { successMessage: ELECTION_DAY_TEXT.coordinatorAllocation.toast.coordinatorEnded },
    );
  const endCoordinatorActivityRaw = useCallback(
    async (
      actorPassword: string,
      coordinatorId: string,
      mode: EndCoordinatorActivityMode,
      targetCoordinatorId: string | null,
    ) => {
      const result = await runEndCoordinatorActivity(
        actorPassword,
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
    endCoordinatorActivityRaw,
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
  };
}

export type CoordinatorAllocationHook = ReturnType<typeof useCoordinatorAllocation>;
