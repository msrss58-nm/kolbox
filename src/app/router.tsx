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
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { ROUTES } from "../constants/routes";
import { ActivistsPage } from "../features/activists/ActivistsPage";
import { LoginPage } from "../features/auth/LoginPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ElectionDayDashboardPage } from "../features/election-day/ElectionDayDashboardPage";
import { ElectionDayFilesPage } from "../features/election-day/ElectionDayFilesPage";
import { ElectionDayGuard } from "../features/election-day/ElectionDayGuard";
import { ElectionDayLoginScreen } from "../features/election-day/ElectionDayLoginScreen";
import { ElectionDayPermissionsPage } from "../features/election-day/ElectionDayPermissionsPage";
import { ElectionDayReasonsPage } from "../features/election-day/ElectionDayReasonsPage";
import { ElectionDayReportsPage } from "../features/election-day/ElectionDayReportsPage";
import { ElectionDayRidesPage } from "../features/election-day/ElectionDayRidesPage";
import { ElectionDayShell } from "../features/election-day/ElectionDayShell";
import { ElectionDayVotersPage } from "../features/election-day/ElectionDayVotersPage";
import { OwnerAuthGuard } from "../features/election-day/OwnerAuthGuard";
import { OwnerLoginScreen } from "../features/election-day/OwnerLoginScreen";
import { OwnerRolesPage } from "../features/election-day/OwnerRolesPage";
import { ImportPage } from "../features/import/ImportPage";
import { PlatformOwnerAuthGuard } from "../features/platform-owner/PlatformOwnerAuthGuard";
import { PlatformOwnerConsolePage } from "../features/platform-owner/PlatformOwnerConsolePage";
import { PlatformOwnerLoginScreen } from "../features/platform-owner/PlatformOwnerLoginScreen";
import { PlatformOwnerSetPasswordScreen } from "../features/platform-owner/PlatformOwnerSetPasswordScreen";
import { TeamPage } from "../features/team/TeamPage";
import { VotersPage } from "../features/voters/VotersPage";
import { AppLayout } from "./AppLayout";
import { AuthGuard } from "./AuthGuard";
import { PlatformOriginRedirect } from "./PlatformOriginRedirect";

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
 * THREE VALUES:
 *   "election" - Election Day / Election Owner / campaign only (the default).
 *   "platform" - Platform Owner only.
 *   "both"     - every route, for the EXPAND window only.
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
type AppSurface = "election" | "platform" | "both";

const APP_SURFACE: AppSurface =
  import.meta.env.VITE_APP_SURFACE === "platform"
    ? "platform"
    : import.meta.env.VITE_APP_SURFACE === "both"
      ? "both"
      : "election";

/** Platform Owner surface - the FOURTH identity, served from its own origin. */
const platformOwnerRoutes: RouteObject[] = [
  { path: ROUTES.platformLogin, element: <PlatformOwnerLoginScreen /> },
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
      { path: ROUTES.platformConsole, element: <PlatformOwnerConsolePage /> },
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
  { path: ROUTES.login, element: <LoginPage /> },
  { path: ROUTES.electionDayLogin, element: <ElectionDayLoginScreen /> },
  { path: ROUTES.electionDayOwnerLogin, element: <OwnerLoginScreen /> },
  {
    // Phase 3C Roles Mutations: the Election Owner route tree - its own
    // independent guard (OwnerAuthGuard), deliberately NOT nested under
    // ElectionDayGuard (a PermissionUser session) or AuthGuard (the main
    // app's Supabase Auth) - see ownerSession.ts's own doc comment for why
    // these three identities must stay structurally independent.
    element: <OwnerAuthGuard />,
    children: [{ path: ROUTES.electionDayOwnerRoles, element: <OwnerRolesPage /> }],
  },
  {
    // Main app shell (Supabase-authenticated routes only).
    element: <AppLayout />,
    children: [
      {
        element: <AuthGuard />,
        children: [
          { path: ROUTES.dashboard, element: <DashboardPage /> },
          { path: ROUTES.voters, element: <VotersPage /> },
          { path: ROUTES.activists, element: <ActivistsPage /> },
          { path: ROUTES.import, element: <ImportPage /> },
          { path: ROUTES.team, element: <TeamPage /> },
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
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", element: <ElectionDayDashboardPage /> },
          { path: "voters", element: <ElectionDayVotersPage /> },
          { path: "files", element: <ElectionDayFilesPage /> },
          { path: "permissions", element: <ElectionDayPermissionsPage /> },
          { path: "rides", element: <ElectionDayRidesPage /> },
          { path: "reasons", element: <ElectionDayReasonsPage /> },
          { path: "reports", element: <ElectionDayReportsPage /> },
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
  APP_SURFACE === "platform"
    ? [...platformOwnerRoutes, platformRootRedirect]
    : APP_SURFACE === "both"
      ? [...electionRoutes, ...platformOwnerRoutes]
      : [...electionRoutes, ...platformCompatRedirects],
);
