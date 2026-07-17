import { Navigate, Outlet, useLocation } from "react-router";
import { ROUTES } from "../constants/routes";
import { useAuth } from "../features/auth/authStore";
import { PendingApprovalScreen } from "../features/auth/PendingApprovalScreen";
import { LogoMark } from "../components/Logo";

export function AuthGuard() {
  const user = useAuth((s) => s.user);
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="grid min-h-dvh place-items-center bg-surface">
        <LogoMark className="size-12 animate-pulse" />
      </div>
    );
  }

  if (status === "unauthenticated" || !user) {
    return <Navigate to={ROUTES.login} replace state={{ from: location.pathname }} />;
  }

  if (user.role === null) return <PendingApprovalScreen />;

  return <Outlet />;
}
