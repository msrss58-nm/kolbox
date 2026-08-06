import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, fieldClasses, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { APP_CONFIG } from "../../constants/config";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { telHref } from "../../lib/phone";
import { cn } from "../../lib/utils";
import { PermissionGuard } from "../../permissions/PermissionGuard";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter, NonVotingReason } from "../../types";
import { CallAttemptsDialog } from "./CallAttemptsDialog";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { PhoneEditDialog } from "./PhoneEditDialog";
import { formatReminderDisplay } from "./reminderDisplay";
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
  onSetReminderAt,
  onCancelReminder,
  onToggleVoted,
  onSetNonVotingReason,
  nonVotingReasons,
  onSetNotes,
  onSetPhone,
  settingPhone,
  onIncrementCallAttempts,
  onExtendCallAttemptsThreshold,
}: {
  contact: ElectionDayVoter | null;
  onClose: () => void;
  onToggleRideRequested: (contact: ElectionDayVoter) => void;
  onSendToDriver: (contact: ElectionDayVoter) => void;
  onCancelRideCoordination: (contact: ElectionDayVoter) => void;
  onSetReminder: (contact: ElectionDayVoter, minutes: number) => void;
  onSetReminderAt: (contact: ElectionDayVoter, at: Date) => void;
  onCancelReminder: (contact: ElectionDayVoter) => void;
  onToggleVoted: (contact: ElectionDayVoter, voted: boolean) => void;
  /** `reasonId: null` clears the selection. */
  onSetNonVotingReason: (id: string, reasonId: string | null) => void;
  nonVotingReasons: readonly NonVotingReason[];
  onSetNotes: (id: string, notes: string) => void;
  onSetPhone: (id: string, phone: string) => Promise<unknown>;
  settingPhone: boolean;
  /** Fired on every call-button click (the dial attempt itself) - resolves
   * to the updated voter so the caller can tell whether the threshold was
   * just reached. */
  onIncrementCallAttempts: (id: string) => Promise<ElectionDayVoter | undefined>;
  onExtendCallAttemptsThreshold: (id: string) => Promise<ElectionDayVoter | undefined>;
}) {
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [callAttemptsDialogOpen, setCallAttemptsDialogOpen] = useState(false);
  const { can } = usePermissions();
  const fullName = contact ? `${contact.firstName} ${contact.lastName}` : "";
  const address = contact
    ? [contact.street, contact.houseNumber || ""].filter(Boolean).join(" ")
    : "";
  const reminderActive = isReminderActive(contact?.reminderAt ?? null);

  // The call + mark-voted row's two buttons are gated by two different
  // permissions (unlike every other action row in this modal, where every
  // button in the row shares one permission) - operations can call but not
  // mark voted, so the grid must collapse to one column instead of leaving
  // an empty cell.
  const showCall = can("voter.viewPhone");
  const showVotedToggle = can("voter.markVoted");

  return (
    <Modal open={contact !== null} onClose={onClose} title={fullName}>
      {contact && (
        <div className="space-y-5">
          <div className="space-y-2 rounded-xl bg-slate-50 p-3.5 text-sm">
            <PermissionGuard permission="voter.viewAddress">
              {(contact.city || address) && (
                <p className="text-slate-700">
                  📍{" "}
                  <span className="font-semibold">
                    {ELECTION_DAY_TEXT.list.columns.address}:
                  </span>{" "}
                  {[contact.city, address].filter(Boolean).join(" · ")}
                </p>
              )}
            </PermissionGuard>
            <PermissionGuard permission="voter.viewMasad">
              {contact.masad && (
                <p className="text-slate-700">
                  🆔{" "}
                  <span className="font-semibold">
                    {ELECTION_DAY_TEXT.list.columns.masad}:
                  </span>{" "}
                  {contact.masad}
                </p>
              )}
            </PermissionGuard>
            <PermissionGuard permission="voter.viewPhone">
              <p className="flex flex-wrap items-center text-slate-700">
                📞{" "}
                <span className="font-semibold">
                  {ELECTION_DAY_TEXT.list.columns.phone}:
                </span>{" "}
                {contact.phone ? (
                  <>
                    <span dir="ltr" className="tabular-nums">
                      {contact.phone}
                    </span>
                    <PermissionGuard permission="voter.editPhone">
                      <button
                        type="button"
                        onClick={() => setPhoneDialogOpen(true)}
                        aria-label={ELECTION_DAY_TEXT.modal.editPhoneAriaLabel}
                        className="touch-target grid size-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </PermissionGuard>
                  </>
                ) : (
                  <PermissionGuard permission="voter.editPhone">
                    <button
                      type="button"
                      onClick={() => setPhoneDialogOpen(true)}
                      className="font-semibold text-primary-600 hover:underline"
                    >
                      {ELECTION_DAY_TEXT.modal.addPhoneButton}
                    </button>
                  </PermissionGuard>
                )}
              </p>
            </PermissionGuard>
            <PermissionGuard permission="voter.viewCoordinator">
              <p className="text-slate-700">
                👤{" "}
                <span className="font-semibold">
                  {ELECTION_DAY_TEXT.coordinatorFilter.label}:
                </span>{" "}
                {contact.coordinator}
              </p>
            </PermissionGuard>
          </div>

          {(showCall || showVotedToggle) && (
            <div
              className={cn(
                "grid gap-2.5",
                showCall && showVotedToggle ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              {showCall && (
                <div className="flex flex-col items-stretch gap-1">
                  <Button
                    className="w-full bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
                    disabled={!contact.phone}
                    onClick={() => {
                      if (!contact.phone) return;
                      // Navigation is immediate/synchronous - the attempt
                      // counter is a fire-and-forget side effect that must
                      // never delay dialing.
                      window.location.href = telHref(contact.phone);
                      void onIncrementCallAttempts(contact.id).then((updated) => {
                        if (
                          updated &&
                          updated.callAttempts === updated.callAttemptsThreshold
                        ) {
                          setCallAttemptsDialogOpen(true);
                        }
                      });
                    }}
                  >
                    📞 {ELECTION_DAY_TEXT.modal.call}
                  </Button>
                  <span
                    dir="ltr"
                    className="self-center text-xs font-semibold tabular-nums text-slate-400"
                  >
                    {ELECTION_DAY_TEXT.callAttempts.count(
                      contact.callAttempts,
                      contact.callAttemptsThreshold,
                    )}
                  </span>
                </div>
              )}
              {showVotedToggle && (
                <Button
                  variant={contact.voted ? "secondary" : "primary"}
                  className={cn("w-full", contact.voted && "text-slate-600")}
                  onClick={() => onToggleVoted(contact, !contact.voted)}
                >
                  {contact.voted
                    ? `↩️ ${ELECTION_DAY_TEXT.voted.unmarkButton}`
                    : `👍 ${ELECTION_DAY_TEXT.voted.markButton}`}
                </Button>
              )}
            </div>
          )}

          {/* Only while not-voted (editing rides on the same voter.markVoted
           * permission as the mark-voted button above - no separate
           * permission by product decision). The reason itself is never
           * cleared when voted flips to true elsewhere - it just stops
           * being offered here, and the value is pre-filled if one was
           * already set (e.g. re-opening after marking not-voted again). */}
          {showVotedToggle && !contact.voted && (
            <Field label={ELECTION_DAY_TEXT.voted.reasonLabel}>
              <Select
                value={contact.notVotingReasonId ?? ""}
                onChange={(e) => onSetNonVotingReason(contact.id, e.target.value || null)}
              >
                <option value="">{ELECTION_DAY_TEXT.voted.reasonNoneOption}</option>
                {nonVotingReasons
                  .filter((r) => r.isActive || r.id === contact.notVotingReasonId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}

          <PermissionGuard permission="voter.manageReminder">
            <div className="grid grid-cols-2 gap-2.5">
              <ReminderMenu
                reminderAt={contact.reminderAt}
                onSelect={(minutes) => onSetReminder(contact, minutes)}
                onSelectCustom={(at) => onSetReminderAt(contact, at)}
              />
              <Button
                variant="danger"
                disabled={!reminderActive}
                onClick={() => onCancelReminder(contact)}
              >
                ❌ {ELECTION_DAY_TEXT.reminder.cancelButton}
              </Button>
            </div>
          </PermissionGuard>
          <PermissionGuard permission="voter.viewReminderStatus">
            {reminderActive && contact.reminderAt && (
              <p className="-mt-3 text-sm font-bold text-amber-500">
                ⏰{" "}
                {ELECTION_DAY_TEXT.reminder.activeLabel(
                  formatReminderDisplay(contact.reminderAt),
                )}
              </p>
            )}
          </PermissionGuard>

          <PermissionGuard permission="voter.manageRide">
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
          </PermissionGuard>
          <PermissionGuard permission="voter.viewRideStatus">
            <>
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
            </>
          </PermissionGuard>

          <PermissionGuard permission="voter.editNotes">
            <NotesField contact={contact} onSave={onSetNotes} />
          </PermissionGuard>

          <PhoneEditDialog
            open={phoneDialogOpen}
            onClose={() => setPhoneDialogOpen(false)}
            contact={contact}
            busy={settingPhone}
            onSave={onSetPhone}
          />

          <CallAttemptsDialog
            open={callAttemptsDialogOpen}
            voterName={fullName}
            canCloseAsNoAnswer={showVotedToggle}
            onCloseAsNoAnswer={() => {
              const noAnswerReason = nonVotingReasons.find(
                (r) => r.name === ELECTION_DAY_TEXT.callAttempts.noAnswerReasonName,
              );
              if (noAnswerReason) onSetNonVotingReason(contact.id, noAnswerReason.id);
              setCallAttemptsDialogOpen(false);
            }}
            onContinue={() => {
              void onExtendCallAttemptsThreshold(contact.id);
              setCallAttemptsDialogOpen(false);
            }}
          />
        </div>
      )}
    </Modal>
  );
}
