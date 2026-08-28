import { Tabs } from "../../components/ui/Tabs";
import { usePermissions } from "../../permissions/usePermissions";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayShell } from "./ElectionDayShell";
import { PermissionUsersPanel } from "./PermissionUsersPanel";
import { RoleManagementPanel } from "./RoleManagementPanel";
import { useRoleManagement } from "./useRoleManagement";

/** Navigation Refactor: `/election-day/permissions` - the old accordion's
 * "ניהול הרשאות ומשתמשים" category, now a standalone page with a
 * users/roles tab pair instead of two separate modals. `useRoleManagement`
 * is screen-specific (not lifted to `ElectionDayShell`), same as it was
 * called directly inside `ElectionDayPage.tsx` before this refactor. */
export function ElectionDayPermissionsPage() {
  const electionDay = useElectionDayShell();
  const roleManagement = useRoleManagement();
  const { can } = usePermissions();

  // This page only ever renders behind `ElectionDayGuard`'s authenticated
  // session check now (the legacy unauthenticated bootstrap window was
  // removed - see ElectionDayGuard.tsx and CURRENT_STATUS.md), so
  // `canManageUsers` is a plain, unwidened permission check - the Add-user
  // form (and the delete/reset actions column) only ever renders for a real
  // signed-in session actually holding `electionDay.manageUsers`.
  const canManageUsers = can("electionDay.manageUsers");

  return (
    <Tabs
      tabs={[
        {
          id: "users",
          label: ELECTION_DAY_TEXT.permissionsPage.usersTab,
          content: (
            <PermissionUsersPanel
              users={electionDay.permissionUsers}
              roles={electionDay.roles}
              onAdd={electionDay.addPermissionUser}
              onDelete={electionDay.deletePermissionUser}
              deleting={electionDay.deletingPermissionUser}
              onReset={electionDay.resetPermissionUserPassword}
              canManageUsers={canManageUsers}
            />
          ),
        },
        {
          id: "roles",
          label: ELECTION_DAY_TEXT.permissionsPage.rolesTab,
          content: (
            <RoleManagementPanel
              permissionUsers={electionDay.permissionUsers}
              roleManagement={roleManagement}
            />
          ),
        },
      ]}
    />
  );
}
