import { AlertTriangle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import type { MultiEntitySeat } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.multiEntity.form;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One modal for both first provision and replacement - the fields and the
 * request are identical, only the framing differs.
 *
 * The replacement variant puts a blocking warning ABOVE the fields and adds a
 * confirmation step, because the operator has to understand three things the
 * form itself cannot show: assignments carry over, the previous Auth account
 * is NOT deleted, and deleting it is a separate approval. That is also why the
 * confirm step is not `danger` - replacing the seat is reversible by
 * re-provisioning; the irreversible half is the purge, which lives elsewhere.
 */
export function MultiEntityProvisionModal({
  open,
  seat,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** Non-null => replacement mode. */
  seat: MultiEntitySeat | null;
  busy: boolean;
  error: string | null;
  onSubmit: (input: { name: string; email: string; phone?: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const replacing = seat !== null;

  const reset = () => {
    setName("");
    setEmail("");
    setPhone("");
    setLocalError(null);
    setConfirming(false);
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const validate = (): boolean => {
    if (!name.trim()) {
      setLocalError(text.missingName);
      return false;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setLocalError(text.missingEmail);
      return false;
    }
    setLocalError(null);
    return true;
  };

  const submit = () =>
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      // Omitted rather than sent empty: the op body allow-list is exact.
      phone: phone.trim() || undefined,
    });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return; // double-submit guard (the hook guards again server-side of here)
    if (!validate()) return;
    if (replacing) {
      setConfirming(true);
      return;
    }
    submit();
  };

  const shown = localError ?? error;

  return (
    <>
      <Modal
        open={open}
        onClose={close}
        title={replacing ? text.replaceTitle : text.provisionTitle}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {replacing && (
            <div className="space-y-2 rounded-xl bg-potential-soft p-3 ring-1 ring-amber-200">
              <div className="flex items-center gap-2">
                <AlertTriangle className="size-4 shrink-0 text-amber-700" aria-hidden />
                <p className="text-sm font-bold text-amber-900">
                  {text.replaceWarningTitle}
                </p>
              </div>
              <p className="text-sm text-amber-900">
                {text.replaceCurrent(seat.name, seat.email)}
              </p>
              <ul className="list-disc space-y-1 ps-5 text-sm text-amber-900">
                {text.replaceBullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <p className="text-xs font-semibold text-amber-900">
                {text.replaceEmailNote}
              </p>
            </div>
          )}

          {!replacing && <p className="text-sm text-slate-600">{text.subtitle}</p>}

          <Field label={text.nameLabel}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              disabled={busy}
              autoComplete="off"
            />
          </Field>

          <Field label={text.emailLabel}>
            <Input
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              disabled={busy}
              autoComplete="off"
            />
          </Field>

          <Field label={text.phoneLabel}>
            <Input
              type="tel"
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              disabled={busy}
              autoComplete="off"
            />
          </Field>

          {shown && (
            <p role="alert" className="text-sm font-medium text-opponent">
              {shown}
            </p>
          )}

          <Button type="submit" loading={busy} className="w-full">
            {busy
              ? text.submitting
              : replacing
                ? text.submitReplace
                : text.submitProvision}
          </Button>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirming}
        title={text.confirmReplaceTitle}
        message={text.confirmReplaceMessage(name.trim())}
        confirmLabel={text.confirmReplace}
        busy={busy}
        onConfirm={() => {
          setConfirming(false);
          submit();
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
