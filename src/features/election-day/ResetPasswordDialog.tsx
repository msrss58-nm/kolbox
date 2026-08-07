import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { toast } from "../../components/ui/Toast";
import type { PermissionUser } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.permissionsManager.resetPassword;

export function ResetPasswordDialog({
  open,
  onClose,
  user,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  /** The `PermissionUser` this dialog resets - `null` while closed/between
   * targets. The dialog is meant to stay mounted once and be re-targeted, not
   * remounted per user - see `NonVotingReasonDrillDownModal.tsx` for the same
   * nullable-target shape. */
  user: PermissionUser | null;
  onReset: (
    targetId: string,
    newPassword: string,
    actorPassword: string,
  ) => Promise<unknown>;
}) {
  const [actorPassword, setActorPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showActorPassword, setShowActorPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  // Render-phase reset (no effect needed) - a fresh target user means any
  // previously-typed passwords no longer apply. Both sides of the comparison
  // are normalized the same way (`?? null`), same pattern as
  // NonVotingReasonDrillDownModal.tsx's `trackedRowId`.
  const [trackedUserId, setTrackedUserId] = useState<string | null>(user?.id ?? null);
  const currentUserId = user?.id ?? null;
  if (currentUserId !== trackedUserId) {
    setTrackedUserId(currentUserId);
    setActorPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowActorPassword(false);
    setShowNewPassword(false);
    setShowConfirmPassword(false);
  }

  if (!user) return null;

  const bothFilled = newPassword.trim() && confirmPassword.trim();
  const mismatch = Boolean(bothFilled && newPassword !== confirmPassword);
  const disabled =
    busy ||
    !newPassword.trim() ||
    !confirmPassword.trim() ||
    !actorPassword.trim() ||
    mismatch;

  const handleSubmit = async () => {
    if (disabled) return;
    setBusy(true);
    try {
      // A blocked (no permission) or failed reset resolves to `undefined` -
      // the caller's guardedAction/useAsyncAction already toasted the
      // failure, so only a defined result gets its own success toast here.
      const result = await onReset(user.id, newPassword, actorPassword);
      if (result !== undefined) {
        toast.success(text.toast.success(user.name));
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={text.dialogTitle}>
      <div className="space-y-5">
        <p className="whitespace-pre-line text-sm text-slate-600">
          {text.dialogBody(user.name)}
        </p>

        <Field label={text.actorPasswordLabel}>
          <div className="flex gap-2">
            <Input
              type={showActorPassword ? "text" : "password"}
              value={actorPassword}
              onChange={(e) => setActorPassword(e.target.value)}
              className="flex-1"
              dir="ltr"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowActorPassword((v) => !v)}
              aria-label={
                showActorPassword
                  ? text.hidePasswordAriaLabel
                  : text.showPasswordAriaLabel
              }
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {showActorPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </Field>

        <Field label={text.newPasswordLabel}>
          <div className="flex gap-2">
            <Input
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="flex-1"
              dir="ltr"
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowNewPassword((v) => !v)}
              aria-label={
                showNewPassword ? text.hidePasswordAriaLabel : text.showPasswordAriaLabel
              }
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {showNewPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </Field>

        <Field
          label={text.confirmPasswordLabel}
          error={mismatch ? text.validation.mismatch : undefined}
        >
          <div className="flex gap-2">
            <Input
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="flex-1"
              dir="ltr"
              autoComplete="new-password"
              invalid={mismatch}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((v) => !v)}
              aria-label={
                showConfirmPassword
                  ? text.hidePasswordAriaLabel
                  : text.showPasswordAriaLabel
              }
              className="touch-target grid shrink-0 place-items-center rounded-xl text-slate-400 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {showConfirmPassword ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </Field>

        <div className="flex gap-2 pt-2">
          <Button
            className="flex-1"
            loading={busy}
            disabled={disabled}
            onClick={() => void handleSubmit()}
          >
            {text.submitButton}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            {text.cancelButton}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
