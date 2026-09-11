import { Network, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { OwnerAccessListCard } from "./OwnerAccessListCard";
import { OwnerApprovalCard } from "./OwnerApprovalCard";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import { useMultiEntityManagement } from "./useMultiEntityManagement";
import { useOwnerAccess } from "./useOwnerAccess";

const text = PLATFORM_OWNER_TEXT.console;
const multiEntityText = PLATFORM_OWNER_TEXT.multiEntity.entry;

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
 * Stage 4B entry point. A summary line plus a link - deliberately NOT the
 * management surface itself, which lives on its own route so it survives a
 * reload mid-workflow and keeps this page from growing a second admin domain.
 *
 * It reuses the management hook purely for its read: one `multi_entity_state`
 * call, the same 401-to-refreshStatus handling, and no duplicated mapping. On
 * a read error the button still renders - the target page owns real error
 * handling, and a summary that failed to load is no reason to block access.
 */
function MultiEntityEntryCard() {
  const { seat, assignedCount, loading } = useMultiEntityManagement();
  const navigate = useNavigate();

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Network className="size-5 text-slate-700" />
        <CardTitle>{multiEntityText.title}</CardTitle>
      </div>

      {loading ? (
        <Skeleton className="w-2/3" />
      ) : (
        <p className="text-sm break-words text-slate-600">
          {seat
            ? multiEntityText.provisioned(seat.name, assignedCount)
            : multiEntityText.unprovisioned}
        </p>
      )}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => void navigate(ROUTES.platformMultiEntity)}
        className="w-full sm:w-auto"
      >
        {multiEntityText.open}
      </Button>
    </Card>
  );
}

/**
 * The Platform Owner console landing screen. Reachable ONLY through
 * `PlatformOwnerAuthGuard`'s single "authorized" branch, i.e. only after
 * `GET /api/platform/session` returned 200 for an `aal2` session.
 *
 * Composes: the verified identity, the Multi-Entity entry card, the Election
 * Owner approval form (Stage 3B) and the approvals list with its recovery
 * actions (Stage 8B). Standalone layout - NOT nested under `AppLayout` or
 * `ElectionDayShell` - and it never imports Election Day data (no voter PII may
 * reach this surface).
 */
export function PlatformOwnerConsolePage() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const logout = usePlatformOwnerSession((s) => s.logout);
  const loggingOut = usePlatformOwnerSession((s) => s.loggingOut);
  const navigate = useNavigate();
  const access = useOwnerAccess();

  const handleLogout = async () => {
    await logout();
    void navigate(ROUTES.platformLogin, { replace: true });
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark className="size-9 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-extrabold text-slate-800">{text.title}</h1>
            {owner && (
              <p className="text-xs break-all text-slate-500">
                {text.signedInAs(owner.email)}
              </p>
            )}
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          loading={loggingOut}
          onClick={() => void handleLogout()}
          className="shrink-0"
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

      <MultiEntityEntryCard />

      <OwnerApprovalCard onChanged={() => void access.reload()} />

      <OwnerAccessListCard access={access} />

      <p className="text-center text-xs text-slate-500">{text.stageNote}</p>
    </div>
  );
}
