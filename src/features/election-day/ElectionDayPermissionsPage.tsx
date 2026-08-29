import { usePermissions } from "../../permissions/usePermissions";
import { useElectionDayShell } from "./ElectionDayShell";
import { PermissionUsersPanel } from "./PermissionUsersPanel";

/** Navigation Refactor: `/election-day/permissions` - the old accordion's
 * "ניהול הרשאות ומשתמשים" category. Phase 3C Roles Mutations: the "roles"
 * tab (backed by `useRoleManagement`/the legacy `election_day_*_role_v2`
 * mutation RPCs) was removed here - Role Management moved to Election Owner
 * authority exclusively (`OwnerRolesPage.tsx`, `/election-day/owner/roles`,
 * behind `OwnerAuthGuard`, never a PermissionUser permission). This screen
 * now only ever renders the Users tab's content directly (no `Tabs` needed
 * for a single tab); the Users flow itself is completely untouched by this
 * change - PermissionUser/Users management stays exactly as it was. */
export function ElectionDayPermissionsPage() {
  const electionDay = useElectionDayShell();
  const { can } = usePermissions();

  // This page only ever renders behind `ElectionDayGuard`'s authenticated
  // session check now (the legacy unauthenticated bootstrap window was
  // removed - see ElectionDayGuard.tsx and CURRENT_STATUS.md), so
  // `canManageUsers` is a plain, unwidened permission check - the Add-user
  // form (and the delete/reset actions column) only ever renders for a real
  // signed-in session actually holding `electionDay.manageUsers`.
  const canManageUsers = can("electionDay.manageUsers");

  return (
    <PermissionUsersPanel
      users={electionDay.permissionUsers}
      roles={electionDay.roles}
      onAdd={electionDay.addPermissionUser}
      onDelete={electionDay.deletePermissionUser}
      onReset={electionDay.resetPermissionUserPassword}
      canManageUsers={canManageUsers}
    />
  );
}
