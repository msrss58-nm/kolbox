import { KeyRound, ListChecks } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import { OneTimeLinkBox } from "./OneTimeLinkBox";
import type { OwnerAccessApproval } from "./platformOwnerClient";
import type { useOwnerAccess } from "./useOwnerAccess";

const text = PLATFORM_OWNER_TEXT.ownerAccess;

function StatePill({ state }: { state: OwnerAccessApproval["state"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
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
 * Stage 8B: every Election Owner approval, with the one recovery action the
 * business rules allow. Active -> a new one-time link (window unchanged);
 * expired -> renew the window and issue a link; consumed -> read-only (the
 * Owner has provisioned - one Owner per workspace). Both actions go through a
 * confirmation because a new link invalidates any link handed out earlier.
 *
 * The server decides; this list only offers what the stated row permits and
 * refetches after every attempt.
 */
export function OwnerAccessListCard({
  access,
}: {
  access: ReturnType<typeof useOwnerAccess>;
}) {
  const [confirm, setConfirm] = useState<OwnerAccessApproval | null>(null);

  return (
    <>
      <Card className="space-y-4">
        <div className="flex items-center gap-2">
          <ListChecks className="size-5 text-slate-700" />
          <CardTitle>{text.title}</CardTitle>
        </div>
        <p className="text-sm text-slate-600">{text.subtitle}</p>

        {access.issued && (
          <div
            className="space-y-2 rounded-xl bg-primary-50/40 p-3 ring-1 ring-primary-200"
            data-testid="owner-access-issued"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary-600" aria-hidden />
              <p className="text-sm font-bold text-slate-800">
                {text.linkTitle(access.issued.name)}
              </p>
            </div>
            {access.issued.renewed && (
              <p className="text-sm text-slate-700">{text.renewedNote}</p>
            )}
            {access.issued.link ? (
              <>
                <OneTimeLinkBox link={access.issued.link} />
                <p className="text-xs text-slate-500">
                  {PLATFORM_OWNER_TEXT.approveOwner.linkHint}
                </p>
              </>
            ) : (
              <p role="alert" className="text-sm text-opponent">
                {text.linkMissing}
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={access.dismissIssued}
            >
              {text.dismiss}
            </Button>
          </div>
        )}

        {access.readError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm font-medium text-opponent">
              {access.readError}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void access.reload()}>
              {text.retry}
            </Button>
          </div>
        )}

        {!access.readError && access.loading && access.approvals.length === 0 && (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!access.readError && !access.loading && access.approvals.length === 0 && (
          <EmptyState dense icon={ListChecks} title={text.empty} />
        )}

        {!access.readError && access.approvals.length > 0 && (
          <ul className="space-y-2" data-testid="owner-access-list">
            {access.approvals.map((a) => {
              const busy = access.busyId === a.pendingId;
              const error = access.errorFor(a.pendingId);
              return (
                <li
                  key={a.pendingId}
                  className="space-y-2 rounded-xl bg-white p-3 ring-1 ring-slate-200"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-bold break-words text-slate-800">{a.name}</p>
                        <StatePill state={a.state} />
                      </div>
                      <LtrValue
                        value={a.email}
                        mono={false}
                        className="text-sm text-slate-600"
                      />
                      <p className="text-xs text-slate-500">{dateLine(a)}</p>
                      {a.workspaceName && (
                        <p className="text-xs font-semibold text-slate-600">
                          {text.workspace(a.workspaceName)}
                        </p>
                      )}
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
        )}
      </Card>

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
    </>
  );
}
