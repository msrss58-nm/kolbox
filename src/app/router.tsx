import { createBrowserRouter } from "react-router";
import { ROUTES } from "../constants/routes";
import { ActivistsPage } from "../features/activists/ActivistsPage";
import { LoginPage } from "../features/auth/LoginPage";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { ElectionDayGuard } from "../features/election-day/ElectionDayGuard";
import { ElectionDayLoginScreen } from "../features/election-day/ElectionDayLoginScreen";
import { ElectionDayPage } from "../features/election-day/ElectionDayPage";
import { ImportPage } from "../features/import/ImportPage";
import { TeamPage } from "../features/team/TeamPage";
import { VotersPage } from "../features/voters/VotersPage";
import { AppLayout } from "./AppLayout";
import { AuthGuard } from "./AuthGuard";

export const router = createBrowserRouter([
  { path: ROUTES.login, element: <LoginPage /> },
  { path: ROUTES.electionDayLogin, element: <ElectionDayLoginScreen /> },
  {
    // Shared shell (sidebar/bottom-nav) for both the main app and Election
    // Day - but only the main app's routes sit behind the Supabase AuthGuard.
    // Election Day has its own independent gate (ElectionDayGuard) and is
    // deliberately not nested under AuthGuard - see CLAUDE.md's "Election
    // Day's own local login" section.
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
      {
        element: <ElectionDayGuard />,
        children: [{ path: ROUTES.electionDay, element: <ElectionDayPage /> }],
      },
    ],
  },
]);
