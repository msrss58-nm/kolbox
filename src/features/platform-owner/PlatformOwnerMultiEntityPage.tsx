import { useState } from "react";
import { AdminSection } from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
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
 * Platform Stage 4B: Multi-Entity Owner management - the `multi-entity`
 * section of the Platform console shell (`/platform/multi-entity`).
 *
 * A child of `PlatformOwnerAuthGuard` through the shell, so nothing here
 * renders before the server's `GET /api/platform/session` returns 200 for an
 * aal2 session. It never imports Election Day data: no voter PII may reach
 * this surface. Its hook is mounted here (not in the shell) on purpose: the
 * one-time password link lives in memory only and is gone when the operator
 * leaves the section, exactly as it was when this was a separate page.
 *
 * Card order is deliberate. The two cleanup queues come first, because they
 * are the only outstanding irreversible work here, and burying them under a
 * workspace list is how an orphaned Auth account gets forgotten. They render
 * only when the server says there is something to clean.
 */
export function PlatformOwnerMultiEntityPage() {
  const m = useMultiEntityManagement();
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
    <>
      <AdminSection
        testId="platform-multi-entity-section"
        title={text.title}
        description={text.stageNote}
      >
        {m.readError ? (
          <Card className="space-y-3">
            <p role="alert" className="text-sm font-medium text-opponent">
              {m.readError}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void m.reload()}>
              {text.retry}
            </Button>
          </Card>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
            <div className="space-y-4">
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

              {/* Shown once, straight after a successful provision /
                  replacement. In memory only - gone on dismiss, on reload and
                  when leaving this section - unlike the cleanup queues above,
                  which are durable by design. */}
              {m.passwordLink && (
                <MultiEntityPasswordLinkPanel
                  value={m.passwordLink}
                  onDismiss={m.dismissPasswordLink}
                />
              )}
            </div>

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
          </div>
        )}
      </AdminSection>

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
    </>
  );
}
