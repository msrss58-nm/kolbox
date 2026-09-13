import { useMemo, useState, type FormEvent } from "react";
import { Eye, EyeOff, KeyRound, Trash2, UserPlus, Users } from "lucide-react";
import { AdminSearch, AdminSection } from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/Toast";
import { COMMON_TEXT } from "../../constants/common-text";
import { cn } from "../../lib/utils";
import type { RoleRecord } from "../../permissions/types";
import type { NewPermissionUser } from "../../services/api";
import type { PermissionUser } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { ResetPasswordDialog } from "./ResetPasswordDialog";
import { roleDisplayName } from "./roleDisplayName";

const text = ELECTION_DAY_TEXT.permissionsManager;
const pageText = ELECTION_DAY_TEXT.owner.rolesPage;
const usersText = ELECTION_DAY_TEXT.owner.admin.users;
const managerBadge = ELECTION_DAY_TEXT.rolesManager.managerBadge;

/** From `md`: a name / role / actions table row; from `lg` every column is
 * capped so the three read together instead of stretching across the working
 * area. Below `md` each user is a card instead (see the row markup). */
const TABLE_GRID =
  "md:grid md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] md:items-center md:gap-3 lg:grid-cols-[minmax(0,21.25rem)_minmax(0,18.75rem)_6.875rem] lg:gap-x-7 lg:px-6";

/** Phones: one card per user - avatar + name, the role under it, actions on
 * the side. The same markup becomes the table row from `md`. */
const USER_CARD =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-slate-200 md:rounded-none md:bg-transparent md:px-4 md:py-1 md:shadow-none md:ring-0";

/** The avatar's letter: the name's first character (display only). */
function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? "";
}

function CreateUserDialog({
  roles,
  onAdd,
  onClose,
}: {
  roles: readonly RoleRecord[];
  onAdd: (input: NewPermissionUser) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveRoleId = selectedRoleId ?? roles[0]?.id ?? null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim() || !password.trim() || !effectiveRoleId) {
      toast.error(text.toast.invalid);
      return;
    }
    setBusy(true);
    try {
      // A cancelled step-up or a refused create resolves to `undefined` - the
      // dialog stays open with what was typed. Only a real success closes it.
      const result = await onAdd({
        name: name.trim(),
        password: password.trim(),
        roleId: effectiveRoleId,
      });
      if (result !== undefined) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={usersText.add} onClose={busy ? () => {} : onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label={text.nameLabel}>
          {/* Browser-autofill mitigation: a new PermissionUser's display name,
              never the signed-in account's own identity. A bare text field
              followed by a password field is exactly the shape Chrome treats
              as a login form and fills with a saved credential for this
              origin; "off" is the WHATWG "do not auto-populate" token (not
              "username", which would declare it a login identifier). */}
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={text.namePlaceholder}
            autoComplete="off"
            name="new-permission-user-name"
            autoFocus
          />
        </Field>

        <Field label={text.passwordLabel}>
          <div className="flex gap-2">
            {/* "new-password": a password for an account other than the
                signed-in one - suppresses saved-credential autofill and the
                "update saved password?" prompt in every major browser. */}
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={text.passwordPlaceholder}
              className="flex-1"
              dir="ltr"
              autoComplete="new-password"
              name="new-permission-user-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={
                showPassword ? text.hidePasswordAriaLabel : text.showPasswordAriaLabel
              }
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-primary-500"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <Field label={text.roleLabel}>
          <Select
            value={effectiveRoleId ?? ""}
            onChange={(e) => setSelectedRoleId(e.target.value)}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={busy} className="flex-1">
            {text.addButton}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            {COMMON_TEXT.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The Election Owner's Users section (Platform Stage 9 authority, admin-shell
 * layout). Rendered ONLY inside the Owner administration shell, fed by
 * `useOwnerUserManagement` - user management is Owner authority, there is no
 * worker-side consumer. Every mutation is authorized server-side (Owner JWT +
 * a one-time Owner proof); nothing here is an authorization decision.
 *
 * Layout: search / role filter / "add" live in the section header, the list is
 * the only scrolling region, and create / reset / delete all open dialogs - the
 * page itself never grows.
 */
export function PermissionUsersPanel({
  users,
  roles,
  loaded,
  loadError,
  onRetry,
  onAdd,
  onDelete,
  onReset,
  canResetPassword,
}: {
  users: PermissionUser[];
  roles: readonly RoleRecord[];
  loaded: boolean;
  loadError: unknown;
  onRetry: () => void;
  /** Resolves to `undefined` when the create did not happen (refused or the
   * step-up was cancelled) - only `!== undefined` is a success. */
  onAdd: (input: NewPermissionUser) => Promise<unknown>;
  /** Same "undefined on failure" contract as `onAdd`. */
  onDelete: (id: string) => Promise<unknown>;
  onReset: (id: string, newPassword: string) => Promise<unknown>;
  /** Whether the reset action is offered for a row. The server is the
   * authority (CANNOT_RESET_MANAGER); this only avoids offering a button that
   * would be refused. */
  canResetPassword: (user: PermissionUser) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<PermissionUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PermissionUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  // Manager-role users first (the explicit Stage 9 flag), insertion order
  // preserved within each group.
  const visibleUsers = useMemo(() => {
    const isManager = (u: PermissionUser) => roleById.get(u.roleId)?.isManager === true;
    const q = query.trim().toLowerCase();
    return [...users]
      .sort((a, b) => Number(isManager(b)) - Number(isManager(a)))
      .filter(
        (u) =>
          (!roleFilter || u.roleId === roleFilter) &&
          (!q || u.name.toLowerCase().includes(q)),
      );
  }, [users, roleById, query, roleFilter]);

  const toolbar =
    users.length > 0 ? (
      <>
        <AdminSearch
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={usersText.search}
          aria-label={usersText.search}
          className="min-w-0 flex-1 basis-44 sm:w-72 sm:flex-none"
        />
        <Select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label={usersText.roleFilterLabel}
          className="h-10 w-36 shrink-0 sm:w-48"
        >
          <option value="">{usersText.roleFilterAll}</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </>
    ) : undefined;

  return (
    <>
      <AdminSection
        testId="owner-users-card"
        title={pageText.usersTitle}
        description={pageText.usersSubtitle}
        actions={
          <Button onClick={() => setCreateOpen(true)} disabled={!loaded}>
            <UserPlus className="size-4" aria-hidden />
            {usersText.add}
          </Button>
        }
        toolbar={toolbar}
        count={
          users.length > 0
            ? usersText.count(visibleUsers.length, users.length)
            : undefined
        }
        panel
      >
        {loadError ? (
          <div className="space-y-2 p-4">
            <p role="alert" className="text-sm text-opponent">
              {pageText.loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {pageText.retry}
            </Button>
          </div>
        ) : !loaded ? (
          <div className="space-y-2 p-4" aria-hidden>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : users.length === 0 ? (
          // Centered inside the data panel; "add" stays in the toolbar.
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              dense
              icon={Users}
              title={text.empty}
              hint={usersText.emptyHint}
            />
          </div>
        ) : visibleUsers.length === 0 ? (
          <p className="flex h-full items-center justify-center p-6 text-sm text-slate-500">
            {usersText.noResults}
          </p>
        ) : (
          <>
            {/* Sticky: the data panel itself is the scroll region. */}
            <div
              className={cn(
                "hidden",
                TABLE_GRID,
                "sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-bold text-slate-500",
              )}
            >
              <span>{text.columns.name}</span>
              <span>{text.columns.role}</span>
              <span className="w-[5.5rem]">{text.columns.actions}</span>
            </div>
            <ul className="space-y-2.5 md:space-y-0 md:divide-y md:divide-slate-100 md:border-b md:border-slate-100">
              {visibleUsers.map((u) => {
                const role = roleById.get(u.roleId);
                const roleName = roleDisplayName(u.roleId, roles);
                const resettable = canResetPassword(u);
                const resetLabel = resettable
                  ? text.resetPassword.ariaLabel
                  : text.resetPassword.managerDisabledLabel;
                return (
                  <li
                    key={u.id}
                    className={cn(
                      USER_CARD,
                      TABLE_GRID,
                      "transition-colors md:hover:bg-slate-50",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className={cn(
                          "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-bold text-primary-700",
                          role?.isManager ? "bg-primary-100" : "bg-primary-50",
                        )}
                      >
                        {initialOf(u.name)}
                      </span>
                      <span
                        className="min-w-0 truncate text-sm font-bold text-slate-800"
                        dir="auto"
                      >
                        {u.name}
                      </span>
                    </span>
                    {/* Phones: under the name, aligned with it (past the
                        32px avatar + gap). */}
                    <span className="flex min-w-0 items-center gap-1.5 max-md:col-start-1 max-md:ps-[2.625rem]">
                      <span className="truncate text-sm text-slate-600" title={roleName}>
                        {roleName}
                      </span>
                      {role?.isManager && (
                        <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
                          {managerBadge}
                        </span>
                      )}
                    </span>
                    <div className="flex w-[5.5rem] items-center justify-start gap-1 max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 max-md:justify-end">
                      <button
                        type="button"
                        onClick={() => setResetTarget(u)}
                        disabled={!resettable}
                        aria-label={resetLabel}
                        title={resetLabel}
                        className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:pointer-events-none disabled:opacity-30"
                      >
                        <KeyRound className="size-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(u)}
                        aria-label={text.deleteAriaLabel}
                        title={text.deleteAriaLabel}
                        className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent focus-visible:outline-2 focus-visible:outline-primary-500"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </AdminSection>

      {createOpen && (
        <CreateUserDialog
          roles={roles}
          onAdd={onAdd}
          onClose={() => setCreateOpen(false)}
        />
      )}

      <ResetPasswordDialog
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        user={resetTarget}
        onReset={onReset}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={text.confirmDelete.title}
        message={deleteTarget ? text.confirmDelete.message(deleteTarget.name) : ""}
        confirmLabel={text.confirmDelete.confirmButton}
        danger
        busy={deleteBusy}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleteBusy(true);
          try {
            const result = await onDelete(deleteTarget.id);
            if (result !== undefined) setDeleteTarget(null);
          } finally {
            setDeleteBusy(false);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
