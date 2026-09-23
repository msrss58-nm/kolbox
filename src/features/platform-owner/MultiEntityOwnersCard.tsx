import { useState } from "react";
import { UserCog, UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { KOLBOX_ORIGIN_URLS } from "../../app/origins";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import type { MultiEntitySeat } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.multiEntity.seat;

/** The ONE address every principal signs in at. Taken from the hard-coded
 * origin map, never derived from a link or the address bar. */
const OWNER_LOGIN_URL = KOLBOX_ORIGIN_URLS.sharedLogin;

function Row({ label, value, ltr = false }: { label: string; value: string; ltr?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-xs font-semibold text-slate-500">{label}</span>
      {ltr ? (
        <LtrValue value={value} className="text-sm font-semibold text-slate-800 sm:text-end" />
      ) : (
        <span className="text-sm font-semibold break-words text-slate-800 sm:text-end">
          {value}
        </span>
      )}
    </div>
  );
}

/**
 * EVERY Multi-Entity Owner, not a single seat.
 *
 * Selecting one scopes the workspace list beside it, because with several
 * owners "assign this workspace" is only a complete instruction once it says
 * to whom. The selected owner is the one the operator is administering; it
 * confers nothing and is never sent anywhere on its own.
 *
 * Each owner carries the same durable hand-off details the single seat did -
 * name, login username, e-mail, the shared-login address - so a reload never
 * loses what the operator needs to finish onboarding. The one-time
 * password-setting link remains the deliberate exception: it is a credential,
 * shown once by `MultiEntityPasswordLinkPanel`, and never persisted.
 *
 * Replace and Remove are DIFFERENT operations and are presented as such:
 * replace hands one owner's seat to a new identity keeping their workspaces,
 * remove ends that owner entirely. Neither deletes an Auth account - that is
 * a separate, separately-approved step surfaced by its own card.
 */
export function MultiEntityOwnersCard({
  owners,
  selectedOwnerId,
  loading,
  disabled,
  isBusy,
  errorFor,
  onSelect,
  onAdd,
  onReplace,
  onRemove,
}: {
  owners: MultiEntitySeat[];
  selectedOwnerId: string | null;
  loading: boolean;
  disabled: boolean;
  isBusy: (key: string) => boolean;
  errorFor: (key: string) => string | null;
  onSelect: (ownerId: string) => void;
  onAdd: () => void;
  onReplace: (owner: MultiEntitySeat) => void;
  onRemove: (owner: MultiEntitySeat) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState<MultiEntitySeat | null>(null);

  return (
    <>
      <Card className="space-y-4" data-testid="multi-entity-owners">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserCog className="size-5 text-slate-700" />
            <CardTitle>{text.title}</CardTitle>
          </div>
          {!loading && owners.length > 0 && (
            <span className="text-xs font-semibold text-slate-500">
              {text.count(owners.length)}
            </span>
          )}
        </div>

        {loading && (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="w-2/3" />
            <Skeleton className="w-1/2" />
            <Skeleton className="w-3/5" />
          </div>
        )}

        {!loading && owners.length === 0 && (
          <EmptyState
            dense
            icon={UserPlus}
            title={text.emptyTitle}
            hint={text.emptyHint}
            action={
              <Button onClick={onAdd} disabled={disabled}>
                {text.provision}
              </Button>
            }
          />
        )}

        {!loading && owners.length > 0 && (
          <>
            <ul className="space-y-2" data-testid="multi-entity-owner-list">
              {owners.map((owner) => {
                const selected = owner.ownerId === selectedOwnerId;
                const busy = isBusy(`owner:${owner.ownerId}`);
                const error = errorFor(`owner:${owner.ownerId}`);
                return (
                  <li
                    key={owner.ownerId}
                    data-testid="multi-entity-owner-row"
                    data-selected={selected ? "true" : "false"}
                    className={cn(
                      "rounded-xl p-3 ring-1 transition-colors",
                      selected ? "bg-primary-50/50 ring-primary-300" : "bg-white ring-slate-200",
                    )}
                  >
                    {/* The whole row selects, so the operator never has to hunt
                        for a small control to change who they are editing. */}
                    <button
                      type="button"
                      onClick={() => onSelect(owner.ownerId)}
                      aria-pressed={selected}
                      className="w-full rounded-lg text-start focus-visible:outline-2 focus-visible:outline-primary-500"
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-bold text-slate-800">
                          {owner.name}
                        </span>
                        <span className="shrink-0 text-xs font-semibold text-slate-500">
                          {selected ? text.selected : text.select}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                        {text.assignedCount(owner.assignedWorkspaceIds.length)}
                      </span>
                    </button>

                    {selected && (
                      <div className="mt-2">
                        <Row
                          label={text.usernameLabel}
                          value={owner.username ?? text.noUsername}
                          ltr={!!owner.username}
                        />
                        <Row label={text.emailLabel} value={owner.email} ltr />
                        <Row
                          label={text.phoneLabel}
                          value={owner.phone ?? text.noPhone}
                          ltr={!!owner.phone}
                        />
                        <Row label={text.authIdLabel} value={owner.authUserId} ltr />
                        <Row label={text.loginUrlLabel} value={OWNER_LOGIN_URL} ltr />
                        <Row
                          label={text.createdAtLabel}
                          value={formatDateTime(owner.createdAt)}
                        />
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={busy}
                            disabled={disabled}
                            onClick={() => onReplace(owner)}
                          >
                            {text.replace}
                          </Button>
                          <Button
                            variant="danger-outline"
                            size="sm"
                            disabled={disabled}
                            onClick={() => setConfirmRemove(owner)}
                          >
                            {text.remove}
                          </Button>
                        </div>
                        {error && (
                          <p role="alert" className="mt-2 text-sm font-medium text-opponent">
                            {error}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            <p className="text-xs text-slate-500" data-testid="seat-handoff-hint">
              {text.handoffHint}
            </p>

            <Button variant="secondary" onClick={onAdd} disabled={disabled} className="w-full sm:w-auto">
              {text.add}
            </Button>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirmRemove !== null}
        title={text.confirmRemoveTitle}
        message={confirmRemove ? text.confirmRemoveMessage(confirmRemove.name) : ""}
        confirmLabel={text.confirmRemove}
        danger
        onConfirm={() => {
          if (confirmRemove) onRemove(confirmRemove);
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
    </>
  );
}
