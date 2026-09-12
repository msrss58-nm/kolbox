import { Blocks, Settings, ShieldCheck, Users } from "lucide-react";
import { Outlet, useNavigate } from "react-router";
import { AdminShell, type AdminNavItem } from "../../components/admin/AdminShell";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { ROUTES } from "../../constants/routes";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { OwnerAdminContext } from "./ownerAdminContext";
import { useOwnerRoleManagement } from "./useOwnerRoleManagement";
import { useOwnerSession } from "./ownerSession";
import { useOwnerUserManagement } from "./useOwnerUserManagement";
import { useOwnerWorkspaceSummary } from "./useOwnerWorkspaceSummary";

const text = ELECTION_DAY_TEXT.owner.rolesPage;
const adminText = ELECTION_DAY_TEXT.owner.admin;

const NAV_ITEMS: AdminNavItem[] = [
  { to: ROUTES.electionDayOwnerUsers, label: adminText.nav.users, icon: Users },
  { to: ROUTES.electionDayOwnerRoles, label: adminText.nav.roles, icon: ShieldCheck },
  { to: ROUTES.electionDayOwnerModules, label: adminText.nav.modules, icon: Blocks },
  { to: ROUTES.electionDayOwnerSettings, label: adminText.nav.settings, icon: Settings },
];

/**
 * The Election Owner administration area - `/election-day/owner/*`, behind
 * `OwnerAuthGuard`. Sections: Users, Roles & Permissions, Modules, Settings
 * (each a real child route, so reload / direct links keep the section).
 *
 * The Owner is the workspace administrator (Platform Stage 9): user and role
 * management are Owner authority, enforced server-side on every request; the
 * navigation here is presentation only. A workspace with zero users is a
 * normal state - this is where the Owner lands after provisioning and after
 * every sign-in, and nothing here requires a user to exist first.
 */
export function OwnerAdminShell() {
  const owner = useOwnerSession((s) => s.owner);
  const logout = useOwnerSession((s) => s.logout);
  const navigate = useNavigate();
  const roleManagement = useOwnerRoleManagement();
  const userManagement = useOwnerUserManagement();
  const workspace = useOwnerWorkspaceSummary();
  const { summary, error: summaryError, reload: reloadSummary } = workspace;

  const { run: runLogout, busy: loggingOut } = useAsyncAction(async () => {
    await logout();
  });

  const handleLogout = async () => {
    await runLogout();
    void navigate(ROUTES.electionDayOwnerLogin, { replace: true });
  };

  const enabledModules = (summary?.modules ?? []).filter((m) => m.enabled);
  const electionDayEnabled = enabledModules.some((m) => m.key === "election_day");

  const context: OwnerAdminContext = {
    roleManagement,
    userManagement,
    workspace,
    ownerEmail: owner?.email ?? null,
  };

  const workspaceLine = summaryError ? (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-xs text-opponent">
        {text.loadError}
      </p>
      <Button variant="ghost" size="sm" onClick={reloadSummary} className="h-7 px-2">
        {text.retry}
      </Button>
    </div>
  ) : !summary ? (
    <Skeleton className="h-4 w-56" />
  ) : (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="owner-workspace-card"
    >
      <span className="text-sm font-bold text-slate-700" dir="auto">
        {summary.workspaceName ?? text.workspaceTitle}
      </span>
      {summary.loginCode && (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
          {text.workspaceCodeLabel}
          <span
            dir="ltr"
            className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-bold tracking-widest text-slate-900"
            data-testid="owner-workspace-code"
          >
            {summary.loginCode}
          </span>
        </span>
      )}
      <ul className="flex flex-wrap gap-1" data-testid="owner-modules">
        {enabledModules.map((m) => (
          <li
            key={m.key}
            className="rounded-full bg-supporter-soft px-2 py-0.5 text-xs font-semibold text-emerald-800"
          >
            {moduleLabel(m.key)}
            {!m.available && ` · ${text.moduleUnavailable}`}
          </li>
        ))}
      </ul>
    </div>
  );

  const banner =
    summary && !electionDayEnabled ? (
      <p
        role="status"
        className="border-t border-amber-200 bg-potential-soft px-4 py-2 text-sm text-amber-900 lg:px-6"
      >
        {text.electionDayDisabledNote}
      </p>
    ) : undefined;

  return (
    <AdminShell
      title={text.title}
      brandSubtitle={adminText.brandSubtitle}
      navItems={NAV_ITEMS}
      account={{
        name: owner?.email ?? "",
        subtitle: adminText.accountRole,
        logoutLabel: text.logout,
        onLogout: () => void handleLogout(),
        loggingOut,
      }}
      context={workspaceLine}
      banner={banner}
    >
      <Outlet context={context} />
      {/* The Owner step-up prompt for user management - after the outlet so
          it stacks above a section's own dialog (e.g. "add user"). */}
      {userManagement.reauthDialog && (
        <AllocationPasswordDialog {...userManagement.reauthDialog} />
      )}
    </AdminShell>
  );
}
