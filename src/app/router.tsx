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
import { ImportPage } from "../features/import/ImportPage";
import { TeamPage } from "../features/team/TeamPage";
import { VotersPage } from "../features/voters/VotersPage";
import { AppLayout } from "./AppLayout";
import { AuthGuard } from "./AuthGuard";

export const router = createBrowserRouter([
  { path: ROUTES.login, element: <LoginPage /> },
  { path: ROUTES.electionDayLogin, element: <ElectionDayLoginScreen /> },
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
