// SIDE-EFFECT IMPORT, DELIBERATELY FIRST - do not reorder or let a formatter
// sort it below the imports beneath it. `platformOwnerRecoveryUrl` captures
// and strips the Supabase recovery tokens that land on
// `/platform/set-password` at MODULE-EVALUATION time. Every Supabase client in
// this app auto-initializes in its constructor with `detectSessionInUrl` on,
// so whichever client module is evaluated first would otherwise consume those
// tokens into ITS OWN storage key (silently replacing, say, the campaign
// user's session) and would clear the fragment with `location.hash = ''`,
// which pushes a history entry and leaves the access token in the previous
// one. Evaluating this module before any feature import - and before
// `createBrowserRouter` reads `window.location` at the bottom of this file -
// makes the outcome deterministic and strips the token with `replaceState`.
// See that file's own doc comment for the full rationale.
//
// Kept on BOTH surfaces (see APP_SURFACE below) on purpose: on the election
// surface `/platform/set-password` no longer resolves to a route, but a link
// that still lands there must have its one-time token stripped from the
// address bar rather than left sitting in it.
import "../features/platform-owner/platformOwnerRecoveryUrl";
// SIDE-EFFECT IMPORT, DELIBERATELY SECOND AND STILL BEFORE EVERY FEATURE
// IMPORT - the Stage 3B Election Owner equivalent of the module above, for
// `/election-day/owner-set-password`. Same hazard, same ordering requirement:
// the campaign client AND the Election Owner client are both live on this
// surface, so activation-link material must be captured and stripped
// deterministically rather than left for whichever client the bundler
// evaluates first. The two modules are pathname-scoped to different routes
// and cannot capture each other's links.
import "../features/election-day/electionDayOwnerRecoveryUrl";
// Platform Stage 5 - the Multi-Entity Owner equivalent, for
// `/multi-entity/set-password`. Pathname-scoped like the two above. Its only
// job is token hygiene (strip with replaceState before render): the Multi-
// Entity client has `detectSessionInUrl: false` and the `token_hash` query
// shape is never auto-consumed, so there is no client race to win here.
import "../features/multi-entity-owner/multiEntityOwnerRecoveryUrl";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { ROUTES } from "../constants/routes";
import { ActivistsPage } from "../features/activists/ActivistsPage";
import { BudgetDashboardPage } from "../features/budget/BudgetDashboardPage";
import { BudgetExpensePage } from "../features/budget/BudgetExpensePage";
import { BudgetExpensesPage } from "../features/budget/BudgetExpensesPage";
import { BudgetGuard } from "../features/budget/BudgetGuard";
import { BudgetPlanningPage } from "../features/budget/BudgetPlanningPage";
import { BudgetReportsPage } from "../features/budget/BudgetReportsPage";
import { BudgetSettingsPage } from "../features/budget/BudgetSettingsPage";
import { BudgetShell } from "../features/budget/BudgetShell";
import { BudgetSuppliersPage } from "../features/budget/BudgetSuppliersPage";
import { OwnerBudgetSettingsSection } from "../features/budget/OwnerBudgetSettingsSection";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ElectionDayDashboardPage } from "../features/election-day/ElectionDayDashboardPage";
import { ElectionDayFilesPage } from "../features/election-day/ElectionDayFilesPage";
import {
  ElectionDayGuard,
  ElectionDayIndexRedirect,
  ElectionDayModuleGate,
} from "../features/election-day/ElectionDayGuard";
import { ElectionDayLoginScreen } from "../features/election-day/ElectionDayLoginScreen";
import { ElectionDayReasonsPage } from "../features/election-day/ElectionDayReasonsPage";
import { ElectionDayReportsPage } from "../features/election-day/ElectionDayReportsPage";
import { ElectionDayRidesPage } from "../features/election-day/ElectionDayRidesPage";
import { ElectionDayShell } from "../features/election-day/ElectionDayShell";
import { ElectionDayVotersPage } from "../features/election-day/ElectionDayVotersPage";
import { OwnerAdminOutlet } from "../features/election-day/OwnerAdminOutlet";
import {
  OwnerModulesSection,
  OwnerRolesSection,
  OwnerSettingsSection,
  OwnerUsersSection,
} from "../features/election-day/OwnerAdminSections";
import { OwnerLoginScreen } from "../features/election-day/OwnerLoginScreen";
import { OwnerSetPasswordScreen } from "../features/election-day/OwnerSetPasswordScreen";
import { OwnerSetupPage } from "../features/election-day/OwnerSetupPage";
import { ImportPage } from "../features/import/ImportPage";
import { MultiEntityOwnerAuthGuard } from "../features/multi-entity-owner/MultiEntityOwnerAuthGuard";
import { MultiEntityOwnerHomePage } from "../features/multi-entity-owner/MultiEntityOwnerHomePage";
import { MultiEntityOwnerLoginScreen } from "../features/multi-entity-owner/MultiEntityOwnerLoginScreen";
import { MultiEntityOwnerSetPasswordScreen } from "../features/multi-entity-owner/MultiEntityOwnerSetPasswordScreen";
import { MultiEntityOwnerWorkspacePage } from "../features/multi-entity-owner/MultiEntityOwnerWorkspacePage";
import { PlatformAdminShell } from "../features/platform-owner/PlatformAdminShell";
import {
  PlatformAuditSection,
  PlatformModulesSection,
  PlatformOwnersSection,
  PlatformSettingsSection,
  PlatformWorkspacesSection,
} from "../features/platform-owner/PlatformAdminSections";
import { PlatformOwnerAuthGuard } from "../features/platform-owner/PlatformOwnerAuthGuard";
import { PlatformOwnerLoginScreen } from "../features/platform-owner/PlatformOwnerLoginScreen";
import { PlatformOwnerMultiEntityPage } from "../features/platform-owner/PlatformOwnerMultiEntityPage";
import { PlatformOwnerSetPasswordScreen } from "../features/platform-owner/PlatformOwnerSetPasswordScreen";
import { VotersPage } from "../features/voters/VotersPage";
import { AuthCompleteScreen } from "../features/auth-entry/AuthCompleteScreen";
import { AuthContinueScreen } from "../features/auth-entry/AuthContinueScreen";
import { AuthLoginScreen } from "../features/auth-entry/AuthLoginScreen";
import { multiEntityOwnerAuthClient } from "../services/supabase/multiEntityOwnerAuthClient";
import { ownerAuthClient } from "../services/supabase/ownerAuthClient";
import { platformOwnerAuthClient } from "../services/supabase/platformOwnerAuthClient";
import { AppLayout } from "./AppLayout";
import { EntryScreen } from "./EntryScreen";
import { PlatformOriginRedirect } from "./PlatformOriginRedirect";
import { VoterManagementGuard } from "./VoterManagementGuard";

/**
 * Establishes an aal1 session in ONE realm's isolated client, from the
 * one-time token the target origin minted during leg 2. Each surface passes
 * its OWN client, because a session must live in the storage of the origin
 * and client that will use it. MFA is untouched: the realm's existing guard
 * takes over immediately afterwards and runs the existing enrol/challenge
 * flow unchanged.
 */
interface OtpClient {
  auth: {
    verifyOtp: (p: {
      token_hash: string;
      type: "magiclink";
    }) => Promise<{ error: unknown }>;
  };
}
const verifyOtpWith = (client: OtpClient) => async (tokenHash: string) => {
  const { error } = await client.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  return !error;
};

/**
 * ORIGIN SEPARATION - build-time surface selector.
 *
 * The Platform Owner console and the Election Day / campaign application are
 * served from two DIFFERENT browser origins. That split exists for one
 * concrete reason: Chrome scopes saved credentials by origin (`signon_realm`),
 * so while a Platform Owner login form and an Election Day login form share an
 * origin, the Platform Owner's saved credential is a fill candidate on the
 * Election Day form. No in-page attribute can prevent that - it is deliberate
 * browser behaviour - so the fix has to be structural.
 *
 * `VITE_APP_SURFACE` is a Vite env var, so it is substituted at BUILD time and
 * the ternary at the bottom of this file is constant-folded: each deployment
 * ships only its own routes, and the other principal's login screen is not
 * merely hidden but absent from the route table entirely.
 *
 * Defaults to "election" when unset or unrecognised, which keeps the existing
 * production build behaviourally unchanged: a deployment that never sets this
 * variable routes exactly as it did before origin separation.
 *
 * FOUR VALUES:
 *   "election"     - Election Day / Election Owner / campaign only (default).
 *   "platform"     - Platform Owner only.
 *   "both"         - election + platform routes, for the EXPAND window only.
 *   "multi_entity" - Multi-Entity Owner only (Platform Stage 5), on its own
 *                    origin. Never part of "both": it is a new surface with no
 *                    legacy paths to keep alive, and sharing an origin with
 *                    any other principal's login form is exactly what origin
 *                    separation exists to prevent.
 *
 * "both" exists because origin separation has to roll out additively. While
 * the new platform origin is being introduced, the OLD origin must keep
 * serving the Platform Owner flow it serves today - cutting it over in the
 * same step would take the console offline for the duration. With "both", the
 * main project runs every route during EXPAND and cutover is later performed
 * by flipping this one variable to "election", which means the cutover needs
 * no code deploy and can be rolled back the same way.
 *
 * EXCLUDED-ROUTE BEHAVIOUR: routes belonging to the other surface are not
 * registered, so they resolve through react-router's ordinary no-match path -
 * identical to how any unknown URL already behaves on that origin. Still
 * deliberately NOT a catch-all redirect: adding one would change how the
 * election surface already treats unknown URLs, and the only property that
 * actually matters here is that the other principal's login form can never
 * render on this origin.
 *
 * The one exception is `platformCompatRedirects` below - four NAMED paths on
 * the election surface only, added at cutover so existing Platform Owner
 * bookmarks reach the new origin instead of a no-match page. They render no
 * credential field and are not a catch-all.
 */
type AppSurface = "election" | "platform" | "both" | "multi_entity" | "auth";

const APP_SURFACE: AppSurface =
  import.meta.env.VITE_APP_SURFACE === "platform"
    ? "platform"
    : import.meta.env.VITE_APP_SURFACE === "both"
      ? "both"
      : import.meta.env.VITE_APP_SURFACE === "multi_entity"
        ? "multi_entity"
        : import.meta.env.VITE_APP_SURFACE === "auth"
          ? "auth"
          : "election";

/**
 * The KOLBOX Auth / IdP surface - the dedicated origin that owns every
 * credential form. It carries no application screen: origin separation is
 * what keeps one principal's saved credential from being a fill candidate on
 * another principal's form.
 *
 * TWO LOGIN ROUTES, and there are only two: `/login`, the shared screen every
 * principal except the Platform Owner uses, and `/login/platform-owner`.
 *
 * NOTHING ABOUT THE PRINCIPAL COMES FROM THE CLIENT on the shared screen -
 * not from a selector, not from a workspace, not from a system code, and no
 * longer from the route either. The server resolves the principal from the
 * username directory and decides both the target origin and the landing
 * path. A user does not need to know what kind of user they are.
 *
 * The three retired realm-specific paths still resolve, as redirects to the
 * shared screen, so links already sent to Owners keep working. They render no
 * credential field of their own - there is exactly one shared form.
 *
 * Both screens render the SAME component (AuthLoginScreen), so the approved
 * KOLBOX visual design is identical by construction rather than by
 * convention; only the title differs.
 *
 * `/auth/continue` never reads a code from the URL (see AuthContinueScreen) -
 * that absence is a login-CSRF control, not hygiene.
 */
const authSurfaceRoutes: RouteObject[] = [
  { path: ROUTES.login, element: <AuthLoginScreen realmKey="shared" /> },
  {
    path: ROUTES.authLoginPlatformOwner,
    element: <AuthLoginScreen realmKey="platformOwner" />,
  },
  // Retired realm-specific entry points - kept only so existing links resolve.
  { path: "/login/users", element: <Navigate to={ROUTES.login} replace /> },
  { path: "/login/election-owner", element: <Navigate to={ROUTES.login} replace /> },
  { path: "/login/multi-entity-owner", element: <Navigate to={ROUTES.login} replace /> },
  { path: ROUTES.authContinue, element: <AuthContinueScreen /> },
  { path: "/", element: <Navigate to={ROUTES.login} replace /> },
  { path: "*", element: <Navigate to={ROUTES.login} replace /> },
];

/**
 * Platform Stage 5 - Multi-Entity Owner surface (its own origin). Same shape
 * as the Platform Owner surface: login and set-password are top-level
 * siblings (set-password must NOT sit under the guard, which would divert the
 * aal1 recovery session into MFA); everything else is under
 * MultiEntityOwnerAuthGuard, which renders MFA inline at aal1 and only reaches
 * a child after the server's own 200.
 *
 * "/" and every unmatched path redirect to the guarded home. On this surface
 * that is safe: it is a brand-new origin with no pre-existing URL behaviour to
 * preserve, and the only credential form reachable here is this principal's
 * own. (The Election surface's raw no-match page is deliberately untouched.)
 */
const multiEntityOwnerRoutes: RouteObject[] = [
  { path: ROUTES.multiEntityLogin, element: <MultiEntityOwnerLoginScreen /> },
  { path: ROUTES.multiEntitySetPassword, element: <MultiEntityOwnerSetPasswordScreen /> },
  // Leg 2 on the multi-entity origin - same shape, same MFA hand-off.
  {
    path: ROUTES.authComplete,
    element: <AuthCompleteScreen verifyOtp={verifyOtpWith(multiEntityOwnerAuthClient)} />,
  },
  {
    element: <MultiEntityOwnerAuthGuard />,
    children: [
      { path: ROUTES.multiEntityHome, element: <MultiEntityOwnerHomePage /> },
      // Platform Stage 7: one workspace's aggregates. Same guard - nothing here
      // renders before the server's own 200; the id is authorized server-side.
      { path: ROUTES.multiEntityWorkspace, element: <MultiEntityOwnerWorkspacePage /> },
    ],
  },
  { path: "/", element: <Navigate to={ROUTES.multiEntityHome} replace /> },
  { path: "*", element: <Navigate to={ROUTES.multiEntityHome} replace /> },
];

/** Platform Owner surface - the FOURTH identity, served from its own origin. */
const platformOwnerRoutes: RouteObject[] = [
  { path: ROUTES.platformLogin, element: <PlatformOwnerLoginScreen /> },
  // Leg 2 on the platform origin. Deliberately OUTSIDE PlatformOwnerAuthGuard:
  // it runs before any session exists, and hands over to that guard - which
  // then forces MFA exactly as it does for a password sign-in.
  {
    path: ROUTES.authComplete,
    element: <AuthCompleteScreen verifyOtp={verifyOtpWith(platformOwnerAuthClient)} />,
  },
  {
    // Platform Stage 2 (password set/recovery): the recovery/invite landing
    // page. A TOP-LEVEL SIBLING route - deliberately NOT nested under
    // PlatformOwnerAuthGuard, which would divert the `aal1` session a
    // recovery link produces straight into MFA enrollment and make the
    // password form unreachable. It authorizes nothing: it can only change
    // the account password and then hand the owner back to /platform/login,
    // where the full aal1 -> aal2 -> server-200 chain still applies (see
    // PlatformOwnerSetPasswordScreen.tsx's security model).
    path: ROUTES.platformSetPassword,
    element: <PlatformOwnerSetPasswordScreen />,
  },
  {
    // Platform Stage 2: the Platform Owner console, with its own top-level
    // guard. It renders no Election Day shell/nav and touches no voter data.
    //
    // PlatformOwnerAuthGuard renders the MFA enrollment/challenge screens
    // INLINE whenever the platform session is still at aal1, so neither child
    // below can render before MFA completes AND the server's own
    // `GET /api/platform/session` returns 200. `platformMfa` therefore only
    // ever resolves once MFA is already done - at which point the correct
    // destination is the console itself.
    element: <PlatformOwnerAuthGuard />,
    children: [
      {
        // The console shell: fixed side navigation, one child route per
        // section (relative paths below == ROUTES.platform* constants). Same
        // guard, same aal2 whitelist - no section is reachable before the
        // server's own 200. `multi-entity` keeps its Stage 4B path.
        path: ROUTES.platformConsole,
        element: <PlatformAdminShell />,
        children: [
          { index: true, element: <Navigate to="owners" replace /> },
          { path: "owners", element: <PlatformOwnersSection /> },
          { path: "workspaces", element: <PlatformWorkspacesSection /> },
          { path: "modules", element: <PlatformModulesSection /> },
          { path: "multi-entity", element: <PlatformOwnerMultiEntityPage /> },
          { path: "audit", element: <PlatformAuditSection /> },
          { path: "settings", element: <PlatformSettingsSection /> },
        ],
      },
      {
        path: ROUTES.platformMfa,
        element: <Navigate to={ROUTES.platformConsole} replace />,
      },
    ],
  },
];

/**
 * The platform origin's root, kept OUT of `platformOwnerRoutes` on purpose.
 *
 * "/" is also the campaign dashboard's path, so this is the one route that
 * genuinely collides between the two surfaces. On the platform-only surface
 * the campaign dashboard does not exist and "/" would otherwise land on a
 * no-match page, so the redirect is right there. On "both" it must NOT be
 * registered: it would shadow the campaign dashboard and change the main
 * origin's behaviour during EXPAND, which is exactly what "both" exists to
 * prevent. Sends the owner to the console, which is itself guarded - this
 * redirect authorizes nothing.
 */
const platformRootRedirect: RouteObject = {
  path: "/",
  element: <Navigate to={ROUTES.platformConsole} replace />,
};

/**
 * The platform origin's `/login`. Unified entry means the shared entry PATH
 * resolves on every surface; on this one the entry IS the Platform Owner
 * login, because that is the only principal this origin serves - which is the
 * origin split working as designed, not a gap.
 *
 * Kept OUT of `platformOwnerRoutes` for exactly the reason `platformRootRedirect`
 * is: on "both" the election surface's own `/login` (the full entry screen)
 * must keep winning, so this is registered only on the platform-only branch.
 * Authorizes nothing - the destination is itself a login screen.
 */
const platformLoginAlias: RouteObject = {
  path: ROUTES.login,
  element: <Navigate to={ROUTES.platformLogin} replace />,
};

/**
 * CUTOVER compatibility - the ELECTION surface only.
 *
 * Registered exclusively on the "election" branch below, so it costs the
 * "platform" and "both" builds nothing and changes neither of their
 * behaviours. Each entry sends the browser to the canonical Platform origin;
 * see PlatformOriginRedirect for why the destination is a key rather than a
 * URL and why `/platform/set-password` forwards no token.
 *
 * `platformMfa` maps to the console because that is exactly what the platform
 * surface itself does with that path (see platformOwnerRoutes above) - the MFA
 * architecture is unchanged by this shim.
 */
const platformCompatRedirects: RouteObject[] = [
  { path: ROUTES.platformConsole, element: <PlatformOriginRedirect target="console" /> },
  { path: ROUTES.platformLogin, element: <PlatformOriginRedirect target="login" /> },
  { path: ROUTES.platformMfa, element: <PlatformOriginRedirect target="console" /> },
  {
    path: ROUTES.platformSetPassword,
    element: <PlatformOriginRedirect target="setPassword" />,
  },
];

/** Election Day / Election Owner / campaign surface - the existing app,
 * unchanged apart from no longer carrying the Platform Owner routes. */
const electionRoutes: RouteObject[] = [
  // THE unified application entry. `/login` is the canonical path (the legacy
  // campaign-user email/OTP screen that used to live here is retired and does
  // not return); `/election-day/login` renders the same screen so the Owner's
  // `?w=<code>` links and existing bookmarks keep working. `/` reaches it
  // through VoterManagementGuard's signed-out redirect.
  //
  // It hosts the two realms that already share this origin (PermissionUser
  // inline, Election Owner one click away) and LINKS to the Platform and
  // Multi-Entity origins - their login screens are deliberately absent from
  // this bundle, which is the whole point of the origin split.
  { path: ROUTES.login, element: <EntryScreen /> },
  { path: ROUTES.electionDayLogin, element: <ElectionDayLoginScreen /> },
  // Leg 2 of the Auth-origin handoff, on THIS origin. Serves both realms
  // this origin hosts: the worker (no OTP - the server sets the session
  // cookie) and the Election Owner (aal1 via this origin's own client).
  {
    path: ROUTES.authComplete,
    element: <AuthCompleteScreen verifyOtp={verifyOtpWith(ownerAuthClient)} />,
  },
  { path: ROUTES.electionDayOwnerLogin, element: <OwnerLoginScreen /> },
  // Stage 3B - both routes are deliberately OUTSIDE OwnerAuthGuard.
  // owner-set-password is reached from a one-time activation link by
  // someone who has no session at all yet (the link is the proof, verified
  // server-side by the screen itself). owner/setup is reached by an
  // authenticated Owner who has no election_owners row yet - exactly the
  // state OwnerAuthGuard treats as "not an owner" and bounces to login.
  // OwnerSetupPage does its own equivalent gating instead.
  {
    path: ROUTES.electionDayOwnerSetPassword,
    element: <OwnerSetPasswordScreen />,
  },
  { path: ROUTES.electionDayOwnerSetup, element: <OwnerSetupPage /> },
  {
    // Voter Management - the legacy Supabase campaign identity (AuthGuard +
    // `profiles.role`) is retired here. These routes now resolve through the
    // SAME workspace PermissionUser session as Election Day and Budget, and
    // the guard sits ABOVE the shell exactly like BudgetGuard/BudgetShell so
    // an unauthenticated or unentitled visitor never renders shell chrome.
    // `/team` is deliberately absent - see ROUTES.team.
    element: <VoterManagementGuard />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: ROUTES.dashboard, element: <DashboardPage /> },
          { path: ROUTES.voters, element: <VotersPage /> },
          { path: ROUTES.activists, element: <ActivistsPage /> },
          { path: ROUTES.import, element: <ImportPage /> },
        ],
      },
    ],
  },
  {
    // Election Day UX v3: its own independent shell (own sidebar, own nav,
    // own identity via ElectionDayGuard) - deliberately NOT nested under
    // AppLayout anymore (see CLAUDE.md's "Election Day's own local login"
    // section and this feature's Blueprint). ElectionDayShell replaces the
    // main app's sidebar entirely while inside /election-day/*. Child paths
    // are relative segments (not the full `ELECTION_DAY_ROUTES.*` strings)
    // so the `index` redirect has an unambiguous parent path to anchor to.
    path: ROUTES.electionDay,
    element: <ElectionDayGuard />,
    children: [
      {
        element: <ElectionDayShell />,
        children: [
          { index: true, element: <ElectionDayIndexRedirect /> },
          {
            // The module's own screens, behind the `election_day` entitlement.
            // The gate sits HERE, not in front of the shell, so an Owner whose
            // workspace is entitled to nothing can still reach the
            // administration sections below.
            element: <ElectionDayModuleGate />,
            children: [
              { path: "dashboard", element: <ElectionDayDashboardPage /> },
              { path: "voters", element: <ElectionDayVotersPage /> },
              { path: "files", element: <ElectionDayFilesPage /> },
              { path: "rides", element: <ElectionDayRidesPage /> },
              { path: "reasons", element: <ElectionDayReasonsPage /> },
              { path: "reports", element: <ElectionDayReportsPage /> },
            ],
          },
          {
            // Owner administration - the SAME sections, now rendered inside
            // the one full shell instead of a second one of their own. Their
            // paths are unchanged (`/election-day/owner/*`), so every existing
            // link, deep link and retained test target still resolves.
            // `OwnerAdminOutlet` provides their shared context and refuses a
            // worker; the server is still the authority on every request.
            element: <OwnerAdminOutlet />,
            children: [
              { path: "owner", element: <Navigate to="users" replace /> },
              { path: "owner/users", element: <OwnerUsersSection /> },
              { path: "owner/roles", element: <OwnerRolesSection /> },
              { path: "owner/modules", element: <OwnerModulesSection /> },
              { path: "owner/settings", element: <OwnerSettingsSection /> },
              { path: "owner/budget-settings", element: <OwnerBudgetSettingsSection /> },
            ],
          },
        ],
      },
    ],
  },
  {
    // Budget Stage 3: the Budget module - its own top-level tree like Election
    // Day, behind BudgetGuard (the same PermissionUser session; every request
    // is re-authorized server-side). Stage 6 adds the dashboard (the landing
    // page) and the reports.
    path: ROUTES.budget,
    element: <BudgetGuard />,
    children: [
      {
        element: <BudgetShell />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", element: <BudgetDashboardPage /> },
          { path: "reports", element: <BudgetReportsPage /> },
          { path: "planning", element: <BudgetPlanningPage /> },
          { path: "expenses", element: <BudgetExpensesPage /> },
          { path: "expenses/:expenseId", element: <BudgetExpensePage /> },
          { path: "suppliers", element: <BudgetSuppliersPage /> },
          { path: "settings", element: <BudgetSettingsPage /> },
        ],
      },
    ],
  },
];

/**
 * Election routes come FIRST on "both" so every existing path - "/" above all
 * - resolves exactly as it does today. The platform routes appended after them
 * occupy their own `/platform/*` namespace and collide with nothing.
 *
 * Written as a ternary chain rather than a lookup table on purpose:
 * `APP_SURFACE` is substituted at build time, so these comparisons are
 * constant-folded and the surfaces this build does not serve are dropped from
 * the bundle entirely. A `Record<AppSurface, ...>` would reference all three
 * arrays unconditionally and defeat that, leaving the other principal's login
 * screen in the shipped JavaScript.
 */
export const router = createBrowserRouter(
  APP_SURFACE === "auth"
    ? authSurfaceRoutes
    : APP_SURFACE === "platform"
      ? [...platformOwnerRoutes, platformRootRedirect, platformLoginAlias]
      : APP_SURFACE === "multi_entity"
        ? multiEntityOwnerRoutes
        : APP_SURFACE === "both"
          ? [...electionRoutes, ...platformOwnerRoutes]
          : [...electionRoutes, ...platformCompatRedirects],
);
