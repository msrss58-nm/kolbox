import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.callAttempts;

/**
 * Auto-opened, non-dismissible decision dialog shown when a voter's call
 * attempts reach a threshold checkpoint (3, 6, 9…). There is no valid "do
 * nothing" outcome here - `Modal`'s `dismissible={false}` removes the X
 * button, backdrop-click-close, and Escape-close, so the only way out is
 * choosing one of the two options below.
 *
 * `canCloseAsNoAnswer` hides "close as לא עונה" for a role that can't call
 * `setNonVotingReason` (e.g. `operations`, which can call/view but not mark
 * voted) - "continue attempts" stays available to anyone who could open this
 * dialog in the first place (same `voter.viewPhone` gate as the call button).
 */
export function CallAttemptsDialog({
  open,
  voterName,
  canCloseAsNoAnswer,
  busy = false,
  onCloseAsNoAnswer,
  onContinue,
}: {
  open: boolean;
  voterName: string;
  canCloseAsNoAnswer: boolean;
  busy?: boolean;
  onCloseAsNoAnswer: () => void;
  onContinue: () => void;
}) {
  return (
    <Modal open={open} onClose={onContinue} title={text.dialogTitle} dismissible={false}>
      <div className="space-y-5">
        <p className="whitespace-pre-line text-sm text-slate-700">
          {text.dialogBody(voterName)}
        </p>
        <div className="flex flex-col gap-2.5">
          {canCloseAsNoAnswer && (
            <Button variant="danger" disabled={busy} onClick={onCloseAsNoAnswer}>
              {text.closeAsNoAnswerButton}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onContinue}>
            {text.continueButton}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
