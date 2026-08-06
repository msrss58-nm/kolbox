import { useState } from "react";
import { Eye, EyeOff, Users } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui/Toast";
import type { RoleRecord } from "../../permissions/types";
import type { NewPermissionUser } from "../../services/api";
import type { PermissionUser } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { roleDisplayName } from "./roleDisplayName";

const text = ELECTION_DAY_TEXT.permissionsManager;

export function PermissionUsersModal({
  open,
  onClose,
  users,
  roles,
  onAdd,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  users: PermissionUser[];
  /** Dynamic Roles & Permissions: the live catalog - the 3 built-in roles
   * and any custom role alike, offered together as one picker. */
  roles: readonly RoleRecord[];
  onAdd: (input: NewPermissionUser) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <Modal open={open} onClose={onClose} title={text.modalTitle}>
      <div className="space-y-5">
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
                  showPassword ? text.hidePasswordAriaLabel : text.showPasswordAriaLabel
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

        {users.length === 0 ? (
          <EmptyState icon={Users} title={text.empty} />
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-100">
            <div className="grid grid-cols-[1fr_7rem] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
              <span>{text.columns.name}</span>
              <span>{text.columns.role}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {sortedUsers.map((u) => (
                <li
                  key={u.id}
                  className="grid grid-cols-[1fr_7rem] items-center gap-2 px-3 py-1"
                >
                  <span className="truncate text-sm font-bold text-slate-800">
                    {u.name}
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-600">
                      {roleDisplayName(u.roleId, roles)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void onDelete(u.id)}
                      aria-label={text.deleteAriaLabel}
                      className="touch-target grid shrink-0 place-items-center rounded-lg text-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent"
                    >
                      🗑️
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
