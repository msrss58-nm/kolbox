import { useCallback, useState } from "react";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import type { NewPermissionUser } from "../../services/api/types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import {
  checkOwnerPermissionUsername,
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

  // A taken login username is NOT a failure toast: it is a decision the Owner
  // has to make, so it is surfaced as state the form can act on.
  const [usernameCollision, setUsernameCollision] = useState<{
    requested: string;
    suggestion: string | null;
  } | null>(null);

  const { run: runCreate } = useAsyncAction(
    async (accessToken: string, input: NewPermissionUser) => {
      const result = await createOwnerPermissionUser(accessToken, input);
      if (result.status === "ok") {
        setUsernameCollision(null);
        return true;
      }
      if (result.code === "USERNAME_TAKEN") {
        setUsernameCollision({
          requested: (input.username ?? input.name).trim(),
          suggestion: result.suggestion ?? null,
        });
        // Swallowed deliberately: the form renders the collision inline, and a
        // generic red toast on top of it would be noise, not information.
        return false;
      }
      throw new Error(mapOwnerMutationErrorCode(result.code));
    },
    { successMessage: ELECTION_DAY_TEXT.permissionsManager.toast.added },
  );
  const clearUsernameCollision = useCallback(() => setUsernameCollision(null), []);

  /**
   * Creating a user no longer opens the Owner password step-up. The Owner is
   * already signed in; every check that actually authorizes this still runs,
   * server-side, on every call (see owner-actions.ts).
   *
   * The refresh is the LAST thing this does on success and it is
   * unconditional - it is not a side effect of whatever control flow the
   * dialog happens to take. `reload()` re-reads the roster from the server,
   * which is what both the list and the header count render from, so the two
   * can never disagree or need a navigation to catch up.
   */
  const createUser = useCallback(
    async (input: NewPermissionUser) => {
      const accessToken = await getAccessToken();
      if (!accessToken) return undefined;
      const result = await runCreate(accessToken, input);
      if (result === true) reload();
      return result;
    },
    [getAccessToken, runCreate, reload],
  );

  /**
   * The pre-check, run before the password step. It only ever REPORTS: a free
   * name returns true, a taken one records the collision so the form can
   * offer the next free name in one click. It claims nothing and grants
   * nothing - the unique index enforced at create time stays the authority,
   * and a name that is taken in between is caught there (the dialog then
   * returns to this step with a fresh suggestion).
   */
  const checkUsername = useCallback(
    async (username: string): Promise<boolean> => {
      const accessToken = await getAccessToken();
      if (!accessToken) return false;
      const result = await checkOwnerPermissionUsername(accessToken, username);
      if (result.status !== "ok") return false;
      if (result.available) {
        setUsernameCollision(null);
        return true;
      }
      setUsernameCollision({
        requested: username.trim(),
        suggestion: result.suggestion,
      });
      return false;
    },
    [getAccessToken],
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
    checkUsername,
    deleteUser,
    resetPassword,
    reauthDialog: reauth.reauthDialog,
    usernameCollision,
    clearUsernameCollision,
  };
}
