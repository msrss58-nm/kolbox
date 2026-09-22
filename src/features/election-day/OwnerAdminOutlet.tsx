import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";
import { LogoMark } from "../../components/Logo";
import { PackageX } from "lucide-react";
import { EmptyState } from "../../components/ui/EmptyState";
import { ROUTES } from "../../constants/routes";
import { isOwnerSessionRoleId } from "../../permissions/ownerSessionRole";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDaySession } from "./electionDaySession";
import type { OwnerAdminContext } from "./ownerAdminContext";
import { useOwnerRoleManagement } from "./useOwnerRoleManagement";
import { useOwnerUserManagement } from "./useOwnerUserManagement";
import { useOwnerWorkspaceSummary } from "./useOwnerWorkspaceSummary";
import { useOwnerSession } from "./ownerSession";

/**
 * The Owner administration sections now live INSIDE the full Election Day
 * shell, so this is a context provider and an authorization check - NOT a
 * shell. It renders no chrome and no navigation of its own: the sidebar,
 * header and account block all come from the one `AppShell` the shell
 * already renders, and the Owner's admin links are one more section in that
 * same sidebar.
 *
 * It replaces `OwnerAdminShell` as the parent of these routes. Each hook is
 * still called exactly ONCE for the whole admin area, so switching sections
 * never refetches and a section never shows data another has moved past -
 * the property the old shell's own doc comment described.
 *
 * Authorization is unchanged and still belongs to the server: every section's
 * data and mutations go through `owner-actions.ts`, which requires the Owner
 * JWT and re-resolves the Owner's workspace live. The check below only stops
 * a WORKER from rendering screens that could never load for them - it grants
 * nothing, and a worker who forced the URL would be refused by the server
 * regardless.
 */
export function OwnerAdminOutlet() {
  const sessionUser = useElectionDaySession((s) => s.user);
  const owner = useOwnerSession((s) => s.owner);
  const ownerBootstrapped = useOwnerSession((s) => s.bootstrapped);
  const bootstrapOwner = useOwnerSession((s) => s.bootstrap);
  // `OwnerAuthGuard` used to do this before rendering the old admin shell.
  // The sections' own hooks read `useOwnerSession.owner` (the workspace
  // summary short-circuits without it), so the LIVE bootstrap has to happen
  // here now that the guard is no longer in this tree.
  useEffect(() => {
    void bootstrapOwner();
    // Runs once per mount - `bootstrap` is a stable store action reference,
    // matching OwnerAuthGuard's own one-shot pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const roleManagement = useOwnerRoleManagement();
  const userManagement = useOwnerUserManagement();
  const workspace = useOwnerWorkspaceSummary();

  // Only the Election Owner administers a workspace (Platform Stage 9) -
  // workers, Managers included, have no user-management screen at all.
  if (!isOwnerSessionRoleId(sessionUser?.roleId ?? null)) {
    if (!sessionUser) return <Navigate to={ROUTES.electionDayLogin} replace />;
    return (
      <div className="grid min-h-[60vh] place-items-center p-6">
        <EmptyState
          icon={PackageX}
          title={ELECTION_DAY_TEXT.owner.admin.ownerOnlyTitle}
          hint={ELECTION_DAY_TEXT.owner.admin.ownerOnlyHint}
        />
      </div>
    );
  }

  if (!ownerBootstrapped) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }

  const context: OwnerAdminContext = {
    roleManagement,
    userManagement,
    workspace,
    ownerEmail: owner?.email ?? null,
  };

  return (
    <>
      <Outlet context={context} />
      {/* The Owner step-up prompt for user management - after the outlet so
          it stacks above a section's own dialog (e.g. "add user"). */}
      {userManagement.reauthDialog && (
        <AllocationPasswordDialog {...userManagement.reauthDialog} />
      )}
    </>
  );
}
