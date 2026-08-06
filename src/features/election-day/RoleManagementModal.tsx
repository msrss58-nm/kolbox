import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui/Toast";
import { ALL_PERMISSIONS } from "../../permissions/permissionsMap";
import type { Permission, RoleRecord, RoleScopeType } from "../../permissions/types";
import type { NewRole, RoleUpdate } from "../../services/api";
import type { PermissionUser } from "../../types";
import {
  ELECTION_DAY_TEXT,
  PERMISSION_LABELS,
  ROLE_SCOPE_LABELS,
} from "./election-day.constants";
import type { RoleManagementHook } from "./useRoleManagement";

const text = ELECTION_DAY_TEXT.rolesManager;

interface RoleFormState {
  name: string;
  description: string;
  scopeType: RoleScopeType;
  permissions: Set<Permission>;
}

function emptyForm(): RoleFormState {
  return {
    name: "",
    description: "",
    scopeType: "assigned_to_me",
    permissions: new Set(),
  };
}

function formFromRole(role: RoleRecord): RoleFormState {
  return {
    name: role.name,
    description: role.description,
    scopeType: role.scopeType ?? "assigned_to_me",
    permissions: new Set(role.permissions),
  };
}

export function RoleManagementModal({
  open,
  onClose,
  permissionUsers,
  roleManagement,
}: {
  open: boolean;
  onClose: () => void;
  permissionUsers: PermissionUser[];
  roleManagement: RoleManagementHook;
}) {
  const {
    roles,
    createRole,
    updateRole,
    deleteRole,
    cloneRole,
    creatingRole,
    updatingRole,
    deletingRole,
  } = roleManagement;

  // `null` = list view, "new" = creating, a RoleRecord = editing that role.
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

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error(text.toast.invalid);
      return;
    }
    const input: NewRole = {
      name: form.name.trim(),
      description: form.description.trim(),
      permissions: [...form.permissions],
      scopeType: form.scopeType,
    };
    const result =
      editing !== "new" && editing !== null
        ? await updateRole({ ...input, id: editing.id } satisfies RoleUpdate)
        : await createRole(input);
    if (result !== undefined) closeEditor();
  };

  const handleClone = (role: RoleRecord) => {
    void cloneRole(role.id, text.cloneSuffix(role.name));
  };

  const busy = creatingRole || updatingRole;

  return (
    <Modal
      open={open}
      onClose={() => {
        closeEditor();
        onClose();
      }}
      title={
        editing === null
          ? text.modalTitle
          : editing === "new"
            ? text.createTitle
            : text.editTitle
      }
      wide
    >
      {editing === null ? (
        <div className="space-y-4">
          <Button className="w-full" onClick={openCreate}>
            ➕ {text.newRoleButton}
          </Button>

          {roles.length === 0 ? (
            <EmptyState icon={ShieldCheck} title={text.empty} />
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
              {roles.map((role) => {
                const count = assignedCount(role.id);
                return (
                  <li
                    key={role.id}
                    className="flex items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-bold text-slate-800">
                          {role.name}
                        </p>
                        {role.legacyRoleKey && (
                          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                            {text.legacyBadge}
                          </span>
                        )}
                      </div>
                      {role.description && (
                        <p className="truncate text-xs text-slate-500">
                          {role.description}
                        </p>
                      )}
                      <p className="text-xs text-slate-400">
                        {ROLE_SCOPE_LABELS[role.scopeType ?? "assigned_to_me"]} ·{" "}
                        {text.usersCount(count)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(role)}
                        aria-label={text.editAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        onClick={() => handleClone(role)}
                        aria-label={text.cloneButton}
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      >
                        📄
                      </button>
                      <button
                        type="button"
                        disabled={count > 0}
                        onClick={() => setPendingDeleteId(role.id)}
                        aria-label={text.deleteAriaLabel}
                        className="touch-target grid place-items-center rounded-lg text-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                      >
                        🗑️
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field label={text.nameLabel}>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={text.namePlaceholder}
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

          <div>
            <span className="mb-1.5 block text-sm font-semibold text-slate-700">
              {text.scopeLabel}
            </span>
            <div className="flex gap-4">
              {(Object.keys(ROLE_SCOPE_LABELS) as RoleScopeType[]).map((scopeType) => (
                <label
                  key={scopeType}
                  className="flex items-center gap-2 text-sm font-medium text-slate-700"
                >
                  <input
                    type="radio"
                    checked={form.scopeType === scopeType}
                    onChange={() => setForm((prev) => ({ ...prev, scopeType }))}
                    className="size-4 accent-primary-600"
                  />
                  {ROLE_SCOPE_LABELS[scopeType]}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-sm font-semibold text-slate-700">
              {text.permissionsLabel}
            </span>
            <div className="grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto rounded-xl p-1 ring-1 ring-slate-100 sm:grid-cols-2">
              {ALL_PERMISSIONS.map((permission) => (
                <label
                  key={permission}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={form.permissions.has(permission)}
                    onChange={() => togglePermission(permission)}
                    className="size-4 shrink-0 accent-primary-600"
                  />
                  <span className="truncate">{PERMISSION_LABELS[permission]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button className="flex-1" loading={busy} onClick={() => void handleSave()}>
              {text.saveButton}
            </Button>
            <Button variant="secondary" onClick={closeEditor}>
              {text.cancelButton}
            </Button>
          </div>
        </div>
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
    </Modal>
  );
}
