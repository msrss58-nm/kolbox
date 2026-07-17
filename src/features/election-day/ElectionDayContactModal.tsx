import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { fieldClasses } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { APP_CONFIG } from "../../constants/config";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { telHref, whatsAppHref } from "../../lib/phone";
import { cn } from "../../lib/utils";
import type { ElectionDayVoter, RideCoordinator } from "../../types";
import { DriverSelectMenu } from "./DriverSelectMenu";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { isReminderActive } from "./reminderStatus";
import { ReminderMenu } from "./ReminderMenu";

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347z" />
      <path d="M12.05 21.75c-1.987 0-3.936-.535-5.639-1.548l-.404-.24-4.194 1.1 1.12-4.09-.264-.42a9.71 9.71 0 01-1.49-5.19c0-5.37 4.377-9.75 9.755-9.75 2.606 0 5.055 1.017 6.898 2.863a9.679 9.679 0 012.856 6.888c0 5.372-4.376 9.75-9.755 9.75zm0-20.75C5.955 1 1 5.943 1 12.01c0 2.02.545 3.912 1.49 5.55L1 23l5.6-1.467a11.01 11.01 0 005.45 1.417h.005c6.046 0 11-4.943 11-11.01C23.055 5.943 18.1 1 12.05 1z" />
    </svg>
  );
}

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
  onToggleRideArranged,
  onSetReminder,
  onCancelReminder,
  onToggleVoted,
  onSetNotes,
  rideCoordinators,
  onSendToDriver,
}: {
  contact: ElectionDayVoter | null;
  onClose: () => void;
  onToggleRideArranged: (contact: ElectionDayVoter, arranged: boolean) => void;
  onSetReminder: (contact: ElectionDayVoter, minutes: number) => void;
  onCancelReminder: (contact: ElectionDayVoter) => void;
  onToggleVoted: (contact: ElectionDayVoter, voted: boolean) => void;
  onSetNotes: (id: string, notes: string) => void;
  rideCoordinators: RideCoordinator[];
  onSendToDriver: (contact: ElectionDayVoter, coordinatorId: string) => void;
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
              <span dir="ltr" className="tabular-nums">
                {contact.phone}
              </span>
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
              className="w-full bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00]"
              onClick={() => {
                window.location.href = telHref(contact.phone);
              }}
            >
              📞 {ELECTION_DAY_TEXT.modal.call}
            </Button>
            <Button
              className="w-full bg-[#25D366] text-white hover:bg-[#1ebe57] active:bg-[#1aa64d]"
              onClick={() => {
                window.open(
                  whatsAppHref(
                    contact.phone,
                    ELECTION_DAY_TEXT.modal.whatsappMessage(fullName),
                  ),
                  "_blank",
                  "noreferrer",
                );
              }}
            >
              <WhatsAppIcon className="size-4" />
              {ELECTION_DAY_TEXT.modal.whatsapp}
            </Button>
          </div>

          <Button
            variant={contact.voted ? "secondary" : "primary"}
            className={cn("w-full", contact.voted && "text-slate-600")}
            onClick={() => onToggleVoted(contact, !contact.voted)}
          >
            {contact.voted
              ? `↩️ ${ELECTION_DAY_TEXT.voted.notVoted}`
              : `👍 ${ELECTION_DAY_TEXT.voted.voted}`}
          </Button>

          <div className="grid grid-cols-3 gap-2.5">
            <ReminderMenu onSelect={(minutes) => onSetReminder(contact, minutes)} />
            <Button
              variant="danger"
              disabled={!reminderActive}
              onClick={() => onCancelReminder(contact)}
            >
              ❌ {ELECTION_DAY_TEXT.reminder.cancelButton}
            </Button>
            <DriverSelectMenu
              coordinators={rideCoordinators}
              onSelect={(coordinatorId) => onSendToDriver(contact, coordinatorId)}
            />
          </div>
          {reminderActive && contact.reminderAt && (
            <p className="-mt-3 text-xs text-slate-400">
              {ELECTION_DAY_TEXT.reminder.activeLabel(
                new Date(contact.reminderAt).toLocaleTimeString("he-IL", {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              )}
            </p>
          )}

          <Button
            variant={contact.rideArranged ? "secondary" : "primary"}
            className={cn("w-full", contact.rideArranged && "text-slate-600")}
            onClick={() => onToggleRideArranged(contact, !contact.rideArranged)}
          >
            {contact.rideArranged
              ? ELECTION_DAY_TEXT.modal.markNotArranged
              : ELECTION_DAY_TEXT.modal.markArranged}
          </Button>

          <NotesField contact={contact} onSave={onSetNotes} />
        </div>
      )}
    </Modal>
  );
}
