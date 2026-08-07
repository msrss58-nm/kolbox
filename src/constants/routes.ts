import {
  Car,
  ClipboardList,
  FileBarChart2,
  Folder,
  KeyRound,
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
  electionDay: "/election-day",
  electionDayLogin: "/election-day/login",
} as const;

/** Election Day's own sub-navigation (UX v3 - "shell" architecture, see
 * `ElectionDayShell.tsx`) - all relative to `ROUTES.electionDay`. Election
 * Day has its own independent identity/nav, not the main app's `NAV_ITEMS`
 * (see `ElectionDayShell.tsx` and CLAUDE.md's "Election Day's own local
 * login" section) - kept as a separate map rather than folded into `ROUTES`
 * to keep that flat map's shape (one level of paths) unchanged. */
export const ELECTION_DAY_ROUTES = {
  dashboard: `${ROUTES.electionDay}/dashboard`,
  voters: `${ROUTES.electionDay}/voters`,
  files: `${ROUTES.electionDay}/files`,
  permissions: `${ROUTES.electionDay}/permissions`,
  rides: `${ROUTES.electionDay}/rides`,
  reasons: `${ROUTES.electionDay}/reasons`,
  reports: `${ROUTES.electionDay}/reports`,
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

/** Primary navigation - drives both the desktop sidebar and the mobile bottom
 * nav. Election Day is no longer a single entry here (UX v3.1) - it's
 * rendered as its own labeled section (see `ELECTION_DAY_NAV_SECTION_LABEL`
 * + `getVisibleElectionDayNavItems`), shown alongside this list rather than
 * replacing it. */
export const NAV_ITEMS: NavItem[] = [
  { to: ROUTES.dashboard, label: "דשבורד", icon: LayoutDashboard, end: true },
  { to: ROUTES.voters, label: "בוחרים", icon: Users },
  { to: ROUTES.activists, label: "פעילים", icon: Megaphone },
  { to: ROUTES.import, label: "טעינת נתונים", icon: Upload },
  { to: ROUTES.team, label: "צוות", icon: ShieldCheck, managerOnly: true },
];

/** Section label for Election Day's nav items wherever they're rendered as a
 * labeled group (UX v3.1 - both `AppLayout`'s main sidebar and
 * `ElectionDayShell`'s own sidebar use this same section, see
 * `getVisibleElectionDayNavItems`). */
export const ELECTION_DAY_NAV_SECTION_LABEL = "יום הבחירות";

/** Election Day's own nav items - drives `ElectionDayShell`'s section AND
 * (UX v3.1) the matching section inside the main app sidebar. Every item is
 * always LISTED here - `getVisibleElectionDayNavItems` filters by the
 * signed-in session's actual permissions, mirroring how `ElectionDayNav.tsx`'s
 * accordion categories used to hide themselves per-role (that component is
 * retired by this same change). */
export const ELECTION_DAY_NAV_ITEMS: NavItem[] = [
  { to: ELECTION_DAY_ROUTES.dashboard, label: "דשבורד", icon: LayoutDashboard },
  { to: ELECTION_DAY_ROUTES.voters, label: "בוחרים", icon: Users },
  { to: ELECTION_DAY_ROUTES.files, label: "ניהול קבצים", icon: Folder },
  { to: ELECTION_DAY_ROUTES.permissions, label: "הרשאות ומשתמשים", icon: KeyRound },
  { to: ELECTION_DAY_ROUTES.rides, label: "ניהול הסעות", icon: Car },
  { to: ELECTION_DAY_ROUTES.reasons, label: "סיבות אי-הצבעה", icon: ClipboardList },
  { to: ELECTION_DAY_ROUTES.reports, label: "דוחות", icon: FileBarChart2 },
];
