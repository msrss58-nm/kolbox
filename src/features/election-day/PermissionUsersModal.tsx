import { useState } from "react";
import { Eye, EyeOff, Users } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui/Toast";
import type { PermissionRole, PermissionUser } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.permissionsManager;

export function PermissionUsersModal({
  open,
  onClose,
  users,
  onAdd,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  users: PermissionUser[];
  onAdd: (input: {
    name: string;
    password: string;
    role: PermissionRole;
  }) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<PermissionRole>("user");
  const [busy, setBusy] = useState(false);

  // Managers always sort above regular users, insertion order preserved within each group.
  const sortedUsers = [...users].sort((a, b) =>
    a.role === b.role ? 0 : a.role === "manager" ? -1 : 1,
  );

  const handleAdd = async () => {
    if (!name.trim() || !password.trim()) {
      toast.error(text.toast.invalid);
      return;
    }
    setBusy(true);
    try {
      await onAdd({ name: name.trim(), password: password.trim(), role });
      setName("");
      setPassword("");
      setShowPassword(false);
      setRole("user");
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

        <div>
          <span className="mb-1.5 block text-sm font-semibold text-slate-700">
            {text.roleLabel}
          </span>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={role === "user"}
                onChange={() => setRole("user")}
                className="size-4 accent-primary-600"
              />
              {text.roleOptions.user}
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={role === "manager"}
                onChange={() => setRole("manager")}
                className="size-4 accent-primary-600"
              />
              {text.roleOptions.manager}
            </label>
          </div>
        </div>

        <Button className="w-full" loading={busy} onClick={() => void handleAdd()}>
          ➕ {text.addButton}
        </Button>

        {users.length === 0 ? (
          <EmptyState icon={Users} title={text.empty} />
        ) : (
          <div className="overflow-hidden rounded-xl ring-1 ring-slate-100">
            <div className="grid grid-cols-[1fr_1fr_7rem] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-500">
              <span>{text.columns.name}</span>
              <span className="text-center">{text.columns.password}</span>
              <span>{text.columns.role}</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {sortedUsers.map((u) => (
                <li
                  key={u.id}
                  className="grid grid-cols-[1fr_1fr_7rem] items-center gap-2 px-3 py-1"
                >
                  <span className="truncate text-sm font-bold text-slate-800">
                    {u.name}
                  </span>
                  <span
                    className="truncate text-center text-sm tabular-nums text-slate-600"
                    dir="ltr"
                  >
                    {u.password}
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-600">
                      {text.roleOptions[u.role]}
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
