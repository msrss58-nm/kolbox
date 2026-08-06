import { useCallback } from "react";
import { toast } from "../../components/ui/Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api } from "../../services/api";
import type { NewNonVotingReason, NonVotingReasonUpdate } from "../../services/api";
import type { NonVotingReason } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

/**
 * Dynamic Non-Voting Reasons: owns the "ניהול סיבות אי-הצבעה" management
 * surface's mutations, gated end-to-end on
 * `electionDay.manageNonVotingReasons` - mirrors `useRoleManagement.ts`'s
 * `guardedAction` pattern exactly (checks `can(permission)` before any API
 * call, reports a denial, never a silent no-op).
 *
 * Unlike `useRoleManagement.ts`, this hook does NOT fetch its own copy of
 * the catalog - `reasons`/`reload` are passed in from `useElectionDay.ts`
 * (the single fetch already used for the row/filter display), so a mutation
 * here and the read used everywhere else can never drift out of sync the
 * way two independent `useAsyncData` calls could.
 */
export function useNonVotingReasons(
  reasons: readonly NonVotingReason[],
  reload: () => void,
) {
  const { can, role } = usePermissions();

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

  const { run: runCreate, busy: creating } = useAsyncAction(
    (input: NewNonVotingReason) => api.createNonVotingReason(input),
    { successMessage: ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.created },
  );
  const createReasonRaw = useCallback(
    async (input: NewNonVotingReason) => {
      const result = await runCreate(input);
      if (result) reload();
      return result;
    },
    [runCreate, reload],
  );
  const createReason = guardedAction(
    "electionDay.manageNonVotingReasons",
    createReasonRaw,
    "createNonVotingReason",
  );

  const { run: runUpdate, busy: updating } = useAsyncAction(
    (input: NonVotingReasonUpdate) => api.updateNonVotingReason(input),
    { successMessage: ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.updated },
  );
  const updateReasonRaw = useCallback(
    async (input: NonVotingReasonUpdate) => {
      const result = await runUpdate(input);
      if (result) reload();
      return result;
    },
    [runUpdate, reload],
  );
  const updateReason = guardedAction(
    "electionDay.manageNonVotingReasons",
    updateReasonRaw,
    "updateNonVotingReason",
  );

  const { run: runSetActive, busy: settingActive } = useAsyncAction(
    (id: string, isActive: boolean) => api.setNonVotingReasonActive(id, isActive),
    {
      successMessage: (reason) =>
        reason.isActive
          ? ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.activated
          : ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.deactivated,
    },
  );
  const setReasonActiveRaw = useCallback(
    async (id: string, isActive: boolean) => {
      const result = await runSetActive(id, isActive);
      if (result) reload();
      return result;
    },
    [runSetActive, reload],
  );
  const setReasonActive = guardedAction(
    "electionDay.manageNonVotingReasons",
    setReasonActiveRaw,
    "setNonVotingReasonActive",
  );

  // Wrapped to resolve to an explicit `true` sentinel on success (the
  // underlying `api.deleteNonVotingReason` resolves void, otherwise
  // indistinguishable from a blocked/failed call) - same pattern as
  // `useRoleManagement.ts`'s `deleteRole`.
  const { run: runDelete, busy: deleting } = useAsyncAction(
    async (id: string) => {
      await api.deleteNonVotingReason(id);
      return true;
    },
    { successMessage: ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.deleted },
  );
  const deleteReasonRaw = useCallback(
    async (id: string) => {
      const result = await runDelete(id);
      if (result === undefined) return undefined;
      reload();
      return true;
    },
    [runDelete, reload],
  );
  const deleteReason = guardedAction(
    "electionDay.manageNonVotingReasons",
    deleteReasonRaw,
    "deleteNonVotingReason",
  );

  const { run: runReorder, busy: reordering } = useAsyncAction(
    (orderedIds: string[]) => api.reorderNonVotingReasons(orderedIds),
    { successMessage: ELECTION_DAY_TEXT.nonVotingReasonsManager.toast.reordered },
  );
  const reorderReasonsRaw = useCallback(
    async (orderedIds: string[]) => {
      const result = await runReorder(orderedIds);
      if (result) reload();
      return result;
    },
    [runReorder, reload],
  );
  const reorderReasons = guardedAction(
    "electionDay.manageNonVotingReasons",
    reorderReasonsRaw,
    "reorderNonVotingReasons",
  );

  /** Swaps `reason` with its neighbor one step toward the start (`up`) or
   * end (`down`) of the current order and submits the full resulting id
   * list - a thin convenience wrapper around `reorderReasons` for the
   * management screen's ▲▼ buttons, which only ever move one item at a
   * time. A no-op at either end of the list. */
  const moveReason = useCallback(
    (reason: NonVotingReason, direction: "up" | "down") => {
      const index = reasons.findIndex((r) => r.id === reason.id);
      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (index === -1 || targetIndex < 0 || targetIndex >= reasons.length) return;
      const ids = reasons.map((r) => r.id);
      [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
      void reorderReasons(ids);
    },
    [reasons, reorderReasons],
  );

  return {
    reasons,
    creating,
    updating,
    settingActive,
    deleting,
    reordering,
    createReason,
    updateReason,
    setReasonActive,
    deleteReason,
    moveReason,
  };
}

export type NonVotingReasonsHook = ReturnType<typeof useNonVotingReasons>;
