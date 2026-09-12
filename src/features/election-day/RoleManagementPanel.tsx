import { useState, type FormEvent } from "react";
import { Copy, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { AdminListFrame, AdminSection } from "../../components/admin/AdminSection";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { toast } from "../../components/ui/Toast";
import {
  ALL_PERMISSIONS,
  NON_GRANTABLE_PERMISSIONS,
} from "../../permissions/permissionsMap";
import type { Permission, RoleRecord, RoleScopeType } from "../../permissions/types";
import type { NewRole, RoleUpdate } from "../../services/api";
import type { PermissionUser } from "../../types";
import { AllocationPasswordDialog } from "./AllocationPasswordDialog";
import {
  ELECTION_DAY_TEXT,
  PERMISSION_LABELS,
  ROLE_SCOPE_LABELS,
} from "./election-day.constants";
import type { OwnerRoleManagementHook } from "./useOwnerRoleManagement";

const text = ELECTION_DAY_TEXT.rolesManager;
const pageText = ELECTION_DAY_TEXT.owner.rolesPage;
const rolesText = ELECTION_DAY_TEXT.owner.admin.roles;

// Platform Stage 9: inert permissions are not offered. A role that still
// carries one keeps it untouched in `form.permissions` on save.
const GRANTABLE_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => !NON_GRANTABLE_PERMISSIONS.has(p),
);

const ICON_BUTTON =
  "touch-target grid place-items-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-primary-500";

interface RoleFormState {
  name: string;
  description: string;
  scopeType: RoleScopeType;
  permissions: Set<Permission>;
  isManager: boolean;
}

function emptyForm(): RoleFormState {
  return {
    name: "",
    description: "",
    scopeType: "assigned_to_me",
    permissions: new Set(),
    isManager: false,
  };
}

function formFromRole(role: RoleRecord): RoleFormState {
  return {
    name: role.name,
    description: role.description,
    scopeType: role.scopeType ?? "assigned_to_me",
    permissions: new Set(role.permissions),
    isManager: role.isManager === true,
  };
}

/**
 * The Election Owner's Roles & Permissions section - its only consumer is the
 * Owner administration shell (fed by `useOwnerRoleManagement`). The list is
 * the section body; create / edit open a wide dialog with the permissions
 * editor instead of replacing the list in place, so the page never grows.
 *
 * `permissionUsers` drives only the per-role assigned-count and the
 * disabled-delete hint, never an authorization decision - the server-side
 * ROLE_HAS_ASSIGNED_USERS check still blocks a real deletion regardless.
 */
export function RoleManagementPanel({
  permissionUsers = [],
  roleManagement,
}: {
  permissionUsers?: PermissionUser[];
  roleManagement: OwnerRoleManagementHook;
}) {
  const {
    roles,
    rolesLoaded,
    createRole,
    updateRole,
    deleteRole,
    cloneRole,
    creatingRole,
    updatingRole,
    deletingRole,
    reauthDialog,
  } = roleManagement;

  // `null` = no editor open, "new" = creating, a RoleRecord = editing it.
  const [editing, setEditing] = useState<RoleRecord | "new" | null>(null);
  const [form, setForm] = useState<RoleFormState>(emptyForm());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const assignedCount = (roleId: string) =>
    permissionUsers.filter((u) => u.roleId === roleId).length;

  const openCreate = () => {
    setForm(emptyForm());
    setEditing("new");
  };
  const openEdit = (role: RoleRecord) => {
    setForm(formFromRole(role));
    setEditing(role);
  };
  const closeEditor = () => setEditing(null);

  const togglePermission = (permission: Permission) => {
    setForm((prev) => {
      const next = new Set(prev.permissions);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return { ...prev, permissions: next };
    });
  };

  const busy = creatingRole || updatingRole;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!form.name.trim()) {
      toast.error(text.toast.invalid);
      return;
    }
    const input: NewRole = {
      name: form.name.trim(),
      description: form.description.trim(),
      permissions: [...form.permissions],
      scopeType: form.scopeType,
      isManager: form.isManager,
    };
    const result =
      editing !== "new" && editing !== null
        ? await updateRole({ ...input, id: editing.id } satisfies RoleUpdate)
        : await createRole(input);
    if (result !== undefined) closeEditor();
  };

  return (
    <>
      <AdminSection
        testId="owner-roles-section"
        title={pageText.rolesTitle}
        description={rolesText.description}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" aria-hidden />
            {text.newRoleButton}
          </Button>
        }
        toolbar={
          roles.length > 0 ? (
            <span className="text-xs font-semibold text-slate-500">
              {rolesText.count(roles.length)}
            </span>
          ) : undefined
        }
      >
        {!rolesLoaded ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : roles.length === 0 ? (
          <EmptyState icon={ShieldCheck} title={text.empty} />
        ) : (
          <AdminListFrame>
            <ul className="divide-y divide-slate-100" data-testid="owner-roles-list">
              {roles.map((role) => {
                const count = assignedCount(role.id);
                return (
                  <li
                    key={role.id}
                    data-manager={role.isManager === true ? "true" : "false"}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-2 text-sm font-bold text-slate-800">
                        <span className="truncate" dir="auto">
                          {role.name}
                        </span>
                        {role.isManager && (
                          <span className="shrink-0 rounded-full bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-700">
                            {text.managerBadge}
                          </span>
                        )}
                      </p>
                      {role.description && (
                        <p className="truncate text-xs text-slate-500">
                          {role.description}
                        </p>
                      )}
                      <p className="text-xs text-slate-400">
                        {ROLE_SCOPE_LABELS[role.scopeType ?? "assigned_to_me"]} ·{" "}
                        {text.usersCount(count)} ·{" "}
                        {rolesText.permissionsCount(role.permissions.length)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(role)}
                        aria-label={text.editAriaLabel}
                        title={text.editAriaLabel}
                        className={ICON_BUTTON}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void cloneRole(role.id, text.cloneSuffix(role.name))
                        }
                        aria-label={text.cloneButton}
                        title={text.cloneButton}
                        className={ICON_BUTTON}
                      >
                        <Copy className="size-4" aria-hidden />
                      </button>
                      <button
                        type="button"
                        disabled={count > 0}
                        onClick={() => setPendingDeleteId(role.id)}
                        aria-label={text.deleteAriaLabel}
                        title={text.deleteAriaLabel}
                        className={`${ICON_BUTTON} hover:bg-opponent-soft hover:text-opponent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400`}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </AdminListFrame>
        )}
      </AdminSection>

      {editing !== null && (
        <Modal
          open
          wide
          title={editing === "new" ? text.createTitle : text.editTitle}
          onClose={busy ? () => {} : closeEditor}
        >
          <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={text.nameLabel}>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder={text.namePlaceholder}
                  autoFocus
                />
              </Field>
              <Field label={text.descriptionLabel}>
                <Input
                  value={form.description}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, description: e.target.value }))
                  }
                  placeholder={text.descriptionPlaceholder}
                />
              </Field>
            </div>

            <fieldset>
              <legend className="mb-1.5 block text-sm font-semibold text-slate-700">
                {text.scopeLabel}
              </legend>
              <div className="flex flex-wrap gap-4">
                {(Object.keys(ROLE_SCOPE_LABELS) as RoleScopeType[]).map((scopeType) => (
                  <label
                    key={scopeType}
                    className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700"
                  >
                    <input
                      type="radio"
                      name="role-scope"
                      checked={form.scopeType === scopeType}
                      onChange={() => setForm((prev) => ({ ...prev, scopeType }))}
                      className="size-4 accent-primary-600"
                    />
                    {ROLE_SCOPE_LABELS[scopeType]}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex items-start gap-2 rounded-xl p-3 ring-1 ring-slate-200">
              <input
                type="checkbox"
                checked={form.isManager}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, isManager: e.target.checked }))
                }
                className="mt-0.5 size-4 shrink-0 accent-primary-600"
              />
              <span>
                <span className="block text-sm font-semibold text-slate-700">
                  {text.managerLabel}
                </span>
                <span className="block text-xs text-slate-500">{text.managerHint}</span>
              </span>
            </label>

            <fieldset>
              <legend className="mb-1.5 block text-sm font-semibold text-slate-700">
                {text.permissionsLabel}
              </legend>
              <div className="grid grid-cols-1 gap-1 rounded-xl p-1 ring-1 ring-slate-200 sm:grid-cols-2">
                {GRANTABLE_PERMISSIONS.map((permission) => (
                  <label
                    key={permission}
                    className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={form.permissions.has(permission)}
                      onChange={() => togglePermission(permission)}
                      className="size-4 shrink-0 accent-primary-600"
                    />
                    <span className="min-w-0">{PERMISSION_LABELS[permission]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="flex gap-2 pt-1">
              <Button type="submit" className="flex-1" loading={busy}>
                {text.saveButton}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={closeEditor}
                disabled={busy}
              >
                {text.cancelButton}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <ConfirmDialog
        open={pendingDeleteId !== null}
        title={text.confirmDeleteTitle}
        message={text.confirmDeleteMessage}
        confirmLabel={text.confirmDeleteButton}
        danger
        busy={deletingRole}
        onConfirm={async () => {
          if (!pendingDeleteId) return;
          const result = await deleteRole(pendingDeleteId);
          if (result !== undefined) setPendingDeleteId(null);
        }}
        onCancel={() => setPendingDeleteId(null)}
      />

      {/* The shared Owner step-up prompt for create/update/delete/clone -
          rendered after the editor so it stacks above it. */}
      {reauthDialog && <AllocationPasswordDialog {...reauthDialog} />}
    </>
  );
}
