import { COMMON_TEXT } from "../../constants/common-text";
import { Button } from "./Button";
import { Modal } from "./Modal";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{message}</p>
        <div className="flex gap-2">
          <Button
            variant={danger ? "danger" : "primary"}
            loading={busy}
            onClick={onConfirm}
            className="flex-1"
          >
            {confirmLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            {COMMON_TEXT.cancel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
