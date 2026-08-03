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
// import { AuthGuard } from "./AuthGuard"; // TODO: re-enable auth gate - see router.tsx below

export const router = createBrowserRouter([
  { path: ROUTES.login, element: <LoginPage /> },
  { path: ROUTES.electionDayLogin, element: <ElectionDayLoginScreen /> },
  {
    // TODO: re-enable AuthGuard here to require login before reaching AppLayout
    // element: <AuthGuard />,
    // children: [
    element: <AppLayout />,
    children: [
      { path: ROUTES.dashboard, element: <DashboardPage /> },
      { path: ROUTES.voters, element: <VotersPage /> },
      { path: ROUTES.activists, element: <ActivistsPage /> },
      { path: ROUTES.import, element: <ImportPage /> },
      {
        element: <ElectionDayGuard />,
        children: [{ path: ROUTES.electionDay, element: <ElectionDayPage /> }],
      },
      { path: ROUTES.team, element: <TeamPage /> },
    ],
    // ],
  },
]);
