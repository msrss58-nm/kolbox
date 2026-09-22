import { useEffect, useRef } from "react";
import { Blocks, Building2, Network, ScrollText, Settings, UserCog } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { AdminShell, type AdminNavItem } from "../../components/admin/AdminShell";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import type { PlatformAdminContext } from "./platformAdminContext";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import { useOwnerAccess } from "./useOwnerAccess";
import { useWorkspaceModules } from "./useWorkspaceModules";

const text = PLATFORM_OWNER_TEXT.console;
const nav = PLATFORM_OWNER_TEXT.shell.nav;

const NAV_ITEMS: AdminNavItem[] = [
  { to: ROUTES.platformOwners, label: nav.owners, icon: UserCog },
  { to: ROUTES.platformWorkspaces, label: nav.workspaces, icon: Building2 },
  { to: ROUTES.platformModules, label: nav.modules, icon: Blocks },
  { to: ROUTES.platformMultiEntity, label: nav.multiEntity, icon: Network },
  { to: ROUTES.platformAudit, label: nav.audit, icon: ScrollText },
  { to: ROUTES.platformSettings, label: nav.settings, icon: Settings },
];

/**
 * The Platform Owner console - `/platform/*`. Reachable ONLY through
 * `PlatformOwnerAuthGuard`'s single "authorized" branch (aal2 + the server's
 * own 200); every section is a child route of this shell, so none can render
 * before that. The navigation is presentation only - each read and mutation is
 * authorized by the server on its own.
 *
 * Standalone - never nested under `AppLayout` / `ElectionDayShell` - and it
 * never imports Election Day data: no voter PII may reach this surface.
 */
export function PlatformAdminShell() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);
  const navigate = useNavigate();
  const access = useOwnerAccess();
  const workspaceModules = useWorkspaceModules();

  // Every section is a SIBLING child route of this shell, so navigating
  // between them remounts nothing: `useOwnerAccess` and `useWorkspaceModules`
  // are mounted once, here, and without this they keep serving whatever they
  // read when the console was first opened. That is the "I had to press F5"
  // report - an approval made in one section, or a workspace that came into
  // existence when an Owner activated their link, was simply not in the copy
  // the next section rendered.
  //
  // Re-reading on entering a section is the smallest thing that makes the
  // console correct for BOTH causes, including the one no dialog can call
  // back from (the Owner activating their link elsewhere, minutes later).
  // The first render is skipped: each hook already loads on mount, and a
  // second immediate read would be pure duplication.
  const { pathname } = useLocation();
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    void access.reload();
    void workspaceModules.reload();
    // Intentionally keyed on the path alone: the reload callbacks are stable
    // per hook instance, and including them would re-run this on every state
    // change the reads themselves cause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const handleLogout = async () => {
    await logout();
    void navigate(ROUTES.platformLogin, { replace: true });
  };

  const context: PlatformAdminContext = { access, workspaceModules };

  return (
    <AdminShell
      title={text.title}
      navItems={NAV_ITEMS}
      account={{
        name: owner?.email ?? "",
        subtitle: text.mfaValue,
        logoutLabel: text.logout,
        onLogout: () => void handleLogout(),
        loggingOut,
      }}
      context={
        owner && (
          <p className="text-xs break-all text-slate-500">
            {text.signedInAs(owner.email)}
          </p>
        )
      }
    >
      <Outlet context={context} />
    </AdminShell>
  );
}
