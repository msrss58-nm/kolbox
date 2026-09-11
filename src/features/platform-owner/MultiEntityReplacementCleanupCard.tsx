import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import type { PendingAuthCleanup } from "./platformOwnerClient";
import { BUSY, type ActionNotice } from "./useMultiEntityManagement";

const text = PLATFORM_OWNER_TEXT.multiEntity.replacementCleanup;

/**
 * Auth accounts displaced from the seat by a replacement and never purged.
 *
 * The list comes ONLY from `pendingAuthCleanup` - the server-derived, durable,
 * audit-backed queue - never from the provision response. That is the whole
 * point of Stage 4B: this card is still here after a reload, a new session, or
 * a different browser, and the operator has no way to lose the id.
 *
 * There is no manual id entry anywhere, by design. Every id shown here is one
 * the server already vouched for; nothing the operator types can reach the
 * destructive path.
 *
 * Deliberately a SEPARATE card from the provisioning-orphan one. Both delete
 * an Auth account, but they describe different business facts, are bound by
 * different evidence, and call different endpoints - merging them would let
 * one path's guarantees appear to justify the other path's deletion.
 */
export function MultiEntityReplacementCleanupCard({
  items,
  isBusy,
  anyBusy,
  errorFor,
  noticeFor,
  onPurge,
}: {
  items: PendingAuthCleanup[];
  isBusy: (key: string) => boolean;
  anyBusy: boolean;
  errorFor: (key: string) => string | null;
  noticeFor: (key: string) => ActionNotice | null;
  onPurge: (previousAuthUserId: string) => void;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (items.length === 0) return null;

  const many = items.length > 1;

  return (
    <>
      <Card className="space-y-4 ring-1 ring-opponent/30">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-5 shrink-0 text-opponent" />
          <CardTitle className="text-opponent">
            {many ? text.titleMany : text.titleOne}
          </CardTitle>
        </div>

        <p className="text-sm text-slate-600">{text.body}</p>
        {many && (
          <p className="text-xs font-semibold text-slate-500">
            {text.count(items.length)}
          </p>
        )}

        <ul className="space-y-3">
          {items.map((item) => {
            const key = BUSY.replacementPurge(item.previousAuthUserId);
            const busy = isBusy(key);
            const err = errorFor(key);
            const notice = noticeFor(key);
            return (
              <li
                key={item.previousAuthUserId}
                className="space-y-2 rounded-xl bg-opponent-soft/40 p-3 ring-1 ring-opponent/20"
              >
                <p className="text-xs font-semibold text-slate-500">{text.idLabel}</p>
                <LtrValue
                  value={item.previousAuthUserId}
                  className="text-xs text-slate-800"
                />
                <p className="text-xs text-slate-500">
                  {text.replacedAt(formatDateTime(item.replacedAt))}
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
                  onClick={() => setConfirmId(item.previousAuthUserId)}
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
        busy={confirmId ? isBusy(BUSY.replacementPurge(confirmId)) : false}
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
