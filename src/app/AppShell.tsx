import { NavLink } from "react-router";
import { LogOut, type LucideIcon } from "lucide-react";
import { Logo, LogoMark } from "../components/Logo";
import { ToastContainer } from "../components/ui/Toast";
import { cn } from "../lib/utils";
import { APP_SHELL_TEXT } from "./appShell.constants";

export interface ShellNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** react-router `end` - true means "exact match only" (needed for an index route). */
  end?: boolean;
}

export interface ShellNavSection {
  label: string;
  items: ShellNavItem[];
}

/** The user/session footer block at the bottom of the desktop sidebar -
 * intentionally a full slot (not a fixed name/role shape) since the main app
 * (Supabase `profiles`) and Election Day (its own local session) have
 * unrelated identity models. */
export interface ShellFooter {
  name: string;
  subtitle: string;
  onLogout: () => void;
}

function SidebarLink({ to, label, icon: Icon, end }: ShellNavItem) {
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

/**
 * Generic shell chrome - desktop sidebar / mobile topbar + bottom nav -
 * shared by `AppLayout` (main app) and `ElectionDayShell` (Election Day's
 * own navigation). Each caller supplies its own nav items and footer/logout,
 * so this component carries no identity-model assumptions of its own.
 */
export function AppShell({
  navItems,
  sections,
  mobileNavItems,
  footer,
  children,
}: {
  navItems: ShellNavItem[];
  sections?: ShellNavSection[];
  mobileNavItems?: ShellNavItem[];
  footer?: ShellFooter;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar (start side = right in RTL) */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col bg-sidebar p-4 md:flex">
        <Logo light className="px-2 py-3" />
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {navItems.map((item) => (
            <SidebarLink key={item.to} {...item} />
          ))}
          {sections?.map((section) => (
            <div key={section.label} className="mt-4 flex flex-col gap-1">
              <p className="px-3.5 pt-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                {section.label}
              </p>
              {section.items.map((item) => (
                <SidebarLink key={item.to} {...item} />
              ))}
            </div>
          ))}
        </nav>
        {footer && (
          <div className="flex items-center gap-3 rounded-xl bg-sidebar-hover p-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary-600 text-sm font-bold text-white">
              {footer.name.slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-white">{footer.name}</p>
              <p className="text-xs text-slate-400">{footer.subtitle}</p>
            </div>
            <button
              onClick={footer.onLogout}
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
          {footer ? (
            <button
              onClick={footer.onLogout}
              className="touch-target grid place-items-center rounded-lg text-slate-400"
              aria-label={APP_SHELL_TEXT.logout}
            >
              <LogOut className="size-5" />
            </button>
          ) : (
            <span className="size-5" />
          )}
        </header>

        <main className="flex-1 p-4 pb-24 md:p-8 md:pb-8">{children}</main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex w-full border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {(mobileNavItems ?? navItems).map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] font-semibold transition-colors",
                isActive ? "text-primary-600" : "text-slate-400",
              )
            }
          >
            <Icon className="size-5 shrink-0" />
            <span className="w-full truncate text-center">{label}</span>
          </NavLink>
        ))}
      </nav>

      <ToastContainer />
    </div>
  );
}
