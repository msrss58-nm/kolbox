import { ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { usePlatformOwnerSession } from "./platformOwnerSession";

const text = PLATFORM_OWNER_TEXT.console;

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      <span
        dir="ltr"
        className="break-all text-start text-sm font-semibold text-slate-800 sm:text-end"
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Platform Stage 2: the Platform Owner console landing screen. Reachable ONLY
 * through `PlatformOwnerAuthGuard`'s single "authorized" branch, i.e. only
 * after `GET /api/platform/session` returned 200 for an `aal2` session.
 *
 * Stage 2 is auth/session proof ONLY - it confirms the verified identity and
 * offers logout. Workspace provisioning is Stage 3 and deliberately absent.
 * Renders its own standalone layout: this route is NOT nested under
 * `AppLayout` or `ElectionDayShell`, and it must never import Election Day
 * data (no voter PII may reach this surface).
 */
export function PlatformOwnerConsolePage() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    void navigate(ROUTES.platformLogin, { replace: true });
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LogoMark className="size-9" />
          <div>
            <h1 className="text-lg font-extrabold text-slate-800">{text.title}</h1>
            {owner && (
              <p className="text-xs text-slate-500">{text.signedInAs(owner.email)}</p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={loggingOut}
          onClick={() => void handleLogout()}
        >
          {text.logout}
        </Button>
      </header>

      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-supporter" />
          <CardTitle>{text.identityTitle}</CardTitle>
        </div>
        <div>
          <IdentityRow label={text.emailLabel} value={owner?.email ?? ""} />
          <IdentityRow label={text.ownerIdLabel} value={owner?.platformOwnerId ?? ""} />
          <IdentityRow label={text.mfaLabel} value={text.mfaValue} />
        </div>
      </Card>

      <p className="text-center text-xs text-slate-500">{text.stageNote}</p>
    </div>
  );
}
