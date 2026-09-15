import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Modal } from "../../components/ui/Modal";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import type { ModuleCatalogEntry } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.moduleAvailability;

/**
 * Gate 4: the Platform Owner's GLOBAL module availability switch - the
 * platform-wide kill switch, deliberately separate from the per-workspace
 * entitlement editor (WorkspaceModulesEditDialog). Effective access = available
 * here AND the workspace's entitlement; switching never adds or removes an
 * entitlement. Only a module the server marks switchable gets a control. The
 * server validates, applies and audits every change - this dialog only asks,
 * then confirms, and always shows the refetched state.
 */
export function ModuleAvailabilityDialog({
  catalog,
  busyKey,
  errorFor,
  onSet,
  onClose,
}: {
  catalog: ModuleCatalogEntry[];
  /** The module whose switch is in flight, if any. */
  busyKey: string | null;
  /** The server's refusal for this module, if its last switch failed. */
  errorFor: (key: string) => string | null;
  /** Resolves true only when the server confirmed the new state. */
  onSet: (key: string, available: boolean) => Promise<boolean>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<ModuleCatalogEntry | null>(null);
  const [changedKey, setChangedKey] = useState<string | null>(null);
  const busy = busyKey !== null;
  const pendingLabel = pending ? moduleLabel(pending.key) : "";

  return (
    <>
      <Modal open title={text.title} onClose={busy ? () => {} : onClose}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{text.subtitle}</p>
          <ul className="grid gap-2" data-testid="module-availability-list">
            {catalog.map((m) => {
              const error = errorFor(m.key);
              return (
                <li
                  key={m.key}
                  data-testid={`module-availability-${m.key}`}
                  data-available={m.available ? "true" : "false"}
                  className="space-y-2 rounded-xl p-3 ring-1 ring-slate-200"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-800">
                      {moduleLabel(m.key)}
                    </span>
                    <span
                      data-testid="module-availability-state"
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                        m.available
                          ? "bg-supporter-soft text-emerald-800"
                          : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {m.available ? text.available : text.unavailable}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {text.entitled(m.entitledWorkspaces)}
                  </p>
                  {m.availabilitySwitchable ? (
                    <Button
                      size="sm"
                      variant={m.available ? "secondary" : "primary"}
                      loading={busyKey === m.key}
                      disabled={busy}
                      onClick={() => {
                        setChangedKey(null);
                        setPending(m);
                      }}
                      className="w-full max-sm:h-11 sm:w-auto"
                      data-testid={`module-availability-toggle-${m.key}`}
                    >
                      {m.available ? text.disable : text.enable}
                    </Button>
                  ) : (
                    <p className="text-xs text-slate-400">{text.fixed}</p>
                  )}
                  {error && (
                    <p role="alert" className="text-sm font-medium text-opponent">
                      {error}
                    </p>
                  )}
                  {changedKey === m.key && (
                    <p role="status" className="text-sm font-medium text-emerald-700">
                      {text.changed}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <Button
            variant="secondary"
            className="w-full"
            onClick={onClose}
            disabled={busy}
          >
            {text.close}
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.available
            ? text.confirmDisableTitle(pendingLabel)
            : text.confirmEnableTitle(pendingLabel)
        }
        message={
          pending?.available
            ? text.confirmDisableMessage(pendingLabel, pending.entitledWorkspaces)
            : text.confirmEnableMessage(pendingLabel, pending?.entitledWorkspaces ?? 0)
        }
        confirmLabel={pending?.available ? text.disable : text.enable}
        danger={pending?.available === true}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (!target) return;
          // The explicit target state, never a blind toggle: a stale view that
          // asks for the current state is a confirmed server-side no-op.
          void onSet(target.key, !target.available).then((ok) => {
            if (ok) setChangedKey(target.key);
          });
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
