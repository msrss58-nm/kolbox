import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { COMMON_TEXT } from "../../constants/common-text";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { isValidIsraeliPhone, normalizeIsraeliPhone } from "../../lib/phone";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.phoneEditor;

/** Opened from within the already-open `ElectionDayContactModal` (a Modal
 * nested inside a Modal - see the nesting-safety fix in `components/ui/Modal.tsx`).
 * Updates only this one voter's `phone` field via `onSave`, never the rest of
 * the record. */
export function PhoneEditDialog({
  open,
  onClose,
  contact,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  contact: ElectionDayVoter | null;
  busy: boolean;
  onSave: (id: string, phone: string) => Promise<unknown>;
}) {
  const [wasOpen, setWasOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Render-phase reset (per CLAUDE.md's setState-in-effect convention): every
  // closed->open transition re-syncs the draft to the contact's current phone,
  // so a prior cancel never leaves a stale typed value behind on reopen.
  if (open && !wasOpen) {
    setWasOpen(true);
    setValue(contact?.phone ?? "");
    setError(null);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const fullName = contact ? `${contact.firstName} ${contact.lastName}` : "";
  const isAdding = !contact?.phone;

  const handleSave = async () => {
    if (!contact) return;
    const normalized = normalizeIsraeliPhone(value);
    if (!isValidIsraeliPhone(normalized)) {
      setError(text.invalidPhone);
      return;
    }
    setError(null);
    const result = await onSave(contact.id, normalized);
    if (result) onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAdding ? text.addTitle : text.editTitle}
    >
      {contact && (
        <div className="space-y-4">
          <p className="text-sm font-semibold text-slate-700">{fullName}</p>
          <Field label={text.phoneLabel} error={error ?? undefined}>
            <Input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              placeholder={text.phonePlaceholder}
              dir="ltr"
              invalid={!!error}
              autoFocus
            />
          </Field>
          <div className="flex gap-2">
            <Button loading={busy} onClick={() => void handleSave()} className="flex-1">
              {text.saveButton}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {COMMON_TEXT.cancel}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
