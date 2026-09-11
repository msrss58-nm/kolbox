import { Building2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, CardTitle } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { MultiEntityWorkspaceRow } from "./MultiEntityWorkspaceRow";
import type { MultiEntityWorkspace } from "./platformOwnerClient";
import { BUSY } from "./useMultiEntityManagement";

const text = PLATFORM_OWNER_TEXT.multiEntity.workspaces;

/** Filters appear only once the list is long enough for them to help. Below
 * this, a search box is pure chrome over a list you can already see whole. */
const FILTER_THRESHOLD = 8;

/**
 * Every workspace, with its assignment state.
 *
 * Assign is a plain action; UNASSIGN goes through a confirmation, because it
 * silently removes visibility of a tenant and is easy to hit by accident on a
 * phone. It is not `danger`, though - it is fully reversible by re-assigning,
 * and reserving red for the two irreversible Auth purges keeps that signal
 * meaningful.
 *
 * With no seat provisioned the rows stay visible but their actions are inert,
 * mirroring the server, which answers D-7 with
 * MULTI_ENTITY_OWNER_NOT_PROVISIONED. Showing the list read-only explains what
 * the seat is FOR far better than an empty screen would.
 */
export function MultiEntityWorkspaceList({
  workspaces,
  loading,
  hasSeat,
  assignedCount,
  isBusy,
  anyBusy,
  errorFor,
  onAssign,
  onUnassign,
}: {
  workspaces: MultiEntityWorkspace[];
  loading: boolean;
  hasSeat: boolean;
  assignedCount: number;
  isBusy: (key: string) => boolean;
  anyBusy: boolean;
  errorFor: (key: string) => string | null;
  onAssign: (workspaceId: string) => void;
  onUnassign: (workspaceId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyAssigned, setOnlyAssigned] = useState(false);
  const [confirm, setConfirm] = useState<MultiEntityWorkspace | null>(null);

  /** Names that appear more than once, so those rows can say so explicitly. */
  const duplicateNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const w of workspaces) {
      const k = w.name.trim();
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k));
  }, [workspaces]);

  const showFilters = workspaces.length >= FILTER_THRESHOLD;

  const visible = useMemo(() => {
    if (!showFilters) return workspaces;
    const q = query.trim().toLowerCase();
    return workspaces.filter((w) => {
      if (onlyAssigned && !w.isAssigned) return false;
      if (!q) return true;
      return w.name.toLowerCase().includes(q) || w.loginCode.toLowerCase().includes(q);
    });
  }, [workspaces, query, onlyAssigned, showFilters]);

  return (
    <>
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Building2 className="size-5 text-slate-700" />
            <CardTitle>{text.title}</CardTitle>
          </div>
          {!loading && workspaces.length > 0 && (
            <span className="text-xs font-semibold text-slate-500">
              {text.count(assignedCount, workspaces.length)}
            </span>
          )}
        </div>

        {!loading && !hasSeat && workspaces.length > 0 && (
          <p className="rounded-xl bg-slate-50 p-3 text-sm font-semibold text-slate-600 ring-1 ring-slate-200">
            {text.blocked}
          </p>
        )}

        {loading && (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!loading && workspaces.length === 0 && (
          <EmptyState dense icon={Building2} title={text.empty} />
        )}

        {!loading && showFilters && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={text.search}
              aria-label={text.search}
            />
            <label className="flex touch-target shrink-0 items-center gap-2 text-sm font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={onlyAssigned}
                onChange={(e) => setOnlyAssigned(e.target.checked)}
                className="size-4 rounded border-slate-300"
              />
              {text.onlyAssigned}
            </label>
          </div>
        )}

        {!loading && workspaces.length > 0 && visible.length === 0 && (
          <p className="py-4 text-center text-sm text-slate-500">{text.noResults}</p>
        )}

        {!loading && visible.length > 0 && (
          <ul className="space-y-2">
            {visible.map((w) => {
              const key = BUSY.workspace(w.workspaceId);
              const busy = isBusy(key);
              return (
                <MultiEntityWorkspaceRow
                  key={w.workspaceId}
                  workspace={w}
                  duplicateName={duplicateNames.has(w.name.trim())}
                  busy={busy}
                  disabled={!hasSeat || (anyBusy && !busy)}
                  blockedReason={null}
                  error={errorFor(key)}
                  onAssign={() => onAssign(w.workspaceId)}
                  onUnassign={() => setConfirm(w)}
                />
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={text.confirmUnassignTitle}
        message={
          confirm ? text.confirmUnassignMessage(confirm.name, confirm.loginCode) : ""
        }
        confirmLabel={text.confirmUnassign}
        busy={confirm ? isBusy(BUSY.workspace(confirm.workspaceId)) : false}
        onConfirm={() => {
          const w = confirm;
          setConfirm(null);
          if (w) onUnassign(w.workspaceId);
        }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
