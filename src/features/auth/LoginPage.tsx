import { useEffect } from "react";
import { useNavigate } from "react-router";
import { AuthBrandLayout } from "../../components/AuthBrandLayout";
import { ROUTES } from "../../constants/routes";
import { useAuth } from "./authStore";
import { EmailAuthPanel } from "./EmailAuthPanel";

export function LoginPage() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();

  // Redirects the moment a session lands (code verified, or a redirect
  // back into an already-open tab) - a genuine external-state sync, the
  // canonical case an effect is for.
  useEffect(() => {
    if (user) void navigate(ROUTES.dashboard, { replace: true });
  }, [user, navigate]);

  return (
    <AuthBrandLayout>
      <EmailAuthPanel />
    </AuthBrandLayout>
  );
}
