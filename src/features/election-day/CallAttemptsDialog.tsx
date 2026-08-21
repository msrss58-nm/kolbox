import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

const text = ELECTION_DAY_TEXT.callAttempts;

/**
 * Auto-opened, non-dismissible decision dialog shown when the no-answer
 * streak reaches a checkpoint (3, then capped at 6). There is no valid "do
 * nothing" outcome here - `Modal`'s `dismissible={false}` removes the X
 * button, backdrop-click-close, and Escape-close, so the only way out is
 * choosing one of the option(s) below.
 *
 * `canCloseAsNoAnswer` hides "close as לא עונה" for a role that can't reach
 * this dialog's own trigger to begin with - the caller passes
 * `can("voter.viewPhone")`, the same permission that gates dialing and
 * recording every call outcome, so a role that can dial/record outcomes
 * can always finish the case it produced without needing `voter.markVoted`
 * (Call Outcome Tracking's 6/6-cap fix - closing as לא עונה never touches
 * `voted`/`voted_at`, so it doesn't belong behind the voting permission).
 * `canExtend` (false once the threshold already reached the 6 cap) hides
 * "continue attempts" entirely - no further extension is offered past the
 * 6th checkpoint, it must close as לא עונה.
 *
 * `isFinal && !canCloseAsNoAnswer` is a defensive fallback for a
 * combination that shouldn't be reachable in practice now that both flow
 * from the same `voter.viewPhone` check (a role that can trigger this
 * dialog can always close it) - kept in case that assumption ever changes,
 * so the UI degrades to a plain dismissible acknowledgment instead of a
 * forced choice with nothing to press, rather than assuming it can never
 * happen.
 */
export function CallAttemptsDialog({
  open,
  voterName,
  canCloseAsNoAnswer,
  canExtend,
  busy = false,
  onCloseAsNoAnswer,
  onContinue,
}: {
  open: boolean;
  voterName: string;
  canCloseAsNoAnswer: boolean;
  canExtend: boolean;
  busy?: boolean;
  onCloseAsNoAnswer: () => void;
  onContinue: () => void;
}) {
  const isFinal = !canExtend;
  const noEscape = isFinal && !canCloseAsNoAnswer;
  return (
    <Modal
      open={open}
      onClose={onContinue}
      title={text.dialogTitle(isFinal)}
      dismissible={noEscape}
    >
      <div className="space-y-5">
        <p className="whitespace-pre-line text-sm text-slate-700">
          {noEscape
            ? text.dialogBodyNoPermission(voterName)
            : text.dialogBody(voterName, isFinal)}
        </p>
        <div className="flex flex-col gap-2.5">
          {canCloseAsNoAnswer && (
            <Button variant="danger" disabled={busy} onClick={onCloseAsNoAnswer}>
              {text.closeAsNoAnswerButton}
            </Button>
          )}
          {canExtend && (
            <Button variant="secondary" disabled={busy} onClick={onContinue}>
              {text.continueButton}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
