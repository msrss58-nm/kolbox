import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { ROUTES } from "../../constants/routes";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { MultiEntityPasswordLinkPanel } from "./MultiEntityPasswordLinkPanel";
import { MultiEntityProvisionModal } from "./MultiEntityProvisionModal";
import { MultiEntityProvisioningOrphanCard } from "./MultiEntityProvisioningOrphanCard";
import { MultiEntityReplacementCleanupCard } from "./MultiEntityReplacementCleanupCard";
import { MultiEntitySeatCard } from "./MultiEntitySeatCard";
import { MultiEntityWorkspaceList } from "./MultiEntityWorkspaceList";
import { BUSY, useMultiEntityManagement } from "./useMultiEntityManagement";

const text = PLATFORM_OWNER_TEXT.multiEntity.page;

/**
 * Platform Stage 4B: Multi-Entity Owner management.
 *
 * A child of `PlatformOwnerAuthGuard`, exactly like the console, so it
 * inherits the same single "authorized" branch and needs no guard of its own -
 * nothing here renders before the server's `GET /api/platform/session` returns
 * 200 for an aal2 session. It reuses the console's standalone layout
 * (`max-w-2xl` card stack) rather than introducing a second admin shell, and
 * it never imports Election Day data: no voter PII may reach this surface.
 *
 * Card order is deliberate. The two cleanup queues sit ABOVE the seat, because
 * they are the only outstanding irreversible work on the page, and burying
 * them under a workspace list is how an orphaned Auth account gets forgotten.
 * They render only when the server says there is something to clean.
 *
 * The Multi-Entity Owner itself signs in on its own origin (Stages 5-7) and
 * sees aggregate counts only; the footer says so.
 */
export function PlatformOwnerMultiEntityPage() {
  const m = useMultiEntityManagement();
  const navigate = useNavigate();
  const [formOpen, setFormOpen] = useState(false);

  const provisionError = m.errorFor(BUSY.provision);
  const provisionBusy = m.isBusy(BUSY.provision);

  // Stage 8B: every open starts clean - no error left over from an earlier
  // attempt. The modal is also only MOUNTED while open (below), so its fields
  // and confirmation step reset after a success as well as after a cancel.
  const openForm = () => {
    m.clearError();
    setFormOpen(true);
  };

  const submit = async (input: { name: string; email: string; phone?: string }) => {
    const ok = await m.provision(input);
    // The modal stays open on failure so the operator keeps what they typed
    // and can read the inline reason next to the fields.
    if (ok) setFormOpen(false);
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark className="size-9 shrink-0" />
          {/* Wraps rather than truncates: at 360px the back button leaves the
              title barely enough room, and an ellipsised page title is worse
              than a two-line one. */}
          <h1 className="text-base font-extrabold break-words text-slate-800 sm:text-lg">
            {text.title}
          </h1>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void navigate(ROUTES.platformConsole)}
          className="shrink-0"
        >
          <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
          {text.back}
        </Button>
      </header>

      {m.readError && (
        <Card className="space-y-3">
          <p role="alert" className="text-sm font-medium text-opponent">
            {m.readError}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void m.reload()}>
            {text.retry}
          </Button>
        </Card>
      )}

      {!m.readError && (
        <>
          <MultiEntityReplacementCleanupCard
            items={m.pendingAuthCleanup}
            isBusy={m.isBusy}
            anyBusy={m.anyBusy}
            errorFor={m.errorFor}
            noticeFor={m.noticeFor}
            onPurge={(id) => void m.purgeReplaced(id)}
          />

          <MultiEntityProvisioningOrphanCard
            items={m.pendingProvisioningOrphans}
            isBusy={m.isBusy}
            anyBusy={m.anyBusy}
            errorFor={m.errorFor}
            noticeFor={m.noticeFor}
            onPurge={(id) => void m.purgeOrphan(id)}
          />

          <MultiEntitySeatCard
            seat={m.seat}
            loading={m.loading}
            disabled={m.anyBusy}
            onProvision={openForm}
            onReplace={openForm}
          />

          {/* Shown once, straight after a successful provision/replacement.
              The value lives in memory only and is gone on dismiss or reload -
              unlike the cleanup queues above, which are durable by design. */}
          {m.passwordLink && (
            <MultiEntityPasswordLinkPanel
              value={m.passwordLink}
              onDismiss={m.dismissPasswordLink}
            />
          )}

          <MultiEntityWorkspaceList
            workspaces={m.workspaces}
            loading={m.loading}
            hasSeat={m.seat !== null}
            assignedCount={m.assignedCount}
            isBusy={m.isBusy}
            anyBusy={m.anyBusy}
            errorFor={m.errorFor}
            onAssign={(id) => void m.assign(id)}
            onUnassign={(id) => void m.unassign(id)}
          />
        </>
      )}

      <p className="text-center text-xs text-slate-500">{text.stageNote}</p>

      {formOpen && (
        <MultiEntityProvisionModal
          open
          seat={m.seat}
          busy={provisionBusy}
          error={provisionError}
          onSubmit={(input) => void submit(input)}
          onClose={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
