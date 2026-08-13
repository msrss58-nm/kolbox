import { ShieldAlert } from "lucide-react";
import { Tabs } from "../../components/ui/Tabs";
import { EmptyState } from "../../components/ui/EmptyState";
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

  // Security Hardening (Reauth): while `isBootstrap` is true, this page
  // renders a static, non-mutating setup-required state instead of the
  // users/roles tabs - there is structurally no Add-user form, no
  // password/proof dialog, and no call of any kind to
  // `election_day_create_permission_user_v2` (which has no empty-roster
  // exception - see the Security Phase 1 audit) or the legacy v1 RPC
  // (deliberately not used as a bootstrap fallback either). A dedicated,
  // secure first-install setup process is a separate, later concern - this
  // is just "don't offer a form that can only fail or, worse, silently
  // regress back to an unauthenticated create-user path."
  if (electionDay.isBootstrap) {
    return (
      <div className="py-6">
        <EmptyState
          icon={ShieldAlert}
          title={ELECTION_DAY_TEXT.bootstrapSetupRequired.title}
          hint={ELECTION_DAY_TEXT.bootstrapSetupRequired.hint}
        />
      </div>
    );
  }

  // `electionDay.isBootstrap` is always false past the guard above, so
  // `canManageUsers` here is a plain, unwidened permission check - the Add-
  // user form (and the delete/reset actions column) only ever renders for a
  // real signed-in session actually holding `electionDay.manageUsers`.
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
