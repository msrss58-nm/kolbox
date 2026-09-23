import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Modal } from "../../components/ui/Modal";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
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

/** The one date that means something for this approval's state. */
export function approvalDateLine(a: OwnerAccessApproval): string {
  if (a.state === "consumed") return text.consumedAt(formatDateTime(a.consumedAt));
  if (a.state === "expired") return text.expiredAt(formatDateTime(a.expiresAt));
  return text.expiresAt(formatDateTime(a.expiresAt));
}

/** The label of the recovery action a row in THIS state may offer, or null
 * when the server allows none (a consumed approval is read-only: the Owner
 * has provisioned, and there is one Owner per workspace). */
export function approvalActionLabel(a: OwnerAccessApproval): string | null {
  if (a.state === "consumed") return null;
  return a.state === "expired" ? text.renew : text.reissue;
}

/**
 * Stage 8B recovery, as the two dialogs it has always been - now opened from
 * the single "מערכות בחירות" section rather than a screen of its own.
 *
 * Active -> a new one-time link (window unchanged); expired -> renew the
 * window and issue a link; consumed -> no action is offered at all. Both
 * actions go through a confirmation because a new link invalidates any link
 * handed out earlier. The issued link is shown once, from memory only, and is
 * gone when the dialog closes or the page reloads. The server decides
 * everything; this only offers what the stated row permits.
 */
export function OwnerAccessRecovery({
  access,
  confirm,
  onCancel,
}: {
  access: ReturnType<typeof useOwnerAccess>;
  /** The approval awaiting confirmation, or null. */
  confirm: OwnerAccessApproval | null;
  onCancel: () => void;
}) {
  const issued = access.issued;
  return (
    <>
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
          onCancel();
          if (a) void access.reissue(a);
        }}
        onCancel={onCancel}
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
