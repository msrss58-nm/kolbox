import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { Loader2, LogOut, Menu, X, type LucideIcon } from "lucide-react";
import { Logo } from "../Logo";
import { Button } from "../ui/Button";
import { ToastContainer } from "../ui/Toast";
import { cn } from "../../lib/utils";
import { ADMIN_SHELL_TEXT } from "./adminShell.constants";

export interface AdminNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface AdminShellAccount {
  /** Shown at the foot of the navigation (e.g. the signed-in email). */
  name: string;
  subtitle?: string;
  logoutLabel: string;
  onLogout: () => void;
  loggingOut?: boolean;
}

function AdminNavLinks({
  items,
  onNavigate,
}: {
  items: AdminNavItem[];
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <NavLink
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex min-h-11 items-center gap-3 rounded-xl px-3.5 text-sm font-semibold transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400",
                isActive
                  ? "bg-primary-600 text-white shadow-md shadow-primary-950/40"
                  : "text-slate-300 hover:bg-sidebar-hover hover:text-white",
              )
            }
          >
            <Icon className="size-4.5 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function AccountBlock({ account }: { account: AdminShellAccount }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-bold text-white" dir="auto">
        {account.name}
      </p>
      {account.subtitle && (
        <p className="truncate text-xs text-slate-400">{account.subtitle}</p>
      )}
    </div>
  );
}

/**
 * The shared administration shell for the Election Owner and the Platform
 * Owner - one layout, two independent identities (each caller supplies its own
 * title, navigation, account and logout; this component knows neither).
 *
 * Viewport model: the shell is exactly one viewport tall and never scrolls.
 * Navigation and header stay put; the routed section fills the rest and owns
 * the only scrolling region (see `AdminSection`).
 *
 * Navigation: a fixed side menu from `lg` (1024px) up; below that, a menu
 * button opens the same links in a start-edge drawer (Escape, the backdrop
 * and every link close it; focus moves into it and back to the button).
 *
 * UX only: hiding a link authorizes nothing - every section's data and
 * mutations stay authorized by the server.
 */
export function AdminShell({
  title,
  brandSubtitle,
  navItems,
  account,
  context,
  banner,
  children,
}: {
  /** The page heading (h1) - always visible, at every width. */
  title: string;
  /** Small label under the logo in the side menu. */
  brandSubtitle: string;
  navItems: AdminNavItem[];
  account: AdminShellAccount;
  /** Compact context line(s) under the title (e.g. workspace + code). */
  context?: ReactNode;
  /** Full-width notice under the header (e.g. a disabled-module warning). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  };

  useEffect(() => {
    if (!menuOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex h-dvh overflow-hidden bg-surface">
      {/* Fixed side menu (start side = right in RTL), desktop only. */}
      <aside className="hidden w-64 shrink-0 flex-col bg-sidebar p-4 lg:flex">
        <Logo light className="px-2 pt-1" />
        <p className="mt-2 px-2 text-xs font-semibold text-slate-400">{brandSubtitle}</p>
        <nav
          aria-label={ADMIN_SHELL_TEXT.navLabel}
          className="mt-6 min-h-0 flex-1 overflow-y-auto"
        >
          <AdminNavLinks items={navItems} />
        </nav>
        <div className="mt-4 space-y-3 rounded-xl bg-sidebar-hover p-3">
          <AccountBlock account={account} />
          {/* A plain button, not `Button`: `cn` is plain clsx (no Tailwind
              conflict merging), so a variant's text colour would win over a
              dark-background override and render the action dim. */}
          <button
            type="button"
            onClick={account.onLogout}
            disabled={account.loggingOut}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 disabled:opacity-60"
          >
            {account.loggingOut ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <LogOut className="size-4" aria-hidden />
            )}
            {account.logoutLabel}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-slate-200 bg-white">
          <div className="flex items-start gap-3 px-4 py-2.5 lg:px-6 lg:py-3">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label={ADMIN_SHELL_TEXT.openMenu}
              aria-expanded={menuOpen}
              aria-controls={drawerId}
              className="touch-target -ms-1 grid shrink-0 place-items-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-primary-500 lg:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </button>
            <div className="min-w-0 flex-1 self-center">
              <h1 className="truncate text-sm font-extrabold text-slate-800 lg:text-base">
                {title}
              </h1>
              {context && <div className="mt-1">{context}</div>}
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={account.loggingOut}
              onClick={account.onLogout}
              className="shrink-0 lg:hidden"
            >
              <LogOut className="size-4" aria-hidden />
              {account.logoutLabel}
            </Button>
          </div>
          {banner}
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-950/50 backdrop-blur-sm animate-fade-in"
            onClick={closeMenu}
            aria-hidden
          />
          <div
            ref={drawerRef}
            id={drawerId}
            role="dialog"
            aria-modal="true"
            aria-label={ADMIN_SHELL_TEXT.navLabel}
            className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-sidebar p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <Logo light className="px-2" />
              <button
                type="button"
                onClick={closeMenu}
                aria-label={ADMIN_SHELL_TEXT.closeMenu}
                className="touch-target grid place-items-center rounded-xl text-slate-400 hover:bg-sidebar-hover hover:text-white focus-visible:outline-2 focus-visible:outline-primary-400"
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <p className="mt-2 px-2 text-xs font-semibold text-slate-400">
              {brandSubtitle}
            </p>
            <nav
              aria-label={ADMIN_SHELL_TEXT.navLabel}
              className="mt-6 min-h-0 flex-1 overflow-y-auto"
            >
              <AdminNavLinks items={navItems} onNavigate={() => setMenuOpen(false)} />
            </nav>
            <div className="mt-4 rounded-xl bg-sidebar-hover p-3">
              <AccountBlock account={account} />
            </div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  );
}
