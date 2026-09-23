import { useState } from "react";
import { AdminSection } from "../../components/admin/AdminSection";
import { UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { MultiEntityPasswordLinkPanel } from "./MultiEntityPasswordLinkPanel";
import { MultiEntityProvisionModal } from "./MultiEntityProvisionModal";
import { MultiEntityProvisioningOrphanCard } from "./MultiEntityProvisioningOrphanCard";
import { MultiEntityReplacementCleanupCard } from "./MultiEntityReplacementCleanupCard";
import { MultiEntityOwnersCard } from "./MultiEntityOwnersCard";
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
  /** null = the form is closed. `{ownerId: null}` = add. `{ownerId}` = replace
   * THAT owner - the two are different operations and never inferred from how
   * many owners happen to exist. */
  const [form, setForm] = useState<{ ownerId: string | null } | null>(null);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);

  // NOTHING is open by default, and closing means closed. An earlier version
  // fell back to the first owner, which made the list open-by-default (wrong
  // for a compact list of many) and made "סגירה" a no-op, because the fallback
  // re-opened the row on the very next render.
  //
  // The only thing reconciled here is an open row that has ceased to exist -
  // removed, or replaced away - which closes rather than dangling.
  //
  // Done with the render-phase compare CLAUDE.md prescribes, not an effect: a
  // setState inside useEffect would re-render on every load.
  const validOwnerId =
    selectedOwnerId !== null && m.owners.some((o) => o.ownerId === selectedOwnerId)
      ? selectedOwnerId
      : null;
  if (validOwnerId !== selectedOwnerId) setSelectedOwnerId(validOwnerId);

  const selectedOwner = m.owners.find((o) => o.ownerId === validOwnerId) ?? null;

  const formKey = form?.ownerId ? BUSY.owner(form.ownerId) : BUSY.provision;
  const provisionError = m.errorFor(formKey);
  const provisionBusy = m.isBusy(formKey);

  // Stage 8B: every open starts clean - no error left over from an earlier
  // attempt. The modal is also only MOUNTED while open (below), so its fields
  // and confirmation step reset after a success as well as after a cancel.
  const openForm = (ownerId: string | null) => {
    m.clearError();
    m.clearUsernameSuggestion();
    setForm({ ownerId });
  };

  const submit = async (input: {
    name: string;
    email: string;
    phone?: string;
    username: string;
  }) => {
    const ok = await m.provision({
      ...input,
      ...(form?.ownerId ? { ownerId: form.ownerId } : {}),
    });
    // The modal stays open on failure so the operator keeps what they typed
    // and can read the inline reason next to the fields.
    if (ok) setForm(null);
  };

  return (
    <>
      <AdminSection
        testId="platform-multi-entity-section"
        title={text.title}
        description={text.stageNote}
        /* Pinned to the END of the header row - the LEFT side in RTL - so the
           section's primary action sits opposite the heading rather than
           buried inside the owners card. */
        actionsEnd={
          m.readError ? null : (
            <Button
              data-testid="add-owner"
              onClick={() => openForm(null)}
              disabled={m.anyBusy}
            >
              <UserPlus className="me-1 size-4" aria-hidden />
              {PLATFORM_OWNER_TEXT.multiEntity.seat.add}
            </Button>
          )
        }
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

              <MultiEntityOwnersCard
                owners={m.owners}
                workspaces={m.workspaces}
                openOwnerId={validOwnerId}
                formOpen={form !== null}
                loading={m.loading}
                disabled={m.anyBusy}
                isBusy={m.isBusy}
                errorFor={m.errorFor}
                onOpen={setSelectedOwnerId}
                onAdd={() => openForm(null)}
                onReplace={(owner) => openForm(owner.ownerId)}
                onRemove={(owner) => void m.removeOwner(owner.ownerId)}
                onReissueLink={(owner) => void m.reissueLink(owner.ownerId)}
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
              selectedOwner={selectedOwner}
              hasOwners={m.owners.length > 0}
              assignedCount={m.assignedCount}
              isBusy={m.isBusy}
              anyBusy={m.anyBusy}
              errorFor={m.errorFor}
              onAssign={(id) => {
                if (validOwnerId) void m.assign(validOwnerId, id);
              }}
              onUnassign={(id) => {
                if (validOwnerId) void m.unassign(validOwnerId, id);
              }}
            />
          </div>
        )}
      </AdminSection>

      {form && (
        <MultiEntityProvisionModal
          open
          /* The MODE comes from what the operator clicked, never from whether
             an owner happens to exist - with several owners that inference is
             meaningless, and getting it wrong would replace someone. */
          replacing={m.owners.find((o) => o.ownerId === form.ownerId) ?? null}
          busy={provisionBusy}
          error={provisionError}
          usernameSuggestion={m.usernameSuggestion}
          onSubmit={(input) => void submit(input)}
          onClose={() => setForm(null)}
        />
      )}
    </>
  );
}
