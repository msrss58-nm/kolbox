import { useState } from "react";
import { Eye, EyeOff, KeyRound, Users } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { toast } from "../../components/ui/Toast";
import type { RoleRecord } from "../../permissions/types";
import type { NewPermissionUser } from "../../services/api";
import type { PermissionUser } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDaySession } from "./electionDaySession";
import { ResetPasswordDialog } from "./ResetPasswordDialog";
import { roleDisplayName } from "./roleDisplayName";

const text = ELECTION_DAY_TEXT.permissionsManager;

/** Navigation Refactor: extracted from the old `PermissionUsersModal` - same
 * content, no `Modal` wrapper, now rendered as a tab on `/election-day/permissions`
 * instead of a dialog. `ResetPasswordDialog` still renders as an actual modal. */
export function PermissionUsersPanel({
  users,
  roles,
  onAdd,
  onDelete,
  onReset,
  canManageUsers,
}: {
  users: PermissionUser[];
  /** Dynamic Roles & Permissions: the live catalog - the 3 built-in roles
   * and any custom role alike, offered together as one picker. */
  roles: readonly RoleRecord[];
  onAdd: (input: NewPermissionUser) => Promise<unknown>;
  /** Resolves to `undefined` on a blocked/failed delete (permission denial,
   * self-delete, or a thrown error) - only `!== undefined` means it actually
   * succeeded, same "undefined on failure" contract as `onAdd`. Busy state
   * while this (and any stacked trusted-reauth dialog it triggers) is in
   * flight is tracked locally below (`deleteBusy`), same pattern as
   * `handleAdd`'s own local `busy` - the underlying trusted delete flow
   * (Phase 3C) has no `useAsyncAction`-style busy of its own to read. */
  onDelete: (id: string) => Promise<unknown>;
  onReset: (id: string, newPassword: string) => Promise<unknown>;
  /** `electionDay.manageUsers` (widened by the same bootstrap exception
   * `addPermissionUser` itself applies) - Add/Reset/Delete are all gated by
   * this one permission in `useElectionDay.ts`, so one flag controls all
   * three here. A denied session doesn't just get disabled controls, it
   * never sees the Add form or the actions column at all - `guardedAction`
   * still blocks the mutation underneath regardless, this is purely an
   * additional UI-visibility layer on top of it. */
  canManageUsers: boolean;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<PermissionUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PermissionUser | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // The signed-in Election Day session's own id - never lets that account's
  // row offer self-delete, see `text.selfDelete` and `useElectionDay.ts`'s
  // matching handler-level guard.
  const currentUserId = useElectionDaySession((s) => s.user?.id ?? null);

  const effectiveRoleId = selectedRoleId ?? roles[0]?.id ?? null;

  // Full-admin users (holding electionDay.manageRolesAndPermissions) sort
  // above everyone else, insertion order preserved within each group - no
  // role carries any special status in code beyond what its permissions
  // grant, so this reads the live catalog rather than a hardcoded role name.
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const isFullAdmin = (u: PermissionUser) =>
    roleById
      .get(u.roleId)
      ?.permissions.includes("electionDay.manageRolesAndPermissions") ?? false;
  const sortedUsers = [...users].sort(
    (a, b) => Number(isFullAdmin(b)) - Number(isFullAdmin(a)),
  );

  const handleAdd = async () => {
    if (!name.trim() || !password.trim() || !effectiveRoleId) {
      toast.error(text.toast.invalid);
      return;
    }
    setBusy(true);
    try {
      // A blocked (no permission) or failed add resolves to `undefined` -
      // only clear the form once the account was actually created.
      const result = await onAdd({
        name: name.trim(),
        password: password.trim(),
        roleId: effectiveRoleId,
      });
      if (result !== undefined) {
        setName("");
        setPassword("");
        setShowPassword(false);
        setSelectedRoleId(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="space-y-5">
        {canManageUsers && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label={text.nameLabel}>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={text.namePlaceholder}
                />
              </Field>

              <Field label={text.passwordLabel}>
                <div className="flex gap-2">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={text.passwordPlaceholder}
                    className="flex-1"
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword
                        ? text.hidePasswordAriaLabel
                        : text.showPasswordAriaLabel
                    }
                    className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </Field>
            </div>

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

            <Button className="w-full" loading={busy} onClick={() => void handleAdd()}>
              ➕ {text.addButton}
            </Button>
          </>
        )}

        {users.length === 0 ? (
          <EmptyState icon={Users} title={text.empty} />
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-100">
            <div
              className={`grid gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500 ${
                canManageUsers ? "grid-cols-[1fr_4.5rem_6rem]" : "grid-cols-[1fr_4.5rem]"
              }`}
            >
              <span>{text.columns.name}</span>
              <span>{text.columns.role}</span>
              {canManageUsers && <span className="text-end">{text.columns.actions}</span>}
            </div>
            <ul className="divide-y divide-slate-100">
              {sortedUsers.map((u) => {
                const isSelf = u.id === currentUserId;
                const roleName = roleDisplayName(u.roleId, roles);
                return (
                  <li
                    key={u.id}
                    className={`grid items-center gap-2 px-3 py-1 ${
                      canManageUsers
                        ? "grid-cols-[1fr_4.5rem_6rem]"
                        : "grid-cols-[1fr_4.5rem]"
                    }`}
                  >
                    <span className="min-w-0 truncate text-sm font-bold text-slate-800">
                      {u.name}
                    </span>
                    <span
                      className="min-w-0 truncate text-sm text-slate-600"
                      title={roleName}
                    >
                      {roleName}
                    </span>
                    {/* Fixed shrink-0 actions column so the icons can never
                        be squeezed/clipped by the name or role cells - each
                        of the 2 buttons keeps its full ≥44px touch target.
                        The whole column - and the grid template's 3rd track
                        above - only exists when the session actually holds
                        `electionDay.manageUsers`; otherwise there is nothing
                        to act on, so no empty column or dead space renders. */}
                    {canManageUsers && (
                      <div className="flex shrink-0 items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setResetTarget(u)}
                          aria-label={text.resetPassword.ariaLabel}
                          title={text.resetPassword.ariaLabel}
                          className="touch-target grid shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        >
                          <KeyRound className="size-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(u)}
                          disabled={isSelf}
                          aria-label={
                            isSelf ? text.selfDelete.disabledLabel : text.deleteAriaLabel
                          }
                          title={
                            isSelf ? text.selfDelete.disabledLabel : text.deleteAriaLabel
                          }
                          className="touch-target grid shrink-0 place-items-center rounded-lg text-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent disabled:pointer-events-none disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          🗑️
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

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
