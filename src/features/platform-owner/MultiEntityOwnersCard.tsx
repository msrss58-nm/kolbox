import { useState } from "react";
import { KeyRound, UserCog, UserPlus } from "lucide-react";
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
import type { MultiEntitySeat, MultiEntityWorkspace } from "./platformOwnerClient";

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
 * EVERY Multi-Entity Owner, as a COMPACT list that stays readable with many
 * of them on one screen.
 *
 * A collapsed row carries only what identifies a person - name, login
 * username, e-mail, phone - plus how many systems they hold and a "פתח"
 * action. Everything else lives in the expanded view, so twenty owners are
 * twenty short rows rather than twenty detail panels.
 *
 * ONE owner is open at a time (an accordion). That is also what scopes the
 * workspace list beside this card: with several owners, "assign this
 * workspace" is only a complete instruction once it says to whom, and having
 * the open owner BE the assignment target keeps that a single, visible idea
 * rather than two independent selections the operator has to keep in sync.
 * Opening is always available and never latches - a row can be closed and
 * reopened freely, and after a reload the list renders from server state with
 * every row openable again.
 *
 * Replace and Remove are DIFFERENT operations and are presented as such:
 * replace hands one owner's seat to a new identity keeping their workspaces,
 * remove ends that owner entirely. Neither deletes an Auth account - that is
 * a separate, separately-approved step surfaced by its own card.
 *
 * The one-time set-password link is NOT shown here and is never stored. When
 * it is lost, the expanded view offers to mint a fresh one, which invalidates
 * whatever link was circulating before.
 */
export function MultiEntityOwnersCard({
  owners,
  workspaces,
  openOwnerId,
  formOpen,
  loading,
  disabled,
  isBusy,
  errorFor,
  onOpen,
  onAdd,
  onReplace,
  onRemove,
  onReissueLink,
}: {
  owners: MultiEntitySeat[];
  /** Used only to name an owner's assigned systems in the expanded view. */
  workspaces: MultiEntityWorkspace[];
  openOwnerId: string | null;
  /** True while the provision/replace dialog is open. Replace shares this
   * owner's busy/error key with the dialog, so without this the SAME failure
   * would be rendered twice - once in the dialog, once in the row behind it. */
  formOpen: boolean;
  loading: boolean;
  disabled: boolean;
  isBusy: (key: string) => boolean;
  errorFor: (key: string) => string | null;
  /** Null closes the open row. */
  onOpen: (ownerId: string | null) => void;
  onAdd: () => void;
  onReplace: (owner: MultiEntitySeat) => void;
  onRemove: (owner: MultiEntitySeat) => void;
  onReissueLink: (owner: MultiEntitySeat) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState<MultiEntitySeat | null>(null);
  const nameOf = (id: string) =>
    workspaces.find((w) => w.workspaceId === id)?.name ?? id;

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
                const open = owner.ownerId === openOwnerId;
                const busy = isBusy(`owner:${owner.ownerId}`);
                const error = errorFor(`owner:${owner.ownerId}`);
                const assigned = owner.assignedWorkspaceIds;
                return (
                  <li
                    key={owner.ownerId}
                    data-testid="multi-entity-owner-row"
                    data-open={open ? "true" : "false"}
                    className={cn(
                      "rounded-xl p-3 ring-1 transition-colors",
                      open ? "bg-primary-50/50 ring-primary-300" : "bg-white ring-slate-200",
                    )}
                  >
                    {/* COMPACT SUMMARY - identity down to the phone, nothing more. */}
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate font-bold text-slate-800">{owner.name}</p>
                        <p className="truncate text-xs font-semibold text-slate-600">
                          <span className="text-slate-400">{text.usernameLabel}: </span>
                          {owner.username ?? text.noUsername}
                        </p>
                        <LtrValue
                          value={owner.email}
                          className="block truncate text-xs text-slate-500"
                        />
                        <LtrValue
                          value={owner.phone ?? text.noPhone}
                          className="block truncate text-xs text-slate-500"
                        />
                        <p className="text-xs font-semibold text-slate-500">
                          {text.assignedCount(assigned.length)}
                        </p>
                      </div>
                      <Button
                        variant={open ? "secondary" : "primary"}
                        size="sm"
                        data-testid="owner-open"
                        aria-expanded={open}
                        onClick={() => onOpen(open ? null : owner.ownerId)}
                        className="shrink-0"
                      >
                        {open ? text.close : text.open}
                      </Button>
                    </div>

                    {open && (
                      <div className="mt-3 border-t border-primary-200 pt-3" data-testid="owner-expanded">
                        <Row label={text.emailLabel} value={owner.email} ltr />
                        <Row label={text.authIdLabel} value={owner.authUserId} ltr />
                        <Row label={text.loginUrlLabel} value={OWNER_LOGIN_URL} ltr />
                        <Row
                          label={text.createdAtLabel}
                          value={formatDateTime(owner.createdAt)}
                        />
                        <Row
                          label={text.updatedAtLabel}
                          value={formatDateTime(owner.updatedAt)}
                        />

                        {/* The workspaces THIS owner holds, by name. */}
                        <div className="py-2">
                          <p className="text-xs font-semibold text-slate-500">
                            {text.assignmentsLabel}
                          </p>
                          {assigned.length === 0 ? (
                            <p className="mt-1 text-sm text-slate-500">
                              {text.noAssignments}
                            </p>
                          ) : (
                            <ul
                              className="mt-1 flex flex-wrap gap-1.5"
                              data-testid="owner-assignments"
                            >
                              {assigned.map((id) => (
                                <li
                                  key={id}
                                  className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200"
                                >
                                  {nameOf(id)}
                                </li>
                              ))}
                            </ul>
                          )}
                          <p className="mt-1.5 text-xs text-slate-500">
                            {text.openedHint}
                          </p>
                        </div>

                        {/* Set-password hand-off. The link itself is never kept;
                            this mints a fresh one and kills the previous. */}
                        <div className="border-t border-slate-100 py-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            data-testid="owner-reissue-link"
                            loading={busy}
                            disabled={disabled}
                            onClick={() => onReissueLink(owner)}
                          >
                            <KeyRound className="me-1 size-4" aria-hidden />
                            {text.reissue}
                          </Button>
                          <p className="mt-1.5 text-xs text-slate-500">
                            {text.reissueHint}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-2">
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

                        {/* The dialog owns the message while it is open. */}
                        {error && !formOpen && (
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
