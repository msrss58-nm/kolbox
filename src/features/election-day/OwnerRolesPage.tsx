import { Building2, ShieldCheck, Users } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { ToastContainer } from "../../components/ui/Toast";
import { ROUTES } from "../../constants/routes";
import { moduleLabel } from "../../constants/labels";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { PermissionUsersPanel } from "./PermissionUsersPanel";
import { RoleManagementPanel } from "./RoleManagementPanel";
import { useOwnerRoleManagement } from "./useOwnerRoleManagement";
import { useOwnerSession } from "./ownerSession";
import { useOwnerUserManagement } from "./useOwnerUserManagement";
import { useOwnerWorkspaceSummary } from "./useOwnerWorkspaceSummary";

const text = ELECTION_DAY_TEXT.owner.rolesPage;

/**
 * The Election Owner administration area - `/election-day/owner/roles`,
 * behind `OwnerAuthGuard` (the path is kept for existing links/tests).
 *
 * Platform Stage 9: the Owner's whole administration surface, not roles only:
 *   - the workspace (name + login code) and the modules it is entitled to;
 *   - USER management (create / delete / reset) - Owner-only, the worker-side
 *     users screen no longer exists;
 *   - roles & permissions (unchanged Phase 3C surface), now with the explicit
 *     Manager-role flag.
 * A workspace with zero users is a normal state - this page is where the
 * Owner lands after provisioning and after every sign-in, and nothing on it
 * requires a user to exist first.
 *
 * Renders its own `<ToastContainer />` - this route is not nested under
 * `AppShell`, which normally provides it.
 */
export function OwnerRolesPage() {
  const owner = useOwnerSession((s) => s.owner);
  const logout = useOwnerSession((s) => s.logout);
  const navigate = useNavigate();
  const roleManagement = useOwnerRoleManagement();
  const userManagement = useOwnerUserManagement();
  const workspaceSummary = useOwnerWorkspaceSummary();
  const { summary, error: summaryError, reload: reloadSummary } = workspaceSummary;

  const { run: runLogout, busy: loggingOut } = useAsyncAction(async () => {
    await logout();
  });

  const handleLogout = async () => {
    await runLogout();
    void navigate(ROUTES.electionDayOwnerLogin, { replace: true });
  };

  const managerRoleIds = new Set(
    roleManagement.roles.filter((r) => r.isManager).map((r) => r.id),
  );
  const enabledModules = (summary?.modules ?? []).filter((m) => m.enabled);
  const electionDayEnabled = enabledModules.some((m) => m.key === "election_day");

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark className="size-9 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold text-slate-800">{text.title}</h1>
            {owner && (
              <p className="text-xs break-all text-slate-500">
                {text.signedInAs(owner.email)}
              </p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={loggingOut}
          onClick={() => void handleLogout()}
          className="shrink-0"
        >
          {text.logout}
        </Button>
      </header>

      <Card className="space-y-3" data-testid="owner-workspace-card">
        <div className="flex items-center gap-2">
          <Building2 className="size-5 text-slate-700" />
          <CardTitle>{summary?.workspaceName ?? text.workspaceTitle}</CardTitle>
        </div>
        {summaryError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-opponent">
              {text.loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={reloadSummary}>
              {text.retry}
            </Button>
          </div>
        ) : !summary ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            {summary.loginCode && (
              <div>
                <p className="text-xs text-slate-500">{text.workspaceCodeLabel}</p>
                <p
                  dir="ltr"
                  className="text-start font-mono text-xl tracking-widest text-slate-900"
                  data-testid="owner-workspace-code"
                >
                  {summary.loginCode}
                </p>
                <p className="mt-1 text-xs text-slate-500">{text.workspaceCodeHint}</p>
              </div>
            )}
            <div>
              <p className="mb-1.5 text-xs font-semibold text-slate-600">
                {text.modulesTitle}
              </p>
              <ul className="flex flex-wrap gap-2" data-testid="owner-modules">
                {enabledModules.map((m) => (
                  <li
                    key={m.key}
                    className="rounded-full bg-supporter-soft px-2.5 py-0.5 text-xs font-semibold text-emerald-800"
                  >
                    {moduleLabel(m.key)}
                    {!m.available && ` · ${text.moduleUnavailable}`}
                  </li>
                ))}
              </ul>
            </div>
            {!electionDayEnabled && (
              <p
                role="status"
                className="rounded-xl bg-potential-soft p-3 text-sm text-amber-900"
              >
                {text.electionDayDisabledNote}
              </p>
            )}
          </>
        )}
      </Card>

      <Card className="space-y-4" data-testid="owner-users-card">
        <div className="flex items-center gap-2">
          <Users className="size-5 text-slate-700" />
          <CardTitle>{text.usersTitle}</CardTitle>
        </div>
        <p className="text-sm text-slate-600">{text.usersSubtitle}</p>
        {userManagement.loadError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-opponent">
              {text.loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={userManagement.reload}>
              {text.retry}
            </Button>
          </div>
        ) : (
          <PermissionUsersPanel
            users={userManagement.users}
            roles={roleManagement.roles}
            onAdd={userManagement.createUser}
            onDelete={userManagement.deleteUser}
            onReset={userManagement.resetPassword}
            canManageUsers
            canResetPassword={(u) => !managerRoleIds.has(u.roleId)}
          />
        )}
        {userManagement.reauthDialog && (
          <AllocationPasswordDialog {...userManagement.reauthDialog} />
        )}
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-slate-700" />
          <CardTitle>{text.rolesTitle}</CardTitle>
        </div>
        <RoleManagementPanel
          roleManagement={roleManagement}
          permissionUsers={userManagement.users}
        />
      </Card>

      <ToastContainer />
    </div>
  );
}
