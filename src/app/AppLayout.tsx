import { useMemo } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import { Logo, LogoMark } from "../components/Logo";
import { ToastContainer } from "../components/ui/Toast";
import { ROLE_LABELS } from "../constants/labels";
import { NAV_ITEMS, ROUTES, type NavItem } from "../constants/routes";
import { useAuth } from "../features/auth/authStore";
import { useSyncActivistProfile } from "../features/auth/useSyncActivistProfile";
import { useElectionDaySession } from "../features/election-day/electionDaySession";
import { cn } from "../lib/utils";
import { usePermissions } from "../permissions/usePermissions";
import { APP_SHELL_TEXT } from "./appShell.constants";

function SidebarLink({
  to,
  label,
  icon: Icon,
  end,
  disabled,
}: NavItem & { disabled: boolean }) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-600 opacity-40"
      >
        <Icon className="size-4.5" />
        {label}
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-colors",
          isActive
            ? "bg-primary-600 text-white shadow-md shadow-primary-950/40"
            : "text-slate-400 hover:bg-sidebar-hover hover:text-white",
        )
      }
    >
      <Icon className="size-4.5" />
      {label}
    </NavLink>
  );
}

export function AppLayout() {
  const user = useAuth((s) => s.user);
  const signOut = useAuth((s) => s.signOut);
  const navigate = useNavigate();
  useSyncActivistProfile(user);

  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.managerOnly || user?.role === "manager"),
    [user?.role],
  );

  // An Election Day session whose effective role lacks full navigation
  // access (operations/voting) can only use the Election Day nav item -
  // every other main-app section (dashboard/voters/etc) is shown but
  // unclickable, since this session has no bearing on the rest of the app.
  //
  // The `electionDaySessionUser !== null` check is deliberate and required:
  // `usePermissions()` denies every permission (including
  // app.accessFullNavigation) when there is no Election Day session at
  // all, which is the ordinary state for anyone using the main app who has
  // never touched /election-day. Without this presence check, every such
  // user would see their main-app navigation wrongly locked down.
  const electionDaySessionUser = useElectionDaySession((s) => s.user);
  const { can } = usePermissions();
  const restrictedToElectionDay =
    electionDaySessionUser !== null && !can("app.accessFullNavigation");

  const doLogout = async () => {
    await signOut();
    void navigate(ROUTES.login, { replace: true });
  };

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar (start side = right in RTL) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar p-4 md:flex">
        <Logo light className="px-2 py-3" />
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {navItems.map((item) => (
            <SidebarLink
              key={item.to}
              {...item}
              disabled={restrictedToElectionDay && item.to !== ROUTES.electionDay}
            />
          ))}
        </nav>
        {user && (
          <div className="flex items-center gap-3 rounded-xl bg-sidebar-hover p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-600 text-sm font-bold text-white">
              {user.name.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-white">{user.name}</p>
              <p className="text-xs text-slate-400">
                {user.role ? ROLE_LABELS[user.role] : ""}
              </p>
            </div>
            <button
              onClick={() => void doLogout()}
              className="touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-700 hover:text-white"
              aria-label={APP_SHELL_TEXT.logout}
              title={APP_SHELL_TEXT.logout}
            >
              <LogOut className="size-4" />
            </button>
          </div>
        )}
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar */}
        <header className="sticky top-0 z-30 flex items-center justify-between bg-sidebar px-4 py-3 md:hidden">
          <LogoMark className="size-8" />
          <span className="text-lg font-extrabold text-white">
            קול<span className="text-primary-400">בוקס</span>
          </span>
          <button
            onClick={() => void doLogout()}
            className="touch-target grid place-items-center rounded-lg text-slate-400"
            aria-label={APP_SHELL_TEXT.logout}
          >
            <LogOut className="size-5" />
          </button>
        </header>

        <main className="flex-1 p-4 pb-24 md:p-8 md:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {navItems.map(({ to, label, icon: Icon, end }) => {
          if (restrictedToElectionDay && to !== ROUTES.electionDay) {
            return (
              <span
                key={to}
                aria-disabled="true"
                className="flex min-h-14 flex-1 cursor-not-allowed flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-slate-400 opacity-40"
              >
                <Icon className="size-5" />
                {label}
              </span>
            );
          }
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors",
                  isActive ? "text-primary-600" : "text-slate-400",
                )
              }
            >
              <Icon className="size-5" />
              {label}
            </NavLink>
          );
        })}
      </nav>

      <ToastContainer />
    </div>
  );
}
