import { useMemo } from "react";
import { Link, Outlet, useNavigate } from "react-router";
import { ArrowLeftRight } from "lucide-react";
import { AppShell, type ShellNavSection } from "../../app/AppShell";
import { toast } from "../../components/ui/Toast";
import { COMMON_TEXT } from "../../constants/common-text";
import {
  BUDGET_NAV_SECTION_LABEL,
  ELECTION_DAY_NAV_SECTION_LABEL,
  NAV_ITEMS,
  ROUTES,
} from "../../constants/routes";
import { usePermissions } from "../../permissions/usePermissions";
import { useAuth } from "../auth/authStore";
import { getVisibleElectionDayNavItems } from "../election-day/electionDayNavVisibility";
import { useElectionDaySession } from "../election-day/electionDaySession";
import { BUDGET_TEXT } from "./budget.constants";
import { budgetNavItemsFor, useBudgetSession } from "./budgetSession";

/**
 * The Budget module's shell: the SAME AppShell chrome as Election Day (blue
 * RTL sidebar, mobile top bar + bottom nav), with the Election Day section
 * (only when the workspace is entitled to it) and the "ניהול תקציב" section
 * directly below it. It never loads Election Day voter data.
 */
export function BudgetShell() {
  const navigate = useNavigate();
  const session = useBudgetSession((s) => s.session);
  const resetBudget = useBudgetSession((s) => s.reset);
  const logoutAction = useElectionDaySession((s) => s.logout);
  const { can } = usePermissions();
  const supabaseUser = useAuth((s) => s.user);

  const hasElectionDay = Boolean(session?.modules.includes("election_day"));
  const budgetItems = useMemo(() => budgetNavItemsFor(session), [session]);

  const mainNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.managerOnly || supabaseUser?.role === "manager"),
    [supabaseUser?.role],
  );

  const sections = useMemo(() => {
    const out: ShellNavSection[] = [];
    if (hasElectionDay) {
      out.push({ label: ELECTION_DAY_NAV_SECTION_LABEL, items: getVisibleElectionDayNavItems(can) });
    }
    out.push({ label: BUDGET_NAV_SECTION_LABEL, items: budgetItems });
    return out;
  }, [hasElectionDay, can, budgetItems]);

  const logout = async () => {
    try {
      await logoutAction();
      resetBudget();
      navigate(ROUTES.electionDayLogin, { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : COMMON_TEXT.genericError);
    }
  };

  return (
    <AppShell
      navItems={mainNavItems}
      sections={sections}
      mobileNavItems={budgetItems}
      footer={
        session
          ? { name: session.actorName, subtitle: BUDGET_TEXT.moduleTitle, onLogout: () => void logout() }
          : undefined
      }
    >
      <div className="mx-auto max-w-[1400px]">
        {hasElectionDay && (
          <div className="mb-3 flex justify-end md:hidden">
            <Link
              to={ROUTES.electionDay}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary-700 ring-1 ring-slate-200"
            >
              <ArrowLeftRight className="size-4" />
              {BUDGET_TEXT.nav.switchToElectionDay}
            </Link>
          </div>
        )}
        <Outlet />
      </div>
    </AppShell>
  );
}
