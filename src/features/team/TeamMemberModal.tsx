import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { COMMON_TEXT } from "../../constants/common-text";
import { ROLE_LABELS } from "../../constants/labels";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import type { UserRole } from "../../types";
import { TEAM_MODAL_TEXT } from "./team.constants";
import { countManagers, createTeamMember, updateTeamMember } from "./teamActions";
import type { TeamMember } from "./useTeam";

const ASSIGNABLE_ROLES: UserRole[] = ["manager", "activist"];

export function TeamMemberModal({
  open,
  initial,
  currentUserId,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: TeamMember | null; // null = add
  currentUserId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [area, setArea] = useState(initial?.area ?? "");
  const [role, setRole] = useState<UserRole>(initial?.role ?? "activist");

  // Re-seeds the form the moment the modal opens for a (possibly different)
  // member - a render-phase compare instead of a reset effect (sanctioned
  // alternative, see useAsyncData.ts).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(initial?.name ?? "");
      setEmail("");
      setPhone(initial?.phone ?? "");
      setArea(initial?.area ?? "");
      setRole(initial?.role ?? "activist");
    }
  }

  const isSelf = initial?.id === currentUserId;
  const valid = initial
    ? name.trim()
    : name.trim() && email.trim() && area.trim();

  const { run: save, busy: submitting } = useAsyncAction(
    async () => {
      if (initial) {
        if (initial.role === "manager" && role !== "manager") {
          const managers = await countManagers();
          if (managers <= 1) throw new Error(TEAM_MODAL_TEXT.errors.lastManager);
        }
        await updateTeamMember(initial.id, {
          name: name.trim(),
          phone: phone.trim() || null,
          area: area.trim() || null,
          role,
        });
        return { name: name.trim() };
      }
      await createTeamMember({
        email: email.trim(),
        name: name.trim(),
        phone: phone.trim() || undefined,
        area: area.trim() || undefined,
        role,
      });
      return { name: name.trim() };
    },
    {
      successMessage: (result) =>
        initial ? TEAM_MODAL_TEXT.toast.updated : TEAM_MODAL_TEXT.toast.added(result.name),
    },
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    const saved = await save();
    if (saved) {
      onSaved();
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? TEAM_MODAL_TEXT.editTitle : TEAM_MODAL_TEXT.addTitle}
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <Field label={TEAM_MODAL_TEXT.fields.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        {!initial && (
          <Field label={TEAM_MODAL_TEXT.fields.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={TEAM_MODAL_TEXT.placeholders.email}
              dir="ltr"
              required
            />
          </Field>
        )}
        <Field label={TEAM_MODAL_TEXT.fields.phone}>
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={TEAM_MODAL_TEXT.placeholders.phone}
            inputMode="tel"
            dir="ltr"
          />
        </Field>
        <Field label={TEAM_MODAL_TEXT.fields.area}>
          <Input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder={TEAM_MODAL_TEXT.placeholders.area}
            required={!initial}
          />
        </Field>
        <Field label={TEAM_MODAL_TEXT.fields.role}>
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            disabled={isSelf}
          >
            {ASSIGNABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        {!initial && <p className="text-xs text-slate-400">{TEAM_MODAL_TEXT.addHint}</p>}
        <div className="flex gap-2 pt-2">
          <Button type="submit" loading={submitting} disabled={!valid} className="flex-1">
            {initial ? TEAM_MODAL_TEXT.submitEdit : TEAM_MODAL_TEXT.submitAdd}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {COMMON_TEXT.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
