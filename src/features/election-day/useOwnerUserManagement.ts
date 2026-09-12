import { useCallback } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import type { NewPermissionUser } from "../../services/api/types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  createOwnerPermissionUser,
  deleteOwnerPermissionUser,
  fetchOwnerPermissionUsers,
  resetOwnerPermissionUserPassword,
} from "./electionDayOwnerClient";
import { useOwnerReauth } from "./useOwnerReauth";
import { useOwnerSession } from "./ownerSession";

function mapOwnerMutationErrorCode(code: string): string {
  const errors = ELECTION_DAY_TEXT.owner.mutationErrors;
  return code in errors ? errors[code as keyof typeof errors] : errors.SERVER_ERROR;
}

/**
 * Platform Stage 9: Election Owner user management - the only user
 * management left in the app (the worker-side flow was removed).
 *
 * Mirrors `useOwnerRoleManagement.ts`: no `can(permission)` gate (Owner
 * authority is the Owner JWT + a fresh password step-up, enforced
 * server-side), a never-cached one-time proof per action (`useOwnerReauth`),
 * and an authoritative refetch after every successful mutation. A workspace
 * with zero users is an ordinary, empty state here - nothing is required
 * before the Owner can use the rest of the administration area.
 */
export function useOwnerUserManagement() {
  const owner = useOwnerSession((s) => s.owner);
  const getAccessToken = useOwnerSession((s) => s.getAccessToken);
  const reauth = useOwnerReauth();

  const fetchUsers = useCallback(async () => {
    if (!owner) return [];
    const accessToken = await getAccessToken();
    if (!accessToken) throw new Error("unauthorized");
    const result = await fetchOwnerPermissionUsers(accessToken);
    if (result.status !== "ok") throw new Error(result.status);
    return result.data;
  }, [owner, getAccessToken]);
  const { data: users, error: loadError, reload } = useAsyncData(fetchUsers);

  const { run: runCreate } = useAsyncAction(
    async (proof: string, accessToken: string, input: NewPermissionUser) => {
      const result = await createOwnerPermissionUser(accessToken, proof, input);
      if (result.status === "ok") return true;
      throw new Error(mapOwnerMutationErrorCode(result.code));
    },
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.added },
  );
  const createUser = useCallback(
    (input: NewPermissionUser) =>
      reauth.gate(
        "create_permission_user",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.addPermissionUser(input.name),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runCreate(proof, accessToken, input);
          if (result) reload();
          return result;
        },
      ),
    [reauth, runCreate, reload],
  );

  const { run: runDelete } = useAsyncAction(
    async (proof: string, accessToken: string, id: string) => {
      const result = await deleteOwnerPermissionUser(accessToken, proof, id);
      if (result.status === "ok") return true;
      throw new Error(mapOwnerMutationErrorCode(result.code));
    },
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.deleted },
  );
  const deleteUser = useCallback(
    (id: string) => {
      const targetName = (users ?? []).find((u) => u.id === id)?.name ?? "";
      return reauth.gate(
        "delete_permission_user",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.deletePermissionUser(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runDelete(proof, accessToken, id);
          if (result) reload();
          return result;
        },
      );
    },
    [reauth, runDelete, reload, users],
  );

  // No successMessage: ResetPasswordDialog shows its own (it knows the name).
  const { run: runReset } = useAsyncAction(
    async (proof: string, accessToken: string, id: string, newPassword: string) => {
      const result = await resetOwnerPermissionUserPassword(
        accessToken,
        proof,
        id,
        newPassword,
      );
      if (result.status === "ok") return true;
      throw new Error(mapOwnerMutationErrorCode(result.code));
    },
  );
  const resetPassword = useCallback(
    (id: string, newPassword: string) => {
      const targetName = (users ?? []).find((u) => u.id === id)?.name ?? "";
      const dialogs = ELECTION_DAY_TEXT.reauth.dialogs;
      return reauth.gate(
        "reset_permission_user_password",
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: dialogs.resetPermissionUserPassword(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        async (proof, accessToken) => {
          const result = await runReset(proof, accessToken, id, newPassword);
          if (result) reload();
          return result;
        },
      );
    },
    [reauth, runReset, reload, users],
  );

  return {
    users: users ?? [],
    loaded: users !== null,
    loadError,
    reload,
    createUser,
    deleteUser,
    resetPassword,
    reauthDialog: reauth.reauthDialog,
  };
}
