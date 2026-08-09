import { Tabs } from "../../components/ui/Tabs";
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
