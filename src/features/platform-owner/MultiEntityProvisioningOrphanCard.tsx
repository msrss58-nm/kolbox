import { UserX } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import type { PendingProvisioningOrphan } from "./platformOwnerClient";
import { BUSY, type ActionNotice } from "./useMultiEntityManagement";

const text = PLATFORM_OWNER_TEXT.multiEntity.orphanCleanup;

/**
 * Auth accounts left behind by a provisioning attempt that FAILED - the
 * account was created, the seat was not, and the compensating delete could not
 * be confirmed.
 *
 * Visibly distinct from the replacement-cleanup card (amber rather than red,
 * different icon, different heading) because the business meaning is
 * different: nothing was ever replaced, no owner was displaced, and no
 * assignment moved. It is simply a stranded login that never became anything.
 *
 * Sourced only from the durable `pendingProvisioningOrphans` queue, which is
 * derived from immutable write-ahead audit rows - so it survives reload and
 * session loss, and the operator can never be asked to remember or retype an
 * id. The `attemptedEmail` snapshot is shown so a permanent deletion is
 * confirmed against a recognisable identity rather than a bare UUID.
 */
export function MultiEntityProvisioningOrphanCard({
  items,
  isBusy,
  anyBusy,
  errorFor,
  noticeFor,
  onPurge,
}: {
  items: PendingProvisioningOrphan[];
  isBusy: (key: string) => boolean;
  anyBusy: boolean;
  errorFor: (key: string) => string | null;
  noticeFor: (key: string) => ActionNotice | null;
  onPurge: (authUserId: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (items.length === 0) return null;

  return (
    <>
      <Card className="space-y-4 ring-1 ring-amber-300">
        <div className="flex items-center gap-2">
          <UserX className="size-5 shrink-0 text-amber-700" />
          <CardTitle className="text-amber-900">{text.title}</CardTitle>
        </div>

        <p className="text-sm text-slate-600">{text.body}</p>
        {items.length > 1 && (
          <p className="text-xs font-semibold text-slate-500">
            {text.count(items.length)}
          </p>
        )}

        <ul className="space-y-3">
          {items.map((item) => {
            const key = BUSY.orphanPurge(item.authUserId);
            const busy = isBusy(key);
            const err = errorFor(key);
            const notice = noticeFor(key);
            return (
              <li
                key={item.authUserId}
                className="space-y-2 rounded-xl bg-potential-soft/50 p-3 ring-1 ring-amber-200"
              >
                <p className="text-xs font-semibold text-slate-500">{text.emailLabel}</p>
                {item.attemptedEmail ? (
                  <LtrValue
                    value={item.attemptedEmail}
                    mono={false}
                    className="text-sm font-semibold text-slate-800"
                  />
                ) : (
                  <p className="text-sm text-slate-500">{text.noEmail}</p>
                )}

                <p className="text-xs font-semibold text-slate-500">{text.idLabel}</p>
                <LtrValue value={item.authUserId} className="text-xs text-slate-800" />

                <p className="text-xs text-slate-500">
                  {text.mintedAt(formatDateTime(item.mintedAt))}
                </p>
                {item.failureCount > 0 && (
                  <p className="text-xs font-semibold text-amber-800">
                    {text.failures(
                      item.failureCount,
                      formatDateTime(item.lastCleanupAttemptAt),
                    )}
                  </p>
                )}

                {err && (
                  <p role="alert" className="text-sm font-medium text-opponent">
                    {err}
                  </p>
                )}
                {notice && (
                  <p
                    role="alert"
                    className={
                      notice.tone === "warning"
                        ? "text-sm font-medium text-amber-800"
                        : "text-sm font-medium text-supporter"
                    }
                  >
                    {notice.message}
                  </p>
                )}

                <Button
                  variant="danger"
                  size="sm"
                  loading={busy}
                  disabled={anyBusy && !busy}
                  onClick={() => setConfirmId(item.authUserId)}
                  className="w-full sm:w-auto"
                >
                  {text.action}
                </Button>
              </li>
            );
          })}
        </ul>
      </Card>

      <ConfirmDialog
        open={confirmId !== null}
        danger
        title={text.confirmTitle}
        message={confirmId ? text.confirmMessage(confirmId) : ""}
        confirmLabel={text.confirm}
        busy={confirmId ? isBusy(BUSY.orphanPurge(confirmId)) : false}
        onConfirm={() => {
          const id = confirmId;
          setConfirmId(null);
          if (id) onPurge(id);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </>
  );
}
