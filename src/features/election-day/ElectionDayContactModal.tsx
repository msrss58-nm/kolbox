import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { fieldClasses } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { APP_CONFIG } from "../../constants/config";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { telHref } from "../../lib/phone";
import { cn } from "../../lib/utils";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { isReminderActive } from "./reminderStatus";
import { ReminderMenu } from "./ReminderMenu";

/** Free-text notes with a debounced autosave - mirrors the reference app's
 * behavior (save ~800ms after typing stops, small status label). Tracks the
 * currently-open contact's id (render-phase compare, per CLAUDE.md) so the
 * draft resets whenever a different contact's modal opens, since this is one
 * long-lived component instance reused across every row's modal open. */
function NotesField({
  contact,
  onSave,
}: {
  contact: ElectionDayVoter;
  onSave: (id: string, notes: string) => void;
}) {
  const [draft, setDraft] = useState(contact.notes);
  const [trackedId, setTrackedId] = useState(contact.id);
  const [hasEdited, setHasEdited] = useState(false);
  if (contact.id !== trackedId) {
    setTrackedId(contact.id);
    setDraft(contact.notes);
    setHasEdited(false);
  }

  const debouncedDraft = useDebouncedValue(draft, APP_CONFIG.electionDayNotesAutosaveMs);
  const savedRef = useRef(contact.notes);
  useEffect(() => {
    if (debouncedDraft === savedRef.current) return;
    savedRef.current = debouncedDraft;
    onSave(contact.id, debouncedDraft);
  }, [debouncedDraft, contact.id, onSave]);

  const isPending = hasEdited && draft !== debouncedDraft;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700">
          {ELECTION_DAY_TEXT.notes.label}
        </span>
        {hasEdited && (
          <span className="text-xs font-semibold text-primary-600">
            {isPending ? ELECTION_DAY_TEXT.notes.saving : ELECTION_DAY_TEXT.notes.saved}
          </span>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setHasEdited(true);
        }}
        placeholder={ELECTION_DAY_TEXT.notes.placeholder}
        rows={3}
        className={cn(fieldClasses, "h-auto resize-none py-2.5")}
      />
    </div>
  );
}

export function ElectionDayContactModal({
  contact,
  onClose,
  onToggleRideRequested,
  onSendToDriver,
  onCancelRideCoordination,
  onSetReminder,
  onCancelReminder,
  onToggleVoted,
  onSetNotes,
}: {
  contact: ElectionDayVoter | null;
  onClose: () => void;
  onToggleRideRequested: (contact: ElectionDayVoter) => void;
  onSendToDriver: (contact: ElectionDayVoter) => void;
  onCancelRideCoordination: (contact: ElectionDayVoter) => void;
  onSetReminder: (contact: ElectionDayVoter, minutes: number) => void;
  onCancelReminder: (contact: ElectionDayVoter) => void;
  onToggleVoted: (contact: ElectionDayVoter, voted: boolean) => void;
  onSetNotes: (id: string, notes: string) => void;
}) {
  const fullName = contact ? `${contact.firstName} ${contact.lastName}` : "";
  const address = contact
    ? [contact.street, contact.houseNumber || ""].filter(Boolean).join(" ")
    : "";
  const reminderActive = isReminderActive(contact?.reminderAt ?? null);

  return (
    <Modal open={contact !== null} onClose={onClose} title={fullName}>
      {contact && (
        <div className="space-y-5">
          <div className="space-y-2 rounded-xl bg-slate-50 p-3.5 text-sm">
            {(contact.city || address) && (
              <p className="text-slate-700">
                📍{" "}
                <span className="font-semibold">
                  {ELECTION_DAY_TEXT.list.columns.address}:
                </span>{" "}
                {[contact.city, address].filter(Boolean).join(" · ")}
              </p>
            )}
            {contact.masad && (
              <p className="text-slate-700">
                🆔{" "}
                <span className="font-semibold">
                  {ELECTION_DAY_TEXT.list.columns.masad}:
                </span>{" "}
                {contact.masad}
              </p>
            )}
            <p className="text-slate-700">
              📞{" "}
              <span className="font-semibold">
                {ELECTION_DAY_TEXT.list.columns.phone}:
              </span>{" "}
              {contact.phone ? (
                <span dir="ltr" className="tabular-nums">
                  {contact.phone}
                </span>
              ) : (
                <span className="text-slate-400">{ELECTION_DAY_TEXT.modal.noPhone}</span>
              )}
            </p>
            <p className="text-slate-700">
              👤{" "}
              <span className="font-semibold">
                {ELECTION_DAY_TEXT.coordinatorFilter.label}:
              </span>{" "}
              {contact.coordinator}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Button
              className="w-full bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
              disabled={!contact.phone}
              onClick={() => {
                if (contact.phone) window.location.href = telHref(contact.phone);
              }}
            >
              📞 {ELECTION_DAY_TEXT.modal.call}
            </Button>
            <Button
              variant={contact.voted ? "secondary" : "primary"}
              className={cn("w-full", contact.voted && "text-slate-600")}
              onClick={() => onToggleVoted(contact, !contact.voted)}
            >
              {contact.voted
                ? `↩️ ${ELECTION_DAY_TEXT.voted.unmarkButton}`
                : `👍 ${ELECTION_DAY_TEXT.voted.markButton}`}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <ReminderMenu onSelect={(minutes) => onSetReminder(contact, minutes)} />
            <Button
              variant="danger"
              disabled={!reminderActive}
              onClick={() => onCancelReminder(contact)}
            >
              ❌ {ELECTION_DAY_TEXT.reminder.cancelButton}
            </Button>
          </div>
          {reminderActive && contact.reminderAt && (
            <p className="-mt-3 text-sm font-bold text-amber-500">
              ⏰{" "}
              {ELECTION_DAY_TEXT.reminder.activeLabel(
                new Date(contact.reminderAt).toLocaleTimeString("he-IL", {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              )}
            </p>
          )}

          <div className="grid grid-cols-3 gap-2.5">
            <Button
              className="w-full bg-[#ff9800] text-white hover:bg-[#f08c00] active:bg-[#db7d00]"
              onClick={() => onToggleRideRequested(contact)}
            >
              {ELECTION_DAY_TEXT.modal.rideRequestButton}
            </Button>
            <Button
              className="w-full bg-[#ff9800] text-white hover:bg-[#f08c00] active:bg-[#db7d00]"
              onClick={() => onSendToDriver(contact)}
            >
              🚗 {ELECTION_DAY_TEXT.driver.sendButton}
            </Button>
            <Button
              variant="danger"
              disabled={!contact.rideArranged && !contact.rideRequested}
              onClick={() => onCancelRideCoordination(contact)}
            >
              {ELECTION_DAY_TEXT.modal.cancelCoordinationButton}
            </Button>
          </div>
          {contact.rideRequested && (
            <p className="-mt-3 text-sm font-bold text-amber-500">
              ⚠️ {ELECTION_DAY_TEXT.modal.rideRequestActiveLabel}
            </p>
          )}
          {contact.rideArranged && (
            <p className="-mt-3 text-sm font-bold text-emerald-600">
              ✅ {ELECTION_DAY_TEXT.modal.coordinatedLabel}
            </p>
          )}

          <NotesField contact={contact} onSave={onSetNotes} />
        </div>
      )}
    </Modal>
  );
}
