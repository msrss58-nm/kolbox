import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Blocks, Building2, ListChecks, Power, ScrollText, UserPlus } from "lucide-react";
import {
  AdminListFrame,
  AdminSearch,
  AdminSection,
} from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { Drawer } from "../../components/ui/Drawer";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { moduleLabel } from "../../constants/labels";
import { cn } from "../../lib/utils";
import { toast } from "../../components/ui/Toast";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { setOwnUsername } from "./platformOwnerClient";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { ModuleAvailabilityDialog } from "./ModuleAvailabilityDialog";
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
    <div className="space-y-2 p-4">
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
    <div className="space-y-2 p-4" aria-hidden>
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/** An empty / no-results state, centered inside a section's data panel. */
function PanelCentered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
      {children}
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
              <AdminSearch
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={T.owners.search}
                aria-label={T.owners.search}
                className="min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
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
            </>
          ) : undefined
        }
        count={
          hasRows ? T.owners.count(visible.length, access.approvals.length) : undefined
        }
        panel
      >
        {access.readError ? (
          <LoadError message={access.readError} onRetry={() => void access.reload()} />
        ) : access.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <PanelCentered>
            <EmptyState dense icon={ListChecks} title={T.ownerAccess.empty} />
          </PanelCentered>
        ) : visible.length === 0 ? (
          <PanelCentered>{T.owners.noResults}</PanelCentered>
        ) : (
          <OwnerAccessList access={access} approvals={visible} />
        )}
      </AdminSection>

      {approveOpen && (
        <OwnerApprovalDialog
          // BOTH shell-level reads, not just the one this dialog sits in.
          // `useOwnerAccess` and `useWorkspaceModules` are mounted once by
          // PlatformAdminShell and every section is a sibling child route, so
          // nothing remounts on navigation: a list this dialog does not
          // refresh stays stale until the operator presses F5. Approving an
          // Owner creates an approval AND is the act that a workspace and its
          // module entitlements follow from, so the workspace/module lists
          // must be re-read too.
          onChanged={() => {
            void access.reload();
            void workspaceModules.reload();
          }}
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
 * audited edit (Stage 9 flow, unchanged server-side). Gate 4: the GLOBAL
 * availability switch is a separate action + dialog, never mixed into the
 * per-workspace editor. */
export function PlatformModulesSection() {
  const { workspaceModules: modules } = usePlatformAdmin();
  const editor = useModulesEditor();
  const [query, setQuery] = useState("");
  const [availabilityOpen, setAvailabilityOpen] = useState(false);

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
        actions={
          <Button
            variant="secondary"
            onClick={() => setAvailabilityOpen(true)}
            disabled={modules.catalog.length === 0}
            data-testid="module-availability-open"
          >
            <Power className="size-4" aria-hidden />
            {T.moduleAvailability.open}
          </Button>
        }
        toolbar={
          hasRows ? (
            <AdminSearch
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={T.modulesSection.search}
              aria-label={T.modulesSection.search}
              className="min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
            />
          ) : undefined
        }
        count={
          hasRows
            ? T.workspaces.count(visible.length, modules.workspaces.length)
            : undefined
        }
        panel
      >
        {modules.readError ? (
          <LoadError message={modules.readError} onRetry={() => void modules.reload()} />
        ) : modules.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <PanelCentered>
            <EmptyState dense icon={Blocks} title={T.workspaceModules.empty} />
          </PanelCentered>
        ) : visible.length === 0 ? (
          <PanelCentered>{T.workspaces.noResults}</PanelCentered>
        ) : (
          <ul
            className="space-y-2.5 md:space-y-0 md:divide-y md:divide-slate-100 md:border-b md:border-slate-100"
            data-testid="workspace-modules-list"
          >
            {visible.map((w) => {
              const error = modules.errorFor(w.workspaceId);
              return (
                <li
                  key={w.workspaceId}
                  className="space-y-1.5 rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-slate-200 transition-colors md:rounded-none md:bg-transparent md:px-4 md:py-3 md:shadow-none md:ring-0 md:hover:bg-slate-50 lg:px-6"
                >
                  {/* The action sits right after the details, not at the far
                      edge of the working area. */}
                  <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[minmax(0,40rem)_auto] sm:items-center sm:gap-x-7">
                    <div className="min-w-0 space-y-1">
                      {/* `bdi`: a Latin name keeps its own direction but
                          aligns with the RTL card. */}
                      <p className="font-bold break-words text-slate-800">
                        <bdi>{w.name}</bdi>
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
                      className="w-full shrink-0 max-sm:h-11 sm:w-auto"
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
        )}
      </AdminSection>
      {editor.dialog}
      {availabilityOpen && (
        <ModuleAvailabilityDialog
          catalog={modules.catalog}
          busyKey={modules.availabilityKey}
          errorFor={modules.availabilityErrorFor}
          onSet={modules.setAvailability}
          onClose={() => setAvailabilityOpen(false)}
        />
      )}
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
            <AdminSearch
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={W.search}
              aria-label={W.search}
              className="min-w-0 flex-1 basis-44 sm:w-80 sm:flex-none"
            />
          ) : undefined
        }
        count={hasRows ? W.count(visible.length, modules.workspaces.length) : undefined}
        panel
      >
        {modules.readError ? (
          <LoadError message={modules.readError} onRetry={() => void modules.reload()} />
        ) : modules.loading && !hasRows ? (
          <ListSkeleton />
        ) : !hasRows ? (
          <PanelCentered>
            <EmptyState dense icon={Building2} title={W.empty} />
          </PanelCentered>
        ) : visible.length === 0 ? (
          <PanelCentered>{W.noResults}</PanelCentered>
        ) : (
          <>
            {/* Sticky: the data panel itself is the scroll region. */}
            <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,20rem)_minmax(0,14rem)_6rem_minmax(0,18rem)_auto] gap-3 border-b border-slate-200 bg-slate-50 px-6 py-2.5 text-xs font-bold text-slate-500 lg:grid lg:gap-x-6">
              <span>{W.columns.name}</span>
              <span>{W.columns.owner}</span>
              <span>{W.columns.status}</span>
              <span>{W.columns.modules}</span>
              <span className="w-16" />
            </div>
            <ul
              className="space-y-2.5 md:space-y-0 md:divide-y md:divide-slate-100 md:border-b md:border-slate-100"
              data-testid="workspaces-list"
            >
              {visible.map((w) => {
                const m = meById.get(w.workspaceId);
                return (
                  <li
                    key={w.workspaceId}
                    className="grid gap-2 rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-slate-200 transition-colors md:rounded-none md:bg-transparent md:px-4 md:py-3 md:shadow-none md:ring-0 md:hover:bg-slate-50 lg:grid-cols-[minmax(0,20rem)_minmax(0,14rem)_6rem_minmax(0,18rem)_auto] lg:items-center lg:gap-x-6 lg:px-6"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-800">
                        <bdi>{w.name}</bdi>
                      </p>
                      {m && (
                        <LtrValue
                          value={m.loginCode}
                          className="text-xs text-slate-500"
                        />
                      )}
                    </div>
                    {/* `bdi`: a Latin name keeps its own direction (isolated,
                        like dir="auto") while the cell aligns with the RTL row. */}
                    <p className="min-w-0 truncate text-sm text-slate-600">
                      <bdi>{w.ownerName ?? W.noOwner}</bdi>
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
                      className="w-full max-sm:h-11 lg:w-16"
                    >
                      {W.details}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
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
    <AdminSection testId="platform-audit-section" title={T.audit.title} panel>
      <PanelCentered>
        <EmptyState
          dense
          icon={ScrollText}
          title={T.audit.emptyTitle}
          hint={T.audit.emptyHint}
        />
      </PanelCentered>
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
            <IdentityRow
              label={c.usernameLabel}
              value={owner?.username ?? c.usernameUnset}
            />
            <IdentityRow label={c.mfaLabel} value={c.mfaValue} />
          </dl>
        </AdminListFrame>
        {owner && owner.username === null && <PlatformOwnerUsernameForm />}
        <p className="text-xs text-slate-500">{c.stageNote}</p>
      </div>
    </AdminSection>
  );
}

/**
 * Claims the Platform Owner's own application username - the identity the
 * dedicated /login/platform-owner screen resolves. Offered ONCE: the row above
 * replaces it as soon as a username exists, because a username is permanent
 * for the life of the principal.
 */
function PlatformOwnerUsernameForm() {
  const c = T.console;
  const refreshStatus = usePlatformOwnerSession((s) => s.refreshStatus);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || value.trim() === "") return;
    setBusy(true);
    setError(null);
    setSuggestion(null);
    try {
      const { data: sess } = await platformOwnerAuthClient.auth.getSession();
      const token = sess.session?.access_token ?? null;
      if (!token) {
        setError(c.usernameError);
        return;
      }
      const result = await setOwnUsername(token, value.trim());
      if (result.status === "ok") {
        toast.success(c.usernameSaved);
        // Re-resolve from the server rather than patching local state: the
        // username is now part of the verified session context.
        await refreshStatus();
        setOpen(false);
        return;
      }
      if (result.status === "taken") {
        setError(c.usernameTaken);
        setSuggestion(result.suggestion);
        return;
      }
      setError(result.status === "invalid" ? c.usernameInvalid : c.usernameError);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {c.usernameSet}
      </Button>
    );
  }

  return (
    <form
      onSubmit={(e) => void save(e)}
      className="space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200"
      data-testid="platform-owner-username-form"
    >
      <Field label={c.usernameLabel} error={error ?? undefined}>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={c.usernamePlaceholder}
          name="platform-owner-username"
          autoComplete="off"
          invalid={!!error}
          autoFocus
        />
        <p className="mt-1 text-xs text-slate-400">{c.usernameHint}</p>
      </Field>
      {suggestion && (
        <div className="space-y-2">
          <p className="text-xs text-slate-600">{c.usernameSuggestion(suggestion)}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(suggestion);
              setError(null);
              setSuggestion(null);
            }}
          >
            {c.usernameUseSuggestion}
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={value.trim() === ""}>
          {c.usernameSave}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
            setSuggestion(null);
          }}
        >
          {c.usernameCancel}
        </Button>
      </div>
    </form>
  );
}
