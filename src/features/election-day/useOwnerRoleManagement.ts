import { useCallback } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { normalizeRoleRecord } from "../../permissions/roleRecordMapper";
import {
  cloneOwnerRole,
  createOwnerRole,
  deleteOwnerRole,
  fetchOwnerRoles,
  updateOwnerRole,
} from "./electionDayOwnerClient";
import type { NewRole, RoleUpdate } from "../../services/api/types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useOwnerReauth } from "./useOwnerReauth";
import { useOwnerSession } from "./ownerSession";

function mapOwnerMutationErrorCode(code: string): string {
  const errors = ELECTION_DAY_TEXT.owner.mutationErrors;
  return code in errors ? errors[code as keyof typeof errors] : errors.SERVER_ERROR;
}

/**
 * Phase 3C Roles Mutations: the Owner-authorized counterpart to
 * `useRoleManagement.ts`. Structurally mirrors it closely (same return
 * shape, so `RoleManagementPanel.tsx` is reused unchanged for the Owner
 * surface too) with two deliberate differences:
 *   - No `can(permission)`/`guardedAction` gate - Owner mutation authority is
 *     the Owner JWT + fresh password step-up itself (enforced server-side by
 *     `election_day_verify_and_consume_owner_proof`), never a PermissionUser
 *     permission (see the 20260828070000 migration header for the full,
 *     evidence-based reasoning for why `electionDay.manageRolesAndPermissions`
 *     plays no role here).
 *   - Calls `useOwnerReauth.ts` (never-cached, always-fresh-password-per-action)
 *     instead of `useElectionDayReauth.ts` (5-minute cached-proof fast path) -
 *     see that hook's own doc comment.
 */
export function useOwnerRoleManagement() {
  const owner = useOwnerSession((s) => s.owner);
  const getAccessToken = useOwnerSession((s) => s.getAccessToken);
  const reauth = useOwnerReauth();

  const fetchRoles = useCallback(async () => {
    if (!owner) return [];
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error("unauthorized");
    const result = await fetchOwnerRoles(accessToken);
    if (result.status !== "ok") {
      throw new Error(result.status);
    }
    return result.rows.map(normalizeRoleRecord);
  }, [owner, getAccessToken]);
  const { data: roles, reload: reloadRoles } = useAsyncData(fetchRoles);

  const { run: runCreateRole, busy: creatingRole } = useAsyncAction(
    async (proof: string, accessToken: string, input: NewRole) => {
      const result = await createOwnerRole(accessToken, proof, input);
      if (result.status === "ok") return normalizeRoleRecord(result.row);
      throw new Error(
        mapOwnerMutationErrorCode(
          result.status === "error" ? result.code : "SERVER_ERROR",
        ),
      );
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.created },
  );
  const createRole = useCallback(
    (input: NewRole) =>
      reauth.gate(
        "create_role",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.createRole,
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runCreateRole(proof, accessToken, input);
          if (result) {
            reloadRoles();
          }
          return result;
        },
      ),
    [reauth, runCreateRole, reloadRoles],
  );

  const { run: runUpdateRole, busy: updatingRole } = useAsyncAction(
    async (proof: string, accessToken: string, input: RoleUpdate) => {
      const result = await updateOwnerRole(accessToken, proof, input);
      if (result.status === "ok") return normalizeRoleRecord(result.row);
      throw new Error(
        mapOwnerMutationErrorCode(
          result.status === "error" ? result.code : "SERVER_ERROR",
        ),
      );
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.updated },
  );
  const updateRole = useCallback(
    (input: RoleUpdate) =>
      reauth.gate(
        "update_role",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.updateRole(input.name),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runUpdateRole(proof, accessToken, input);
          if (result) {
            reloadRoles();
          }
          return result;
        },
      ),
    [reauth, runUpdateRole, reloadRoles],
  );

  const { run: runDeleteRole, busy: deletingRole } = useAsyncAction(
    async (proof: string, accessToken: string, id: string) => {
      const result = await deleteOwnerRole(accessToken, proof, id);
      if (result.status === "ok_void") return true;
      throw new Error(
        mapOwnerMutationErrorCode(
          result.status === "error" ? result.code : "SERVER_ERROR",
        ),
      );
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.deleted },
  );
  const deleteRole = useCallback(
    (id: string) => {
      const targetName = (roles ?? []).find((r) => r.id === id)?.name ?? "";
      return reauth.gate(
        "delete_role",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.deleteRole(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runDeleteRole(proof, accessToken, id);
          if (result === undefined) return undefined;
          reloadRoles();
          return true;
        },
      );
    },
    [reauth, runDeleteRole, reloadRoles, roles],
  );

  const { run: runCloneRole, busy: cloningRole } = useAsyncAction(
    async (
      proof: string,
      accessToken: string,
      input: { id: string; newName: string },
    ) => {
      const result = await cloneOwnerRole(accessToken, proof, input.id, input.newName);
      if (result.status === "ok") return normalizeRoleRecord(result.row);
      throw new Error(
        mapOwnerMutationErrorCode(
          result.status === "error" ? result.code : "SERVER_ERROR",
        ),
      );
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.cloned },
  );
  const cloneRole = useCallback(
    (id: string, newName: string) => {
      const sourceName = (roles ?? []).find((r) => r.id === id)?.name ?? "";
      return reauth.gate(
        "clone_role",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.cloneRole(sourceName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runCloneRole(proof, accessToken, { id, newName });
          if (result) {
            reloadRoles();
          }
          return result;
        },
      );
    },
    [reauth, runCloneRole, reloadRoles, roles],
  );

  return {
    roles: roles ?? [],
    rolesLoaded: roles !== null,
    creatingRole,
    updatingRole,
    deletingRole,
    cloningRole,
    createRole,
    updateRole,
    deleteRole,
    cloneRole,
    reauthDialog: reauth.reauthDialog,
  };
}

export type OwnerRoleManagementHook = ReturnType<typeof useOwnerRoleManagement>;
