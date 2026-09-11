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
  /** Phase 3C Roles Mutations: the Election Owner login bridge - a third,
   * independent identity from both the main app's Supabase Auth and the
   * PermissionUser session above (see `ownerSession.ts`'s own doc comment).
   * Deliberately NOT nested under `ROUTES.electionDay` in the router (its
   * guard, `OwnerAuthGuard`, is independent of `ElectionDayGuard`) even
   * though the path happens to share the `/election-day` prefix for
   * discoverability from `ElectionDayLoginScreen`. */
  electionDayOwnerLogin: "/election-day/owner-login",
  /** Stage 3B: where a newly approved Election Owner lands from their
   * one-time activation link to set their OWN password. Lives on the
   * ELECTION surface (not the Platform one) because that is the Owner's
   * home surface; api/platform/session.ts builds the link against this
   * exact path, and electionDayOwnerRecoveryUrl.ts scopes its capture to
   * it. Ungarded by design - the link itself is the proof. */
  electionDayOwnerSetPassword: "/election-day/owner-set-password",
  /** Stage 3B: first-run workspace provisioning for an approved Owner who
   * has no workspace yet. Reachable only while `provisioning.state` is
   * "pending"; a provisioned Owner is redirected away from it. */
  electionDayOwnerSetup: "/election-day/owner/setup",
  electionDayOwnerRoles: "/election-day/owner/roles",
  /** Platform Stage 2: the Platform Owner console - a FOURTH, fully
   * independent identity, separate from the campaign Supabase user
   * (`authStore.ts`), the Election Day PermissionUser session
   * (`electionDaySession.ts`), and the Election Owner (`ownerSession.ts`).
   * Deliberately OUTSIDE the `/election-day` prefix (unlike the Election
   * Owner routes above, which share that prefix purely for discoverability):
   * this surface is not part of Election Day at all, never renders its shell
   * or nav, and never touches voter data. Its guard,
   * `PlatformOwnerAuthGuard`, is a top-level sibling - never nested under
   * `AppLayout`/`AuthGuard`/`ElectionDayGuard`/`OwnerAuthGuard`. */
  platformLogin: "/platform/login",
  platformMfa: "/platform/mfa",
  platformConsole: "/platform",
  /** Platform Stage 4B: Multi-Entity Owner management. A child of
   * `PlatformOwnerAuthGuard` exactly like `platformConsole`, so it inherits
   * the same aal2 + platform_owners whitelist and needs no guard of its own.
   * Deliberately a real route rather than a tab inside the console: the
   * console's `Tabs` primitive is explicitly not a router and resets to its
   * first tab on every remount, which would drop the operator out of a
   * provision/cleanup workflow on any reload. No `platformCompatRedirects`
   * entry - that array exists only for four pre-cutover bookmarked paths on
   * the election origin, and this path has no legacy bookmarks. */
  platformMultiEntity: "/platform/multi-entity",
  /** Platform Stage 2 (password set/recovery): the landing page for a
   * Supabase recovery/invite link addressed to the Platform Owner account.
   * Deliberately a TOP-LEVEL SIBLING route, NOT nested under
   * `PlatformOwnerAuthGuard` - a recovery link only ever produces an `aal1`
   * session, which that guard would immediately divert into MFA
   * enrollment/challenge, making the password form unreachable. It is
   * likewise never nested under `AppLayout`/`AuthGuard`/`ElectionDayGuard`/
   * `OwnerAuthGuard` (see `platformLogin` above for why these four
   * identities stay structurally independent).
   *
   * This route grants NOTHING: it can only change the account's password and
   * then sends the owner back to `platformLogin`, where the normal
   * aal1 -> aal2 -> `GET /api/platform/session` chain still applies in full.
   *
   * The exact string is also the Supabase "redirect to" target an operator
   * configures when sending the link, and it is the ONLY pathname on which
   * `platformOwnerRecoveryUrl.ts` will consume auth tokens from the URL. */
  platformSetPassword: "/platform/set-password",
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
