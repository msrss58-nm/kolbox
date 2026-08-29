import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { ToastContainer } from "../../components/ui/Toast";
import { ROUTES } from "../../constants/routes";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useOwnerRoleManagement } from "./useOwnerRoleManagement";
import { RoleManagementPanel } from "./RoleManagementPanel";
import { useOwnerSession } from "./ownerSession";

const text = ELECTION_DAY_TEXT.owner.rolesPage;

/**
 * Phase 3C Roles Mutations: the Owner-only Role Management surface -
 * `/election-day/owner/roles`, behind `OwnerAuthGuard`. Reuses
 * `RoleManagementPanel` unchanged, fed by `useOwnerRoleManagement` instead of
 * the PermissionUser-facing `useRoleManagement` (removed from
 * `ElectionDayPermissionsPage.tsx`'s tab set as part of this same cutover -
 * PermissionUsers/Managers no longer have a live path to Role Management at
 * all). Deliberately minimal - no Owner dashboard/onboarding UI beyond the
 * header/logout needed to reach this one screen (out of scope for this task,
 * see the task's own DO NOT list).
 *
 * Renders its own `<ToastContainer />` - unlike the main app/Election Day
 * screens, this route is NOT nested under `AppShell` (which normally
 * provides the one global toast container), so every mutation's success/
 * error feedback (`useAsyncAction`'s `successMessage`, `useOwnerReauth`'s
 * wrong-password/rate-limit errors) would otherwise be silently swallowed -
 * found via real-browser E2E testing during this task.
 */
export function OwnerRolesPage() {
  const owner = useOwnerSession((s) => s.owner);
  const logout = useOwnerSession((s) => s.logout);
  const navigate = useNavigate();
  const roleManagement = useOwnerRoleManagement();

  const { run: runLogout, busy: loggingOut } = useAsyncAction(async () => {
    await logout();
  });

  const handleLogout = async () => {
    await runLogout();
    void navigate(ROUTES.electionDayOwnerLogin, { replace: true });
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LogoMark className="size-9" />
          <div>
            <h1 className="text-lg font-extrabold text-slate-800">{text.title}</h1>
            {owner && (
              <p className="text-xs text-slate-500">{text.signedInAs(owner.email)}</p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={loggingOut}
          onClick={() => void handleLogout()}
        >
          {text.logout}
        </Button>
      </header>

      <RoleManagementPanel roleManagement={roleManagement} />
      <ToastContainer />
    </div>
  );
}
