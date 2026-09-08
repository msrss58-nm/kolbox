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
import "../features/platform-owner/platformOwnerRecoveryUrl";
import { createBrowserRouter, Navigate } from "react-router";
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

export const router = createBrowserRouter([
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
  { path: ROUTES.platformLogin, element: <PlatformOwnerLoginScreen /> },
  {
    // Platform Stage 2 (password set/recovery): the recovery/invite landing
    // page. A TOP-LEVEL SIBLING route - deliberately NOT nested under
    // PlatformOwnerAuthGuard, which would divert the `aal1` session a
    // recovery link produces straight into MFA enrollment and make the
    // password form unreachable - and NOT under AppLayout/AuthGuard/
    // ElectionDayGuard/OwnerAuthGuard either. It authorizes nothing: it can
    // only change the account password and then hand the owner back to
    // /platform/login, where the full aal1 -> aal2 -> server-200 chain still
    // applies (see PlatformOwnerSetPasswordScreen.tsx's security model).
    path: ROUTES.platformSetPassword,
    element: <PlatformOwnerSetPasswordScreen />,
  },
  {
    // Platform Stage 2: the Platform Owner console - a FOURTH identity, with
    // its own top-level SIBLING guard. Deliberately NOT nested under
    // AppLayout, AuthGuard, ElectionDayGuard, or OwnerAuthGuard, and it
    // renders no Election Day shell/nav and touches no voter data.
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
]);
