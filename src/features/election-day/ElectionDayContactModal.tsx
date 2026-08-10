import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Pencil } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Field, fieldClasses, Select } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { APP_CONFIG } from "../../constants/config";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { telHref } from "../../lib/phone";
import { cn } from "../../lib/utils";
import { PermissionGuard } from "../../permissions/PermissionGuard";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter, NonVotingReason, ReminderEvent } from "../../types";
import { CallAttemptsDialog } from "./CallAttemptsDialog";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { PhoneEditDialog } from "./PhoneEditDialog";
import { formatReminderDisplay } from "./reminderDisplay";
import { resolveReminderLifecycleState } from "./reminderLifecycle";
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
  onCloseReminder,
  onLoadReminderEvents,
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
  /** Reminder Lifecycle v1: closes an outstanding (must be "due") reminder -
   * distinct from `onCancelReminder`, which works for "future" or "due". */
  onCloseReminder: (contact: ElectionDayVoter) => void;
  /** Reminder Lifecycle v1: loads this contact's full reminder audit trail
   * (created/closed/cancelled/rescheduled) - fetched lazily, only on first
   * expand of the history section (this modal is reused across every row,
   * so an unconditional fetch on every open would be wasteful). */
  onLoadReminderEvents: (contactId: string) => Promise<ReminderEvent[]>;
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
  const reminderState = contact ? resolveReminderLifecycleState(contact) : "none";

  // Reminder Lifecycle v1: the history section's own local state - tracked
  // per contact id via the render-phase-compare pattern (see CLAUDE.md /
  // NotesField above) since this modal instance is reused across every
  // row's modal open, not remounted per contact.
  const [historyContactId, setHistoryContactId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<ReminderEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  if (contact && contact.id !== historyContactId) {
    setHistoryContactId(contact.id);
    setHistoryOpen(false);
    setHistoryEvents(null);
    setHistoryLoading(false);
  }

  const toggleHistory = () => {
    if (!contact) return;
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && historyEvents === null && !historyLoading) {
      setHistoryLoading(true);
      void onLoadReminderEvents(contact.id)
        .then(setHistoryEvents)
        .finally(() => setHistoryLoading(false));
    }
  };

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
            {/* Reminder Lifecycle v1: the trigger + reschedule menu always
             * renders full-width on its own row, with an optional
             * close/cancel row stacked below it - chosen over a single
             * 3-across grid so the row never gets cramped at 375px (the
             * "due" state alone adds a 3rd interactive element next to the
             * existing menu + cancel button). */}
            <div className="space-y-2.5">
              <ReminderMenu
                reminderAt={contact.reminderAt}
                onSelect={(minutes) => onSetReminder(contact, minutes)}
                onSelectCustom={(at) => onSetReminderAt(contact, at)}
                label={
                  reminderState === "future" || reminderState === "due"
                    ? ELECTION_DAY_TEXT.reminder.rescheduleButton
                    : undefined
                }
              />
              {(reminderState === "future" || reminderState === "due") && (
                <div className="grid grid-cols-2 gap-2.5">
                  {reminderState === "due" && (
                    <Button
                      className="w-full bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00]"
                      onClick={() => onCloseReminder(contact)}
                    >
                      ✓ {ELECTION_DAY_TEXT.reminder.closeButton}
                    </Button>
                  )}
                  {/* Cancel works for BOTH "future" and "due" now - the old
                   * `disabled={!reminderActive}` bug (which made cancel
                   * unusable once a reminder went overdue) is gone; cancel
                   * simply doesn't render at all outside these 2 states. */}
                  <Button
                    variant="danger"
                    className={cn(reminderState !== "due" && "col-span-2")}
                    onClick={() => onCancelReminder(contact)}
                  >
                    ❌ {ELECTION_DAY_TEXT.reminder.cancelButton}
                  </Button>
                </div>
              )}
            </div>
          </PermissionGuard>
          <PermissionGuard permission="voter.viewReminderStatus">
            {reminderState === "future" && contact.reminderAt && (
              <p className="-mt-3 text-sm font-bold text-amber-500">
                ⏰{" "}
                {ELECTION_DAY_TEXT.reminder.activeLabel(
                  formatReminderDisplay(contact.reminderAt),
                )}
              </p>
            )}
            {reminderState === "due" && (
              <p className="-mt-3 text-sm font-bold text-rose-600">
                ⏰ {ELECTION_DAY_TEXT.reminder.dueLabel}
              </p>
            )}
          </PermissionGuard>

          {/* Reminder Lifecycle v1: collapsible per-contact audit trail -
           * default collapsed (this modal is already long, per NotesField's
           * doc comment above about being reused across many rows) and
           * fetched lazily on first expand only. */}
          <PermissionGuard permission="voter.viewReminderHistory">
            <div className="-mt-1.5 overflow-hidden rounded-xl bg-slate-50">
              <button
                type="button"
                onClick={toggleHistory}
                className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
              >
                <span>{ELECTION_DAY_TEXT.reminder.history.sectionTitle}</span>
                {historyOpen ? (
                  <ChevronUp className="size-4 shrink-0" />
                ) : (
                  <ChevronDown className="size-4 shrink-0" />
                )}
              </button>
              {historyOpen && (
                <div className="space-y-1.5 px-3 pb-3">
                  {historyLoading ? (
                    <div className="flex items-center justify-center py-3">
                      <Loader2 className="size-4 animate-spin text-slate-400" />
                    </div>
                  ) : historyEvents && historyEvents.length > 0 ? (
                    historyEvents.map((event) => (
                      <div
                        key={event.id}
                        className="rounded-lg bg-white p-2 text-xs text-slate-600 ring-1 ring-slate-100"
                      >
                        <p className="font-semibold text-slate-700">
                          {ELECTION_DAY_TEXT.reminder.history.eventLabel[event.eventType]}
                          {" · "}
                          {formatReminderDisplay(event.createdAt)}
                        </p>
                        {event.reason && (
                          <p className="mt-0.5 text-slate-500">
                            {ELECTION_DAY_TEXT.reminder.history.reasonLabel[event.reason]}
                          </p>
                        )}
                        {/* `actorName` is denormalized audit text, never a
                         * verified identity - see the constant's own doc
                         * comment - so it's shown as a plain line, never
                         * with any "verified" styling, and skipped entirely
                         * when null rather than showing a fabricated
                         * "unknown" placeholder. */}
                        {event.actorName && (
                          <p className="mt-0.5 text-slate-400">
                            {ELECTION_DAY_TEXT.reminder.history.actorPrefix(
                              event.actorName,
                            )}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="py-2 text-center text-xs text-slate-400">
                      {ELECTION_DAY_TEXT.reminder.history.empty}
                    </p>
                  )}
                </div>
              )}
            </div>
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
