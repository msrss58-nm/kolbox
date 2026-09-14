import { create } from "zustand";
import { BUDGET_NAV_ITEMS, BUDGET_ROUTES, type NavItem } from "../../constants/routes";
import { BudgetApiError, budgetCall, type BudgetSession } from "./budgetClient";

/**
 * Budget Stage 3: the Budget view of the CURRENT PermissionUser session
 * (`op: "session"` on the Budget endpoint). Navigation metadata only - it
 * decides which menu items and pages to render, never what the user may do:
 * every Budget request is re-authorized server-side (session, workspace,
 * effective entitlement, permission).
 */
export type BudgetSessionStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable" // workspace not (effectively) entitled to Budget
  | "forbidden" // signed in, but the role has no budget.view
  | "unauthenticated"
  | "error";

interface BudgetSessionState {
  status: BudgetSessionStatus;
  session: BudgetSession | null;
  load: () => Promise<BudgetSessionStatus>;
  reset: () => void;
}

export const useBudgetSession = create<BudgetSessionState>((set) => ({
  status: "idle",
  session: null,
  load: async () => {
    set({ status: "loading" });
    try {
      // "probe" answers 200 for a workspace without Budget or a role without
      // budget.view, so asking never produces an error response.
      const r = await budgetCall<{ session?: BudgetSession; unavailable?: string }>("probe");
      if (r?.session) {
        set({ status: "ready", session: r.session });
        return "ready";
      }
      const status: BudgetSessionStatus = r?.unavailable === "FORBIDDEN" ? "forbidden" : "unavailable";
      set({ status, session: null });
      return status;
    } catch (e) {
      const code = e instanceof BudgetApiError ? e.code : "";
      const status: BudgetSessionStatus =
        code === "MODULE_NOT_ENABLED"
          ? "unavailable"
          : code === "FORBIDDEN"
            ? "forbidden"
            : code === "UNAUTHORIZED"
              ? "unauthenticated"
              : "error";
      set({ status, session: null });
      return status;
    }
  },
  reset: () => set({ status: "idle", session: null }),
}));

/** True when the loaded session holds `permission`. Presentation only. */
export function budgetCan(session: BudgetSession | null, permission: string): boolean {
  return Boolean(session?.permissions.includes(permission));
}

/** The Budget module's menu items for a loaded session (Settings only for
 * budget.manageSettings). Shared by BudgetShell and ElectionDayShell so the
 * two never drift. Presentation only. */
export function budgetNavItemsFor(session: BudgetSession | null): NavItem[] {
  return BUDGET_NAV_ITEMS.filter(
    (item) => item.to !== BUDGET_ROUTES.settings || budgetCan(session, "budget.manageSettings"),
  );
}
