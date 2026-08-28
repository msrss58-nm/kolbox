import { useCallback } from "react";
import { toast } from "../../components/ui/Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import { normalizeRoleRecord } from "../../permissions/roleRecordMapper";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api, ElectionDayReauthError } from "../../services/api";
import type { NewRole, RoleUpdate } from "../../services/api";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { fetchTrustedRoles } from "./electionDayTrustedRolesClient";
import { useElectionDayReauthProof } from "./electionDayReauthProof";
import { useElectionDayReauth } from "./useElectionDayReauth";

/**
 * Dynamic Roles & Permissions Phase 2: owns the "תפקידים" management
 * surface's data/mutations, gated end-to-end on `electionDay.manageRolesAndPermissions`
 * - mirrors `useElectionDay.ts`'s `guardedAction` pattern exactly (checks
 * `can(permission)` before any API call, reports a denial, never a silent
 * no-op).
 *
 * Reloads both this hook's own role list AND `useRoleCatalogStore` (the
 * live permission engine's source of truth) after every successful
 * mutation - important since an edit might change the *caller's own*
 * effective permissions (e.g. editing your own role), and the engine
 * should never keep serving a now-stale cached catalog.
 */
export function useRoleManagement() {
  const { can, role } = usePermissions();
  const reloadCatalog = useRoleCatalogStore((s) => s.reload);

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

  // Security Hardening (Reauth): the shared gate for this hook's 4 role-
  // management mutations - see `useElectionDayReauth.ts`'s own doc comment
  // for the full flow. `reauthDialog` is rendered by `RoleManagementPanel.tsx`.
  const reauth = useElectionDayReauth();

  // Phase 3C Roles: role-catalog READ cut over to the trusted, session-
  // derived v3 path - this hook only runs inside the already-authenticated
  // shell (past ElectionDayGuard), so the HttpOnly session cookie the
  // trusted GET requires always exists here. Throws on a non-"ok" result so
  // this fetcher's error contract matches the legacy `api.listElectionDayRoles()`
  // call it replaces (which threw via `unwrapArray` on an RPC error) -
  // `useAsyncData`'s existing loading/error handling is unchanged. Row
  // shape validation (permissions/scope_type fail-closed handling) is
  // unchanged too - every row still goes through `normalizeRoleRecord`.
  const fetchRoles = useCallback(async () => {
    const result = await fetchTrustedRoles();
    if (result.status !== "ok") {
      throw new Error(result.status);
    }
    return result.rows.map(normalizeRoleRecord);
  }, []);
  const { data: roles, reload: reloadRoles } = useAsyncData(fetchRoles);

  // Security Hardening (Reauth): each `runXRole` action below reads the
  // currently-cached proof directly from the store (rather than taking it
  // as an argument) - by the time it runs, `reauth.gate` (in the guarded
  // top-level function further down) has already guaranteed a valid proof
  // is cached. On the RPC's own `UNAUTHORIZED`, the stale proof is cleared
  // here before the error propagates to `useAsyncAction`'s normal toast
  // handling - same pattern as `useElectionDay.ts`'s admin mutations.
  const { run: runCreateRole, busy: creatingRole } = useAsyncAction(
    async (input: NewRole) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.createRole(proof, input);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.created },
  );
  const createRoleRaw = useCallback(
    async (input: NewRole) => {
      const result = await runCreateRole(input);
      if (result) {
        reloadRoles();
        void reloadCatalog();
      }
      return result;
    },
    [runCreateRole, reloadRoles, reloadCatalog],
  );
  const createRole = guardedAction(
    "electionDay.manageRolesAndPermissions",
    (input: NewRole) =>
      reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.createRole,
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => createRoleRaw(input),
      ),
    "createRole",
  );

  const { run: runUpdateRole, busy: updatingRole } = useAsyncAction(
    async (input: RoleUpdate) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.updateRole(proof, input);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.updated },
  );
  const updateRoleRaw = useCallback(
    async (input: RoleUpdate) => {
      const result = await runUpdateRole(input);
      if (result) {
        reloadRoles();
        void reloadCatalog();
      }
      return result;
    },
    [runUpdateRole, reloadRoles, reloadCatalog],
  );
  const updateRole = guardedAction(
    "electionDay.manageRolesAndPermissions",
    (input: RoleUpdate) =>
      reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.updateRole(input.name),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => updateRoleRaw(input),
      ),
    "updateRole",
  );

  // Wrapped to resolve to an explicit `true` sentinel on success (the
  // underlying `api.deleteRole` resolves void, otherwise indistinguishable
  // from a blocked/failed call - same pattern as `clearElectionDayDataRaw`
  // in useElectionDay.ts).
  const { run: runDeleteRole, busy: deletingRole } = useAsyncAction(
    async (id: string) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        await api.deleteRole(proof, id);
        return true;
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.deleted },
  );
  const deleteRoleRaw = useCallback(
    async (id: string) => {
      const result = await runDeleteRole(id);
      if (result === undefined) return undefined;
      reloadRoles();
      void reloadCatalog();
      return true;
    },
    [runDeleteRole, reloadRoles, reloadCatalog],
  );
  const deleteRole = guardedAction(
    "electionDay.manageRolesAndPermissions",
    (id: string) => {
      const targetName = (roles ?? []).find((r) => r.id === id)?.name ?? "";
      return reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.deleteRole(targetName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => deleteRoleRaw(id),
      );
    },
    "deleteRole",
  );

  const { run: runCloneRole, busy: cloningRole } = useAsyncAction(
    async (input: { id: string; newName: string }) => {
      const proof = useElectionDayReauthProof.getState().proof ?? "";
      try {
        return await api.cloneRole(proof, input.id, input.newName);
      } catch (err) {
        if (err instanceof ElectionDayReauthError && err.code === "UNAUTHORIZED") {
          useElectionDayReauthProof.getState().clearProof();
        }
        throw err;
      }
    },
    { successMessage: ELECTION_DAY_TEXT.rolesManager.toast.cloned },
  );
  const cloneRoleRaw = useCallback(
    async (id: string, newName: string) => {
      const result = await runCloneRole({ id, newName });
      if (result) {
        reloadRoles();
        void reloadCatalog();
      }
      return result;
    },
    [runCloneRole, reloadRoles, reloadCatalog],
  );
  const cloneRole = guardedAction(
    "electionDay.manageRolesAndPermissions",
    (id: string, newName: string) => {
      const sourceName = (roles ?? []).find((r) => r.id === id)?.name ?? "";
      return reauth.gate(
        {
          title: ELECTION_DAY_TEXT.reauth.dialogTitle,
          summary: ELECTION_DAY_TEXT.reauth.dialogs.cloneRole(sourceName),
          confirmLabel: ELECTION_DAY_TEXT.reauth.confirmButton,
        },
        () => cloneRoleRaw(id, newName),
      );
    },
    "cloneRole",
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
    // Security Hardening (Reauth): the shared password-reauth dialog for
    // this hook's 4 gated mutations - `null` while no reauth is pending.
    // Rendered by `RoleManagementPanel.tsx`.
    reauthDialog: reauth.reauthDialog,
  };
}

export type RoleManagementHook = ReturnType<typeof useRoleManagement>;
