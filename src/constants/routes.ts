import {
  LayoutDashboard,
  Megaphone,
  ShieldCheck,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

/** Central route paths - never hardcode a path string outside this file. */
export const ROUTES = {
  login: "/login",
  dashboard: "/",
  voters: "/voters",
  activists: "/activists",
  import: "/import",
  team: "/team",
} as const;

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** react-router `end` - true means "exact match only" (needed for the "/" root route). */
  end?: boolean;
  /** Only shown to signed-in managers. */
  managerOnly?: boolean;
}

/** Primary navigation - drives both the desktop sidebar and the mobile bottom nav. */
export const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.dashboard, label: "דשבורד", icon: LayoutDashboard, end: true },
  { to: ROUTES.voters, label: "בוחרים", icon: Users },
  { to: ROUTES.activists, label: "פעילים", icon: Megaphone },
  { to: ROUTES.import, label: "טעינת נתונים", icon: Upload },
  { to: ROUTES.team, label: "צוות", icon: ShieldCheck, managerOnly: true },
];
