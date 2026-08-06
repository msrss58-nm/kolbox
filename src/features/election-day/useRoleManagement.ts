import { useCallback } from "react";
import { toast } from "../../components/ui/Toast";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useAsyncData } from "../../hooks/useAsyncData";
import { reportPermissionDenied } from "../../permissions/permissionAudit";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import type { Permission } from "../../permissions/types";
import { usePermissions } from "../../permissions/usePermissions";
import { api } from "../../services/api";
import type { NewRole, RoleUpdate } from "../../services/api";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

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

  const fetchRoles = useCallback(() => api.listElectionDayRoles(), []);
  const { data: roles, reload: reloadRoles } = useAsyncData(fetchRoles);

  const { run: runCreateRole, busy: creatingRole } = useAsyncAction(
    (input: NewRole) => api.createRole(input),
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
    createRoleRaw,
    "createRole",
  );

  const { run: runUpdateRole, busy: updatingRole } = useAsyncAction(
    (input: RoleUpdate) => api.updateRole(input),
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
    updateRoleRaw,
    "updateRole",
  );

  // Wrapped to resolve to an explicit `true` sentinel on success (the
  // underlying `api.deleteRole` resolves void, otherwise indistinguishable
  // from a blocked/failed call - same pattern as `clearElectionDayDataRaw`
  // in useElectionDay.ts).
  const { run: runDeleteRole, busy: deletingRole } = useAsyncAction(
    async (id: string) => {
      await api.deleteRole(id);
      return true;
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
    deleteRoleRaw,
    "deleteRole",
  );

  const { run: runCloneRole, busy: cloningRole } = useAsyncAction(
    (input: { id: string; newName: string }) => api.cloneRole(input.id, input.newName),
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
    cloneRoleRaw,
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
  };
}

export type RoleManagementHook = ReturnType<typeof useRoleManagement>;
