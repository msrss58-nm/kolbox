import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Building2, Power, ScrollText, UserPlus } from "lucide-react";
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
import { APP_CONFIG } from "../../constants/config";
import { moduleLabel } from "../../constants/labels";
import { useAsyncData } from "../../hooks/useAsyncData";
import { useVisibleInterval } from "../../hooks/useVisibleInterval";
import { cn } from "../../lib/utils";
import { toast } from "../../components/ui/Toast";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { changeOwnPassword, fetchActivity, setOwnUsername } from "./platformOwnerClient";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { validatePlatformOwnerPassword } from "./platformOwnerPasswordPolicy";
import { formatDateTime } from "./multiEntityFormat";
import { ModuleAvailabilityDialog } from "./ModuleAvailabilityDialog";
import { OwnerAccountDialog } from "./OwnerAccountDialog";
import { LtrValue } from "./MultiEntityLtrValue";
import {
  approvalActionLabel,
  approvalDateLine,
  ApprovalStatePill,
  OwnerAccessRecovery,
} from "./OwnerAccessRecovery";
import { OwnerApprovalDialog } from "./OwnerApprovalDialog";
import { usePlatformAdmin } from "./platformAdminContext";
import type {
  ActivityEvent,
  MultiEntityWorkspace,
  OwnerAccessApproval,
  WorkspaceEntitlements,
} from "./platformOwnerClient";
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
        if (ok) {
          setSavedId(editing.workspaceId);
          // The editor used to sit in a list that confirmed inline on the row
          // it had just changed. Opened from a system's details there is no
          // such row to return to, so the confirmation is a toast - otherwise
          // a save that worked would look like nothing happened.
          toast.success(T.workspaceModules.saved);
        }
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
 * THE ONE management section - every election system in the platform.
 *
 * It replaces two screens that were managing the same thing from opposite
 * ends: this list (systems that exist) and a separate "בעלי מערכות" screen
 * (owners approved to create one). An approval and the workspace it produces
 * are the SAME system at two points in its life, so they are one list here:
 * an approved owner appears the moment they are approved, as a system that
 * has not been created yet, and becomes an ordinary row once they sign in and
 * create it. Nothing else changes about either flow - the same reads, the
 * same server ops, the same authorization.
 *
 * Joined from the three existing reads, with no new endpoint: the entitlement
 * read (name, Owner, modules, end date), the approvals read (approval state,
 * dates, phone, requested modules, recovery, AND the server's own resolution
 * of which workspace the approval produced) and the Multi-Entity state read
 * (login code, server-derived active/ended, assignment count). If a read
 * fails, its columns say "not available" rather than guessing.
 */

/** What a row is doing right now - the single axis the filter works on.
 * `null` = the Multi-Entity read did not answer, so the system's own state is
 * genuinely unknown and must not be rendered as either value. */
type RowStatus = "active" | "ended" | "pending" | "expired" | "done" | null;

type UnifiedRow =
  | {
      kind: "workspace";
      id: string;
      status: RowStatus;
      ws: WorkspaceEntitlements;
      me: MultiEntityWorkspace | undefined;
      approval: OwnerAccessApproval | undefined;
    }
  | { kind: "approval"; id: string; status: RowStatus; approval: OwnerAccessApproval };

type StatusFilter = "" | Exclude<RowStatus, null>;

export function PlatformWorkspacesSection() {
  const { access, workspaceModules: modules } = usePlatformAdmin();
  const me = useMultiEntityManagement();
  const editor = useModulesEditor();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [confirmReissue, setConfirmReissue] = useState<OwnerAccessApproval | null>(null);
  /** The workspace whose OWNER is being edited, or null. */
  const [ownerEditFor, setOwnerEditFor] = useState<WorkspaceEntitlements | null>(null);

  const meById = useMemo(
    () => new Map(me.workspaces.map((w) => [w.workspaceId, w])),
    [me.workspaces],
  );

  const rows = useMemo<UnifiedRow[]>(() => {
    // WHICH WORKSPACE DOES AN APPROVAL BELONG TO? The server already answers
    // that, and its answer is the only authoritative one available here.
    //
    // The two reads share exactly ONE durable key - the Owner's `auth_user_id`,
    // unique on `election_workspace_pending_owner_access` AND on
    // `election_owners` - and `platform_list_owner_access` resolves the
    // workspace through it in the same transaction as the read, handing back
    // `workspaceName`. The e-mail address is NOT that key: it is a copy taken
    // from the approval at provisioning time, nothing keeps the two copies
    // equal afterwards, neither column is unique, a workspace may hold several
    // owner rows, and a workspace created by any path other than
    // `election_day_provision_workspace` carries whatever address that path
    // was given. Joining on the copy is what made an Owner who is already
    // inside their workspace read as "the system has not been created yet".
    //
    // So: `workspaceName` (or a consumed approval) DECIDES that a system
    // exists; the address is used only to tell two same-named workspaces
    // apart. An approval the server says has a workspace is never rendered as
    // one that does not - if this console cannot pin down which row it is, it
    // is left off entirely rather than shown as pending, because that
    // workspace is in the list already under its own name.
    const byName = new Map<string, WorkspaceEntitlements[]>();
    for (const ws of modules.workspaces) {
      const name = ws.name.trim();
      if (!name) continue;
      const same = byName.get(name);
      if (same) same.push(ws);
      else byName.set(name, [ws]);
    }

    const resolveWorkspace = (a: OwnerAccessApproval): WorkspaceEntitlements | null => {
      const named = byName.get((a.workspaceName ?? "").trim()) ?? [];
      if (named.length === 0) return null;
      if (named.length === 1) return named[0];
      // Workspace names are not unique. When several carry the name the server
      // resolved, the recorded address is the tie-breaker - the one thing that
      // can tell two same-named systems apart here.
      const mail = a.email.trim().toLowerCase();
      return (
        (mail
          ? named.find((w) => w.ownerEmail?.trim().toLowerCase() === mail)
          : undefined) ?? null
      );
    };

    /** A workspace row's approval, once resolved. Consumed wins, because that
     * is the approval the workspace actually came from. */
    const approvalFor = new Map<string, OwnerAccessApproval>();
    const attached = new Set<string>();
    /** The server says this approval has a workspace, but which row it is
     * cannot be determined here. NOT a pending system. */
    const unidentified = new Set<string>();

    for (const a of access.approvals) {
      const ws = resolveWorkspace(a);
      if (ws) {
        attached.add(a.pendingId);
        const prev = approvalFor.get(ws.workspaceId);
        if (!prev || (a.state === "consumed" && prev.state !== "consumed")) {
          approvalFor.set(ws.workspaceId, a);
        }
        continue;
      }
      if (a.workspaceName !== null || a.state === "consumed") {
        unidentified.add(a.pendingId);
      }
    }

    const workspaceRows: UnifiedRow[] = modules.workspaces.map((ws) => {
      const m = meById.get(ws.workspaceId);
      return {
        kind: "workspace",
        id: ws.workspaceId,
        status: m ? (m.isActive ? "active" : "ended") : null,
        ws,
        me: m,
        approval: approvalFor.get(ws.workspaceId),
      };
    });

    // What is left has genuinely produced no workspace - it is still a system
    // in the making, and it must not disappear.
    const approvalRows: UnifiedRow[] = access.approvals
      .filter((a) => !attached.has(a.pendingId) && !unidentified.has(a.pendingId))
      .map((a) => ({
        kind: "approval",
        id: `approval:${a.pendingId}`,
        status:
          a.state === "active" ? "pending" : a.state === "expired" ? "expired" : "done",
        approval: a,
      }));

    // Systems being set up come first: they are the ones waiting on an action.
    return [...approvalRows, ...workspaceRows];
  }, [access.approvals, modules.workspaces, meById]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (!q) return true;
      if (r.kind === "approval") {
        return [r.approval.name, r.approval.email, r.approval.workspaceName ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q);
      }
      return matchesWorkspace(
        r.ws,
        q,
        [r.me?.loginCode ?? "", r.approval?.email ?? ""].join(" "),
      );
    });
  }, [rows, query, statusFilter]);

  const detail = rows.find((r) => r.id === detailId) ?? null;
  const hasRows = rows.length > 0;
  const loading = modules.loading || access.loading;
  const readError = modules.readError ?? access.readError;
  const W = T.workspaces;

  const reloadAll = () => {
    void modules.reload();
    void access.reload();
  };

  // An approved Owner creates their workspace in THEIR browser, minutes later.
  // No callback in this tab can be told about that, and re-reading on
  // navigation does not help an operator who simply stays on this screen - so
  // the section revalidates its three server reads on a timer while the tab is
  // visible, and pauses completely while it is not. Nothing here is optimistic:
  // every field still comes from the server's own answer.
  useVisibleInterval(
    () => Promise.all([modules.reload(), access.reload(), me.reload()]),
    APP_CONFIG.platformConsoleRevalidateMs,
  );

  return (
    <>
      <AdminSection
        testId="platform-workspaces-section"
        title={W.title}
        description={W.description}
        actions={
          <Button onClick={() => setApproveOpen(true)} data-testid="approve-owner">
            <UserPlus className="size-4" aria-hidden />
            {W.approve}
          </Button>
        }
        toolbar={
          hasRows ? (
            <>
              <AdminSearch
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={W.search}
                aria-label={W.search}
                className="min-w-0 flex-1 basis-44 sm:w-80 sm:flex-none"
              />
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label={W.filterLabel}
                className="h-10 w-36 shrink-0 sm:w-52"
              >
                <option value="">{W.filterAll}</option>
                <option value="active">{W.filterActive}</option>
                <option value="ended">{W.filterEnded}</option>
                <option value="pending">{W.filterPending}</option>
                <option value="expired">{W.filterExpired}</option>
                <option value="done">{W.filterDone}</option>
              </Select>
            </>
          ) : undefined
        }
        count={hasRows ? W.count(visible.length, rows.length) : undefined}
        panel
      >
        {readError && !hasRows ? (
          // Only when there is nothing to show. Once rows are on screen a
          // failed BACKGROUND revalidation must leave them standing - the
          // alternative is a transient network blip replacing a working list
          // with an error panel while the operator is reading it.
          <LoadError message={readError} onRetry={reloadAll} />
        ) : loading && !hasRows ? (
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
            <div className="sticky top-0 z-10 hidden grid-cols-[minmax(0,20rem)_minmax(0,14rem)_8rem_minmax(0,16rem)_auto] gap-3 border-b border-slate-200 bg-slate-50 px-6 py-2.5 text-xs font-bold text-slate-500 lg:grid lg:gap-x-6">
              <span>{W.columns.name}</span>
              <span>{W.columns.owner}</span>
              <span>{W.columns.status}</span>
              <span>{W.columns.modules}</span>
              <span />
            </div>
            <ul
              className="space-y-2.5 md:space-y-0 md:divide-y md:divide-slate-100 md:border-b md:border-slate-100"
              data-testid="workspaces-list"
            >
              {visible.map((r) => {
                const recovery =
                  r.kind === "approval" ? approvalActionLabel(r.approval) : null;
                const busy =
                  r.kind === "approval" && access.busyId === r.approval.pendingId;
                const error =
                  r.kind === "approval" ? access.errorFor(r.approval.pendingId) : null;
                return (
                  <li
                    key={r.id}
                    data-testid="workspace-row"
                    data-kind={r.kind}
                    className="grid gap-2 rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-slate-200 transition-colors md:rounded-none md:bg-transparent md:px-4 md:py-3 md:shadow-none md:ring-0 md:hover:bg-slate-50 lg:grid-cols-[minmax(0,20rem)_minmax(0,14rem)_8rem_minmax(0,16rem)_auto] lg:items-center lg:gap-x-6 lg:px-6"
                  >
                    <div className="min-w-0">
                      {r.kind === "approval" ? (
                        <>
                          <p className="truncate font-bold text-slate-400">
                            {W.notCreated}
                          </p>
                          <LtrValue
                            value={r.approval.email}
                            mono={false}
                            className="text-xs text-slate-500"
                          />
                        </>
                      ) : (
                        <>
                          <p className="truncate font-bold text-slate-800">
                            <bdi>{r.ws.name}</bdi>
                          </p>
                          {r.me && (
                            <LtrValue
                              value={r.me.loginCode}
                              className="text-xs text-slate-500"
                            />
                          )}
                        </>
                      )}
                    </div>
                    {/* `bdi`: a Latin name keeps its own direction (isolated,
                        like dir="auto") while the cell aligns with the RTL row. */}
                    <p className="min-w-0 truncate text-sm text-slate-600">
                      <bdi>
                        {r.kind === "approval"
                          ? r.approval.name
                          : (r.ws.ownerName ?? W.noOwner)}
                      </bdi>
                    </p>
                    <div>
                      {r.kind === "approval" ? (
                        <ApprovalStatePill state={r.approval.state} />
                      ) : r.me ? (
                        <StatusPill active={r.me.isActive} />
                      ) : (
                        <span className="text-xs text-slate-400">{W.notAvailable}</span>
                      )}
                    </div>
                    <ModuleChips
                      modules={
                        r.kind === "approval"
                          ? (r.approval.requestedModules ?? [])
                          : r.ws.modules
                      }
                    />
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      {r.kind === "approval" && recovery && (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={busy}
                          disabled={access.anyBusy && !busy}
                          onClick={() => setConfirmReissue(r.approval)}
                          className="max-sm:h-11 max-sm:flex-1"
                        >
                          {recovery}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setDetailId(r.id)}
                        aria-label={W.detailsAria(
                          r.kind === "approval" ? r.approval.name : r.ws.name,
                        )}
                        className="max-sm:h-11 max-sm:flex-1 lg:w-16"
                      >
                        {W.details}
                      </Button>
                    </div>
                    {error && (
                      <p
                        role="alert"
                        className="text-sm font-medium text-opponent lg:col-span-5"
                      >
                        {error}
                      </p>
                    )}
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
        title={
          detail
            ? detail.kind === "approval"
              ? detail.approval.name
              : detail.ws.name
            : ""
        }
        footer={
          detail &&
          (detail.kind === "workspace" ? (
            <div className="space-y-2">
              <Button
                className="w-full"
                disabled={modules.savingId !== null}
                onClick={() => {
                  // Close the drawer first - its Escape handler is not
                  // stack-aware, so it must not sit under the edit dialog.
                  setDetailId(null);
                  editor.open(detail.ws);
                }}
              >
                {W.editModules}
              </Button>
              {/* Only where there IS an Owner to edit. */}
              {detail.ws.ownerName && (
                <Button
                  className="w-full"
                  variant="secondary"
                  data-testid="edit-owner"
                  onClick={() => {
                    const ws = detail.ws;
                    setDetailId(null);
                    setOwnerEditFor(ws);
                  }}
                >
                  {T.ownerAccount.open}
                </Button>
              )}
            </div>
          ) : (
            approvalActionLabel(detail.approval) && (
              <Button
                className="w-full"
                disabled={access.anyBusy}
                onClick={() => {
                  const a = detail.approval;
                  setDetailId(null);
                  setConfirmReissue(a);
                }}
              >
                {approvalActionLabel(detail.approval)}
              </Button>
            )
          ))
        }
      >
        {detail && (
          <dl data-testid="workspace-detail">
            {detail.kind === "approval" ? (
              <>
                <DetailRow label={W.statusLabel}>
                  <span className="flex flex-wrap items-center gap-2">
                    <ApprovalStatePill state={detail.approval.state} />
                    <span className="text-xs font-normal text-slate-500">
                      {approvalDateLine(detail.approval)}
                    </span>
                  </span>
                </DetailRow>
                <DetailRow label={W.codeLabel}>{W.notCreated}</DetailRow>
                <DetailRow label={W.ownerLabel}>{detail.approval.name}</DetailRow>
                <DetailRow label={W.ownerEmailLabel}>
                  <LtrValue value={detail.approval.email} mono={false} />
                </DetailRow>
                <DetailRow label={W.ownerPhoneLabel}>
                  {detail.approval.phone ? (
                    <LtrValue value={detail.approval.phone} mono={false} />
                  ) : (
                    W.noPhone
                  )}
                </DetailRow>
                <DetailRow label={W.requestedModulesLabel}>
                  <ModuleChips modules={detail.approval.requestedModules ?? []} />
                </DetailRow>
                <DetailRow label={W.modulesLabel}>{W.notCreatedHint}</DetailRow>
              </>
            ) : (
              <>
                <DetailRow label={W.ownerLabel}>
                  {detail.ws.ownerName ?? W.noOwner}
                </DetailRow>
                <DetailRow label={W.ownerEmailLabel}>
                  {detail.ws.ownerEmail ? (
                    <LtrValue value={detail.ws.ownerEmail} mono={false} />
                  ) : (
                    W.noOwner
                  )}
                </DetailRow>
                {/* The OWNER's number, from their own row - always shown, so
                    its absence reads as "none recorded" rather than leaving
                    the operator wondering whether the row is missing. */}
                <DetailRow label={W.ownerPhoneLabel}>
                  {detail.ws.ownerPhone ? (
                    <LtrValue value={detail.ws.ownerPhone} mono={false} />
                  ) : (
                    W.noPhone
                  )}
                </DetailRow>
                <DetailRow label={W.codeLabel}>
                  {detail.me ? <LtrValue value={detail.me.loginCode} /> : W.notAvailable}
                </DetailRow>
                <DetailRow label={W.statusLabel}>
                  {detail.me ? (
                    <StatusPill active={detail.me.isActive} />
                  ) : (
                    W.notAvailable
                  )}
                </DetailRow>
                <DetailRow label={W.endLabel}>
                  {formatDateTime(detail.ws.electionEndAt)}
                </DetailRow>
                <DetailRow label={W.modulesLabel}>
                  <ModuleChips modules={detail.ws.modules} />
                </DetailRow>
                <DetailRow label={W.multiEntityLabel}>
                  {/* With several Multi-Entity Owners this is a COUNT, not a
                      yes/no: a workspace can be visible to more than one. */}
                  {detail.me
                    ? detail.me.assignedOwnerIds.length > 0
                      ? T.multiEntity.workspaces.assignedToOwners(
                          detail.me.assignedOwnerIds.length,
                        )
                      : T.multiEntity.workspaces.unassigned
                    : W.notAvailable}
                </DetailRow>
                {detail.approval && (
                  <DetailRow label={W.approvalLabel}>
                    <span className="flex flex-wrap items-center gap-2">
                      <ApprovalStatePill state={detail.approval.state} />
                      <span className="text-xs font-normal text-slate-500">
                        {approvalDateLine(detail.approval)}
                      </span>
                    </span>
                  </DetailRow>
                )}
              </>
            )}
          </dl>
        )}
      </Drawer>
      {editor.dialog}

      {ownerEditFor && (
        <OwnerAccountDialog
          workspaceId={ownerEditFor.workspaceId}
          workspaceName={ownerEditFor.name}
          onClose={() => setOwnerEditFor(null)}
        />
      )}

      <OwnerAccessRecovery
        access={access}
        confirm={confirmReissue}
        onCancel={() => setConfirmReissue(null)}
      />

      {approveOpen && (
        <OwnerApprovalDialog
          // BOTH shell-level reads, not just the one this dialog sits in.
          // `useOwnerAccess` and `useWorkspaceModules` are mounted once by
          // PlatformAdminShell and every section is a sibling child route, so
          // nothing remounts on navigation: a list this dialog does not
          // refresh stays stale until the operator presses F5. Approving an
          // Owner creates an approval AND is the act a workspace and its
          // module entitlements follow from, so both reads are refreshed.
          onChanged={reloadAll}
          onClose={() => setApproveOpen(false)}
          catalog={modules.catalog}
          catalogError={modules.readError !== null}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit + Settings
// ---------------------------------------------------------------------------

/**
 * The activity log - what the server actually recorded, newest first.
 *
 * Read-only by construction: there is no write path on this screen, and the
 * one function behind it only reads. It shows ONLY recorded events - an action
 * that predates its audit, or was never audited, does not appear and is not
 * reconstructed. That is why the empty state says so plainly rather than
 * implying the system has been quiet.
 */
function ActivityRow({ event }: { event: ActivityEvent }) {
  const A = T.audit;
  const action = A.actions[event.action] ?? event.action;
  const source = A.sources[event.source] ?? event.source;

  // Only what the recorded details actually contain.
  const changed = Array.isArray(event.details.changed)
    ? (event.details.changed as unknown[]).filter((f): f is string => typeof f === "string")
    : null;
  const from = typeof event.details.from === "string" ? event.details.from : null;
  const to = typeof event.details.to === "string" ? event.details.to : null;

  return (
    <li
      data-testid="activity-row"
      data-source={event.source}
      data-action={event.action}
      className="space-y-1 rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-slate-200 md:rounded-none md:bg-transparent md:px-4 md:py-3 md:shadow-none md:ring-0 lg:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
          {source}
        </span>
        <p className="min-w-0 font-bold break-words text-slate-800">{action}</p>
        <span className="ms-auto shrink-0 text-xs text-slate-500">
          {formatDateTime(event.at)}
        </span>
      </div>
      {(event.subject || event.workspace) && (
        <p className="text-sm text-slate-600">
          {event.subject && <bdi>{event.subject}</bdi>}
          {event.subject && event.workspace && " · "}
          {event.workspace && <bdi>{event.workspace}</bdi>}
        </p>
      )}
      {changed && changed.length > 0 && (
        <p className="text-xs text-slate-500">
          {T.audit.changedLabel(
            changed.map((f) => T.audit.changedFields[f] ?? f).join(", "),
          )}
        </p>
      )}
      {from && to && (
        <p className="text-xs text-slate-500">{T.audit.renamedLabel(from, to)}</p>
      )}
    </li>
  );
}

export function PlatformAuditSection() {
  const A = T.audit;
  const [query, setQuery] = useState("");

  const load = useCallback(async (): Promise<ActivityEvent[]> => {
    const { data: sess } = await platformOwnerAuthClient.auth.getSession();
    const token = sess.session?.access_token ?? null;
    if (!token) return [];
    const res = await fetchActivity(token);
    if (res.status !== "ok") throw new Error(A.loadError);
    return res.data;
  }, [A.loadError]);

  const activity = useAsyncData(load);
  const events = activity.data ?? [];

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) =>
      [
        e.subject ?? "",
        e.workspace ?? "",
        A.actions[e.action] ?? e.action,
        A.sources[e.source] ?? e.source,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [events, query, A]);

  const hasRows = events.length > 0;

  return (
    <AdminSection
      testId="platform-audit-section"
      title={A.title}
      description={A.description}
      toolbar={
        hasRows ? (
          <AdminSearch
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={A.search}
            aria-label={A.search}
            className="min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
          />
        ) : undefined
      }
      count={hasRows ? A.count(visible.length) : undefined}
      panel
    >
      {activity.error ? (
        <LoadError message={A.loadError} onRetry={() => void activity.reload()} />
      ) : activity.loading && !hasRows ? (
        <ListSkeleton />
      ) : !hasRows ? (
        <PanelCentered>
          <EmptyState dense icon={ScrollText} title={A.emptyTitle} hint={A.emptyHint} />
        </PanelCentered>
      ) : visible.length === 0 ? (
        <PanelCentered>{A.noResults}</PanelCentered>
      ) : (
        <ul
          className="space-y-2.5 md:space-y-0 md:divide-y md:divide-slate-100 md:border-b md:border-slate-100"
          data-testid="activity-list"
        >
          {visible.map((e) => (
            <ActivityRow key={`${e.source}:${e.id}`} event={e} />
          ))}
        </ul>
      )}
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

/**
 * The console operator's own password.
 *
 * Sent to the server WITH the current one, because a live session is not proof
 * that the person at the keyboard knows the password they are replacing - a
 * borrowed tab would otherwise be able to lock the owner out of their own
 * console. The server verifies, sets and records; nothing here keeps either
 * value, and the fields are cleared the moment it succeeds.
 */
function PlatformOwnerPasswordForm() {
  const c = T.console;
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const violation = validatePlatformOwnerPassword(next, confirm);
    if (violation) {
      setError(T.setPassword.errors[violation]);
      return;
    }
    setBusy(true);
    try {
      const { data: sess } = await platformOwnerAuthClient.auth.getSession();
      const token = sess.session?.access_token ?? null;
      if (!token) {
        setError(c.passwordErrors.UNAUTHORIZED);
        return;
      }
      const res = await changeOwnPassword(token, current, next);
      if (res.status !== "ok") {
        const code = res.status === "error" ? res.code : "UNAUTHORIZED";
        setError(c.passwordErrors[code] ?? c.passwordErrors.SERVER_ERROR);
        return;
      }
      toast.success(c.passwordSaved);
      reset();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="own-password-open"
        onClick={() => setOpen(true)}
      >
        {c.passwordOpen}
      </Button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-3 rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200"
      data-testid="own-password-form"
    >
      <h3 className="text-sm font-bold text-slate-700">{c.passwordTitle}</h3>
      <Field label={c.passwordCurrent}>
        <Input
          type="password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value);
            setError(null);
          }}
          name="platform-owner-current-password"
          autoComplete="current-password"
        />
      </Field>
      <Field label={c.passwordNew}>
        <Input
          type="password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
            setError(null);
          }}
          name="platform-owner-new-password"
          autoComplete="new-password"
        />
      </Field>
      <Field label={c.passwordConfirm} error={error ?? undefined}>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
          name="platform-owner-confirm-password"
          autoComplete="new-password"
          invalid={!!error}
        />
        <p className="mt-1 text-xs text-slate-400">{c.passwordHint}</p>
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          loading={busy}
          disabled={!current || !next || !confirm}
          data-testid="own-password-save"
        >
          {c.passwordSubmit}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          {c.passwordCancel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Settings: the verified identity, the operator's own password, and the one
 * platform-wide control that is not about a single workspace - a module's
 * GLOBAL availability. That control used to live on a separate module screen
 * whose only other job, per-workspace entitlements, is done from a system's
 * own details; the screen is gone and this is where the global switch landed.
 */
export function PlatformSettingsSection() {
  const owner = usePlatformOwnerSession((s) => s.owner);
  const { workspaceModules: modules } = usePlatformAdmin();
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const c = T.console;
  return (
    <>
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
          <PlatformOwnerPasswordForm />

          <div className="space-y-2 border-t border-slate-200 pt-3">
            <h3 className="text-sm font-bold text-slate-700">
              {T.moduleAvailability.open}
            </h3>
            <p className="text-xs text-slate-500">{T.moduleAvailability.subtitle}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAvailabilityOpen(true)}
              disabled={modules.catalog.length === 0}
              data-testid="module-availability-open"
            >
              <Power className="size-4" aria-hidden />
              {T.moduleAvailability.open}
            </Button>
          </div>

          <p className="text-xs text-slate-500">{c.stageNote}</p>
        </div>
      </AdminSection>
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
