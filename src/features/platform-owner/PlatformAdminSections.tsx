import { useMemo, useState, type ReactNode } from "react";
import { Blocks, Building2, ListChecks, ScrollText, UserPlus } from "lucide-react";
import { AdminListFrame, AdminSection } from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { EmptyState } from "../../components/ui/EmptyState";
import { Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import { OwnerAccessList } from "./OwnerAccessList";
import { OwnerApprovalDialog } from "./OwnerApprovalDialog";
import { usePlatformAdmin } from "./platformAdminContext";
import type { OwnerAccessApproval, WorkspaceEntitlements } from "./platformOwnerClient";
import { usePlatformOwnerSession } from "./platformOwnerSession";
import { useMultiEntityManagement } from "./useMultiEntityManagement";
import { WorkspaceModulesEditDialog } from "./WorkspaceModulesEditDialog";

const T = PLATFORM_OWNER_TEXT;

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm font-medium text-opponent">
        {message}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {T.ownerAccess.retry}
      </Button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

function ModuleChips({ modules }: { modules: string[] }) {
  if (modules.length === 0) {
    return <span className="text-xs text-slate-400">{T.workspaceModules.none}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {modules.map((m) => (
        <span
          key={m}
          className="rounded-full bg-supporter-soft px-2 py-0.5 text-xs font-semibold text-emerald-800"
        >
          {moduleLabel(m)}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

type StateFilter = "" | OwnerAccessApproval["state"];

/** Election Owner approvals: approve (dialog), list, re-issue / renew. */
export function PlatformOwnersSection() {
  const { access, workspaceModules } = usePlatformAdmin();
  const [approveOpen, setApproveOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return access.approvals.filter(
      (a) =>
        (!stateFilter || a.state === stateFilter) &&
        (!q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)),
    );
  }, [access.approvals, query, stateFilter]);

  const hasRows = access.approvals.length > 0;

  return (
    <>
      <AdminSection
        testId="platform-owners-section"
        title={T.owners.title}
        description={T.ownerAccess.subtitle}
        actions={
          <Button onClick={() => setApproveOpen(true)}>
            <UserPlus className="size-4" aria-hidden />
            {T.owners.approve}
          </Button>
        }
        toolbar={
          hasRows ? (
            <>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={T.owners.search}
                aria-label={T.owners.search}
                className="h-10 min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
              />
              <Select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value as StateFilter)}
                aria-label={T.owners.filterLabel}
                className="h-10 w-36 shrink-0 sm:w-48"
              >
                <option value="">{T.owners.filterAll}</option>
                <option value="active">{T.ownerAccess.states.active}</option>
                <option value="expired">{T.ownerAccess.states.expired}</option>
                <option value="consumed">{T.ownerAccess.states.consumed}</option>
              </Select>
              <span className="text-xs font-semibold text-slate-500" role="status">
                {T.owners.count(visible.length, access.approvals.length)}
              </span>
            </>
          ) : undefined
        }
      >
        {access.readError ? (
          <LoadError message={access.readError} onRetry={() => void access.reload()} />
        ) : access.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <EmptyState dense icon={ListChecks} title={T.ownerAccess.empty} />
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">{T.owners.noResults}</p>
        ) : (
          <OwnerAccessList access={access} approvals={visible} />
        )}
      </AdminSection>

      {approveOpen && (
        <OwnerApprovalDialog
          onChanged={() => void access.reload()}
          onClose={() => setApproveOpen(false)}
          catalog={workspaceModules.catalog}
          catalogError={workspaceModules.readError !== null}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Module entitlements (shared edit flow)
// ---------------------------------------------------------------------------

/** The edit dialog wired to the shell's single `useWorkspaceModules` instance,
 * reporting success back so the caller can confirm inline on its own row. */
function useModulesEditor() {
  const { workspaceModules } = usePlatformAdmin();
  const [editing, setEditing] = useState<WorkspaceEntitlements | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const open = (w: WorkspaceEntitlements) => {
    setSavedId(null);
    setEditing(w);
  };

  const dialog = editing ? (
    <WorkspaceModulesEditDialog
      workspace={editing}
      catalog={workspaceModules.catalog}
      saving={workspaceModules.savingId === editing.workspaceId}
      error={workspaceModules.errorFor(editing.workspaceId)}
      onSave={async (modules) => {
        const ok = await workspaceModules.save(editing.workspaceId, modules);
        if (ok) setSavedId(editing.workspaceId);
        return ok;
      }}
      onClose={() => setEditing(null)}
    />
  ) : null;

  return { open, dialog, savedId };
}

function matchesWorkspace(w: WorkspaceEntitlements, q: string, extra = ""): boolean {
  if (!q) return true;
  return [w.name, w.ownerName ?? "", w.ownerEmail ?? "", extra]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/** Module assignment: every workspace's entitlements, with the confirmed,
 * audited edit (Stage 9 flow, unchanged server-side). */
export function PlatformModulesSection() {
  const { workspaceModules: modules } = usePlatformAdmin();
  const editor = useModulesEditor();
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules.workspaces.filter((w) => matchesWorkspace(w, q));
  }, [modules.workspaces, query]);

  const hasRows = modules.workspaces.length > 0;

  return (
    <>
      <AdminSection
        testId="workspace-modules-card"
        title={T.modulesSection.title}
        description={T.workspaceModules.subtitle}
        toolbar={
          hasRows ? (
            <>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={T.modulesSection.search}
                aria-label={T.modulesSection.search}
                className="h-10 min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
              />
              <span className="text-xs font-semibold text-slate-500" role="status">
                {T.workspaces.count(visible.length, modules.workspaces.length)}
              </span>
            </>
          ) : undefined
        }
      >
        {modules.readError ? (
          <LoadError message={modules.readError} onRetry={() => void modules.reload()} />
        ) : modules.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <EmptyState dense icon={Blocks} title={T.workspaceModules.empty} />
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            {T.workspaces.noResults}
          </p>
        ) : (
          <AdminListFrame>
            <ul
              className="divide-y divide-slate-100"
              data-testid="workspace-modules-list"
            >
              {visible.map((w) => {
                const error = modules.errorFor(w.workspaceId);
                return (
                  <li key={w.workspaceId} className="space-y-1.5 px-4 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <div className="min-w-0 space-y-1">
                        <p className="font-bold break-words text-slate-800" dir="auto">
                          {w.name}
                        </p>
                        {w.ownerName && (
                          <p className="text-xs text-slate-500">
                            {T.workspaceModules.owner(w.ownerName)}
                          </p>
                        )}
                        <p className="text-sm text-slate-700">
                          {w.modules.length > 0
                            ? w.modules.map(moduleLabel).join(" · ")
                            : T.workspaceModules.none}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={modules.savingId !== null}
                        onClick={() => editor.open(w)}
                        className="w-full shrink-0 sm:w-auto"
                      >
                        {T.workspaceModules.edit}
                      </Button>
                    </div>
                    {error && (
                      <p role="alert" className="text-sm font-medium text-opponent">
                        {error}
                      </p>
                    )}
                    {editor.savedId === w.workspaceId && (
                      <p role="status" className="text-sm font-medium text-emerald-700">
                        {T.workspaceModules.saved}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </AdminListFrame>
        )}
      </AdminSection>
      {editor.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5 border-b border-slate-100 py-2.5 last:border-0">
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold break-words text-slate-800">{children}</dd>
    </div>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        active ? "bg-supporter-soft text-emerald-800" : "bg-slate-100 text-slate-600",
      )}
    >
      {active ? T.multiEntity.workspaces.active : T.multiEntity.workspaces.ended}
    </span>
  );
}

/**
 * Workspaces: one row per workspace, joined from the two existing reads - the
 * entitlement read (name, Owner, modules, end date) and the Multi-Entity state
 * read (login code, server-derived active/ended, seat assignment). No new
 * endpoint. If the second read fails, those columns say "not available".
 */
export function PlatformWorkspacesSection() {
  const { workspaceModules: modules } = usePlatformAdmin();
  const me = useMultiEntityManagement();
  const editor = useModulesEditor();
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const meById = useMemo(
    () => new Map(me.workspaces.map((w) => [w.workspaceId, w])),
    [me.workspaces],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules.workspaces.filter((w) =>
      matchesWorkspace(w, q, meById.get(w.workspaceId)?.loginCode ?? ""),
    );
  }, [modules.workspaces, meById, query]);

  const detail = modules.workspaces.find((w) => w.workspaceId === detailId) ?? null;
  const detailMe = detail ? meById.get(detail.workspaceId) : undefined;
  const hasRows = modules.workspaces.length > 0;
  const W = T.workspaces;

  return (
    <>
      <AdminSection
        testId="platform-workspaces-section"
        title={W.title}
        description={W.description}
        toolbar={
          hasRows ? (
            <>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={W.search}
                aria-label={W.search}
                className="h-10 min-w-0 flex-1 basis-44 sm:w-80 sm:flex-none"
              />
              <span className="text-xs font-semibold text-slate-500" role="status">
                {W.count(visible.length, modules.workspaces.length)}
              </span>
            </>
          ) : undefined
        }
      >
        {modules.readError ? (
          <LoadError message={modules.readError} onRetry={() => void modules.reload()} />
        ) : modules.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <EmptyState dense icon={Building2} title={W.empty} />
        ) : visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">{W.noResults}</p>
        ) : (
          <AdminListFrame>
            <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_6rem_minmax(0,1.2fr)_auto] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-bold text-slate-500 lg:grid">
              <span>{W.columns.name}</span>
              <span>{W.columns.owner}</span>
              <span>{W.columns.status}</span>
              <span>{W.columns.modules}</span>
              <span className="w-16" />
            </div>
            <ul className="divide-y divide-slate-100" data-testid="workspaces-list">
              {visible.map((w) => {
                const m = meById.get(w.workspaceId);
                return (
                  <li
                    key={w.workspaceId}
                    className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_6rem_minmax(0,1.2fr)_auto] lg:items-center lg:gap-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-800" dir="auto">
                        {w.name}
                      </p>
                      {m && (
                        <LtrValue
                          value={m.loginCode}
                          className="text-xs text-slate-500"
                        />
                      )}
                    </div>
                    <p className="min-w-0 truncate text-sm text-slate-600" dir="auto">
                      {w.ownerName ?? W.noOwner}
                    </p>
                    <div>
                      {m ? (
                        <StatusPill active={m.isActive} />
                      ) : (
                        <span className="text-xs text-slate-400">{W.notAvailable}</span>
                      )}
                    </div>
                    <ModuleChips modules={w.modules} />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setDetailId(w.workspaceId)}
                      aria-label={W.detailsAria(w.name)}
                      className="w-full lg:w-16"
                    >
                      {W.details}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </AdminListFrame>
        )}
      </AdminSection>

      <Drawer
        open={detail !== null}
        onClose={() => setDetailId(null)}
        title={detail?.name ?? ""}
        footer={
          detail && (
            <Button
              className="w-full"
              disabled={modules.savingId !== null}
              onClick={() => {
                // Close the drawer first - its Escape handler is not
                // stack-aware, so it must not sit under the edit dialog.
                setDetailId(null);
                editor.open(detail);
              }}
            >
              {W.editModules}
            </Button>
          )
        }
      >
        {detail && (
          <dl>
            <DetailRow label={W.ownerLabel}>{detail.ownerName ?? W.noOwner}</DetailRow>
            <DetailRow label={W.ownerEmailLabel}>
              {detail.ownerEmail ? (
                <LtrValue value={detail.ownerEmail} mono={false} />
              ) : (
                W.noOwner
              )}
            </DetailRow>
            <DetailRow label={W.codeLabel}>
              {detailMe ? <LtrValue value={detailMe.loginCode} /> : W.notAvailable}
            </DetailRow>
            <DetailRow label={W.statusLabel}>
              {detailMe ? <StatusPill active={detailMe.isActive} /> : W.notAvailable}
            </DetailRow>
            <DetailRow label={W.endLabel}>
              {formatDateTime(detail.electionEndAt)}
            </DetailRow>
            <DetailRow label={W.modulesLabel}>
              <ModuleChips modules={detail.modules} />
            </DetailRow>
            <DetailRow label={W.multiEntityLabel}>
              {detailMe
                ? detailMe.isAssigned
                  ? T.multiEntity.workspaces.assigned
                  : T.multiEntity.workspaces.unassigned
                : W.notAvailable}
            </DetailRow>
          </dl>
        )}
      </Drawer>
      {editor.dialog}
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit + Settings
// ---------------------------------------------------------------------------

/** No read API for the entitlement audit exists yet - this section says so
 * rather than inventing one (a backend read is a separate, future task). */
export function PlatformAuditSection() {
  return (
    <AdminSection testId="platform-audit-section" title={T.audit.title}>
      <EmptyState icon={ScrollText} title={T.audit.emptyTitle} hint={T.audit.emptyHint} />
    </AdminSection>
  );
}

function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd dir="ltr" className="text-start text-sm font-semibold break-all text-slate-800">
        {value}
      </dd>
    </div>
  );
}

/** Settings: the verified identity - read-only. */
export function PlatformSettingsSection() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const c = T.console;
  return (
    <AdminSection
      testId="platform-settings-section"
      title={T.settings.title}
      description={T.settings.description}
    >
      <div className="max-w-2xl space-y-3">
        <AdminListFrame>
          <dl className="divide-y divide-slate-100">
            <IdentityRow label={c.emailLabel} value={owner?.email ?? ""} />
            <IdentityRow label={c.ownerIdLabel} value={owner?.platformOwnerId ?? ""} />
            <IdentityRow label={c.mfaLabel} value={c.mfaValue} />
          </dl>
        </AdminListFrame>
        <p className="text-xs text-slate-500">{c.stageNote}</p>
      </div>
    </AdminSection>
  );
}
