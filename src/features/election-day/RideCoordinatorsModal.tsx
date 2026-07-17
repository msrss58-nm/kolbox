import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui/Toast";
import type { RideCoordinator } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

export function RideCoordinatorsModal({
  open,
  onClose,
  coordinators,
  onAdd,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  coordinators: RideCoordinator[];
  onAdd: (input: { name: string; phone: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    if (!name.trim() || !phone.trim()) {
      toast.error(ELECTION_DAY_TEXT.coordinatorsManager.toast.invalid);
      return;
    }
    setBusy(true);
    try {
      await onAdd({ name: name.trim(), phone: phone.trim() });
      setName("");
      setPhone("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={ELECTION_DAY_TEXT.coordinatorsManager.modalTitle}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={ELECTION_DAY_TEXT.coordinatorsManager.nameLabel}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={ELECTION_DAY_TEXT.coordinatorsManager.namePlaceholder}
            />
          </Field>
          <Field label={ELECTION_DAY_TEXT.coordinatorsManager.phoneLabel}>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={ELECTION_DAY_TEXT.coordinatorsManager.phonePlaceholder}
              dir="ltr"
            />
          </Field>
        </div>
        <Button className="w-full" loading={busy} onClick={handleAdd}>
          ➕ {ELECTION_DAY_TEXT.coordinatorsManager.addButton}
        </Button>

        {coordinators.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title={ELECTION_DAY_TEXT.coordinatorsManager.empty}
          />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-100">
            {coordinators.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-slate-800">{c.name}</p>
                  <p className="text-xs tabular-nums text-slate-500" dir="ltr">
                    {c.phone}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void onDelete(c.id)}
                  aria-label={ELECTION_DAY_TEXT.coordinatorsManager.deleteAriaLabel}
                  className="touch-target grid shrink-0 place-items-center rounded-lg text-lg text-slate-400 hover:bg-opponent-soft hover:text-opponent"
                >
                  🗑️
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
