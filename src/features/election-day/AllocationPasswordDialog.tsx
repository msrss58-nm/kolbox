import { useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.coordinatorAllocation.confirmDialog;

/**
 * Coordinator Allocation Management (Phase 5): the one reusable
 * password-confirmation dialog every allocation mutation (roster
 * add/edit/remove/link/unlink, initial allocation, rebalance, end activity)
 * goes through - mirrors `ResetPasswordDialog.tsx`'s actor-password field
 * exactly, generalized with a caller-supplied title/summary/confirm label
 * instead of one fixed flow.
 *
 * The password is local component state only - never persisted, never
 * logged, cleared on every close AND in `finally` after every submit
 * attempt (success or failure) so a failed attempt never leaves a typed
 * password sitting in memory waiting for a retry.
 */
export function AllocationPasswordDialog({
  open,
  title,
  summary,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  summary: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Resolves to a defined value on success, `undefined` on a blocked/failed
   * attempt (mirrors every `guardedAction`/`useAsyncAction` result in this
   * codebase) - the dialog only closes itself on a defined result. */
  onConfirm: (password: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const clear = () => {
    setPassword("");
    setShowPassword(false);
  };

  const handleCancel = () => {
    clear();
    onCancel();
  };

  const handleSubmit = async () => {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    try {
      const result = await onConfirm(password);
      if (result !== undefined) {
        clear();
      }
    } finally {
      setPassword("");
      setSubmitting(false);
    }
  };

  const isBusy = Boolean(busy) || submitting;

  return (
    <Modal open={open} onClose={handleCancel} title={title}>
      <div className="space-y-5">
        <div className="rounded-xl bg-slate-50 px-3.5 py-3 text-sm text-slate-700">
          {summary}
        </div>

        <Field label={text.passwordLabel}>
          <div className="flex gap-2">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex-1"
              dir="ltr"
              autoComplete="current-password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={
                showPassword ? text.hidePasswordAriaLabel : text.showPasswordAriaLabel
              }
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <div className="flex gap-2 pt-2">
          <Button
            className="flex-1"
            loading={isBusy}
            disabled={!password.trim() || isBusy}
            onClick={() => void handleSubmit()}
          >
            {confirmLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={handleCancel}>
            {text.cancelButton}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
