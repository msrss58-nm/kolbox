import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Modal } from "../../components/ui/Modal";
import { AdminListFrame } from "../../components/admin/AdminSection";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import { OneTimeLinkBox } from "./OneTimeLinkBox";
import type { OwnerAccessApproval } from "./platformOwnerClient";
import type { useOwnerAccess } from "./useOwnerAccess";

const text = PLATFORM_OWNER_TEXT.ownerAccess;

export function ApprovalStatePill({ state }: { state: OwnerAccessApproval["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        state === "active" && "bg-supporter-soft text-emerald-800",
        state === "expired" && "bg-potential-soft text-amber-900",
        state === "consumed" && "bg-slate-100 text-slate-600",
      )}
    >
      {text.states[state]}
    </span>
  );
}

function dateLine(a: OwnerAccessApproval): string {
  if (a.state === "consumed") return text.consumedAt(formatDateTime(a.consumedAt));
  if (a.state === "expired") return text.expiredAt(formatDateTime(a.expiresAt));
  return text.expiresAt(formatDateTime(a.expiresAt));
}

/**
 * Stage 8B: the Election Owner approvals, with the one recovery action the
 * business rules allow. Active -> a new one-time link (window unchanged);
 * expired -> renew the window and issue a link; consumed -> read-only (the
 * Owner has provisioned - one Owner per workspace). Both actions go through a
 * confirmation because a new link invalidates any link handed out earlier.
 *
 * A re-issued link opens in a dialog (it is shown once, from memory only, and
 * is gone when the dialog closes or the page reloads). The server decides
 * everything; this list only offers what the stated row permits.
 */
export function OwnerAccessList({
  access,
  approvals,
}: {
  access: ReturnType<typeof useOwnerAccess>;
  /** The (possibly filtered) rows to show. */
  approvals: OwnerAccessApproval[];
}) {
  const [confirm, setConfirm] = useState<OwnerAccessApproval | null>(null);
  const issued = access.issued;

  return (
    <>
      <AdminListFrame>
        <ul className="divide-y divide-slate-100" data-testid="owner-access-list">
          {approvals.map((a) => {
            const busy = access.busyId === a.pendingId;
            const error = access.errorFor(a.pendingId);
            return (
              <li key={a.pendingId} className="space-y-2 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold break-words text-slate-800">{a.name}</p>
                      <ApprovalStatePill state={a.state} />
                    </div>
                    <LtrValue
                      value={a.email}
                      mono={false}
                      className="text-sm text-slate-600"
                    />
                    <p className="text-xs text-slate-500">
                      {dateLine(a)}
                      {a.workspaceName && (
                        <>
                          {" · "}
                          <span className="font-semibold text-slate-600">
                            {text.workspace(a.workspaceName)}
                          </span>
                        </>
                      )}
                    </p>
                    {a.state !== "consumed" && a.requestedModules && (
                      <p className="text-xs text-slate-500">
                        {text.requestedModules(
                          a.requestedModules.map(moduleLabel).join(", "),
                        )}
                      </p>
                    )}
                  </div>

                  {a.state !== "consumed" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy}
                      disabled={access.anyBusy && !busy}
                      onClick={() => setConfirm(a)}
                      className="w-full shrink-0 sm:w-auto"
                    >
                      {a.state === "expired" ? text.renew : text.reissue}
                    </Button>
                  )}
                </div>

                {error && (
                  <p role="alert" className="text-sm font-medium text-opponent">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </AdminListFrame>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.state === "expired" ? text.confirmRenewTitle : text.confirmReissueTitle
        }
        message={
          confirm
            ? confirm.state === "expired"
              ? text.confirmRenewMessage(confirm.name)
              : text.confirmReissueMessage(confirm.name)
            : ""
        }
        confirmLabel={text.confirm}
        onConfirm={() => {
          const a = confirm;
          setConfirm(null);
          if (a) void access.reissue(a);
        }}
        onCancel={() => setConfirm(null)}
      />

      <Modal
        open={issued !== null}
        onClose={access.dismissIssued}
        title={issued ? text.linkTitle(issued.name) : ""}
      >
        {issued && (
          <div className="space-y-3" data-testid="owner-access-issued">
            {issued.renewed && (
              <p className="text-sm text-slate-700">{text.renewedNote}</p>
            )}
            {issued.link ? (
              <>
                <OneTimeLinkBox link={issued.link} />
                <p className="text-xs text-slate-500">
                  {PLATFORM_OWNER_TEXT.approveOwner.linkHint}
                </p>
              </>
            ) : (
              <p role="alert" className="text-sm text-opponent">
                {text.linkMissing}
              </p>
            )}
            <Button type="button" size="sm" onClick={access.dismissIssued}>
              {PLATFORM_OWNER_TEXT.approveOwner.done}
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
