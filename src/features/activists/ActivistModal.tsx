import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { COMMON_TEXT } from "../../constants/common-text";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { api } from "../../services/api";
import type { Activist } from "../../types";
import { ACTIVIST_MODAL_TEXT } from "./activists.constants";
import { inviteActivistByEmail } from "./inviteActivist";

export function ActivistModal({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Activist | null; // null = invite a new activist
  onClose: () => void;
  onSaved: (a: Activist) => void;
}) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? "");
  const [lastName, setLastName] = useState(initial?.lastName ?? "");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [area, setArea] = useState(initial?.area ?? "");

  // Re-seeds the form the moment the modal opens for a (possibly different)
  // activist - a render-phase compare instead of a reset effect (sanctioned
  // alternative, see useAsyncData.ts).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFirstName(initial?.firstName ?? "");
      setLastName(initial?.lastName ?? "");
      setEmail("");
      setPhone(initial?.phone ?? "");
      setArea(initial?.area ?? "");
    }
  }

  const valid = initial
    ? firstName.trim() && lastName.trim() && phone.trim() && area.trim()
    : firstName.trim() && lastName.trim() && email.trim() && area.trim();

  const { run: save, busy: submitting } = useAsyncAction(
    async () => {
      if (initial) {
        return api.updateActivist(initial.id, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
          area: area.trim(),
        });
      }
      const info = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        area: area.trim(),
      };
      const userId = await inviteActivistByEmail({
        email: email.trim(),
        name: `${info.firstName} ${info.lastName}`,
        phone: info.phone,
        area: info.area,
      });
      return api.ensureActivistProfile(userId, info);
    },
    {
      successMessage: (saved) =>
        initial
          ? ACTIVIST_MODAL_TEXT.toast.updated
          : ACTIVIST_MODAL_TEXT.toast.invited(`${saved.firstName} ${saved.lastName}`),
    },
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    const saved = await save();
    if (saved) {
      onSaved(saved);
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? ACTIVIST_MODAL_TEXT.editTitle : ACTIVIST_MODAL_TEXT.addTitle}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={ACTIVIST_MODAL_TEXT.fields.firstName}>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </Field>
          <Field label={ACTIVIST_MODAL_TEXT.fields.lastName}>
            <Input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
          </Field>
        </div>
        {!initial && (
          <Field label={ACTIVIST_MODAL_TEXT.fields.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={ACTIVIST_MODAL_TEXT.placeholders.email}
              dir="ltr"
              required
            />
          </Field>
        )}
        <Field label={ACTIVIST_MODAL_TEXT.fields.phone}>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={ACTIVIST_MODAL_TEXT.placeholders.phone}
            inputMode="tel"
            dir="ltr"
            required={!!initial}
          />
        </Field>
        <Field label={ACTIVIST_MODAL_TEXT.fields.area}>
          <Input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder={ACTIVIST_MODAL_TEXT.placeholders.area}
            required
          />
        </Field>
        {!initial && (
          <p className="text-xs text-slate-400">{ACTIVIST_MODAL_TEXT.inviteHint}</p>
        )}
        <div className="flex gap-2 pt-2">
          <Button type="submit" loading={submitting} disabled={!valid} className="flex-1">
            {initial ? ACTIVIST_MODAL_TEXT.submitEdit : ACTIVIST_MODAL_TEXT.submitAdd}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {COMMON_TEXT.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
