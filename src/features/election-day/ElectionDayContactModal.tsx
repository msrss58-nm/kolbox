import { useEffect, useMemo, useRef, useState } from "react";
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
import { resolveFollowUpStatus } from "./followUpStatus";
import { PhoneEditDialog } from "./PhoneEditDialog";
import { formatReminderDisplay } from "./reminderDisplay";
import { resolveReminderLifecycleState } from "./reminderLifecycle";
import { ReminderMenu } from "./ReminderMenu";

/** Free-text notes with a debounced autosave - mirrors the reference app's
 * behavior (save ~800ms after typing stops, small status label). Tracks the
 * currently-open contact's id (render-phase compare, per CLAUDE.md) so the
 * draft resets whenever a different contact's modal opens, since this is one
 * long-lived component instance reused across every row's modal open.
 *
 * Notes UX cleanup: collapsed by default behind a compact "הוסף הערה"
 * trigger - the textarea only mounts once actually requested, but an
 * existing saved note is still shown as plain read-only text right below
 * the trigger even while collapsed, so it's never hidden, only the EDIT
 * control is. Same `onSave`/debounce persistence path as before - purely a
 * display change. */
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
  const [expanded, setExpanded] = useState(false);
  if (contact.id !== trackedId) {
    setTrackedId(contact.id);
    setDraft(contact.notes);
    setHasEdited(false);
    setExpanded(false);
  }

  const debouncedDraft = useDebouncedValue(draft, APP_CONFIG.electionDayNotesAutosaveMs);
  const savedRef = useRef(contact.notes);
  useEffect(() => {
    if (debouncedDraft === savedRef.current) return;
    savedRef.current = debouncedDraft;
    onSave(contact.id, debouncedDraft);
  }, [debouncedDraft, contact.id, onSave]);

  const isPending = hasEdited && draft !== debouncedDraft;

  if (!expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-h-11 w-full items-center gap-1.5 text-sm font-semibold text-slate-700 hover:text-primary-600"
        >
          <Pencil className="size-3.5 shrink-0" />
          {ELECTION_DAY_TEXT.notes.addButton}
        </button>
        {contact.notes && (
          <p className="mt-0.5 whitespace-pre-line text-sm text-slate-600">
            {contact.notes}
          </p>
        )}
      </div>
    );
  }

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
        autoFocus
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
  onLoadReminderEvents,
  onToggleVoted,
  onSetNonVotingReason,
  onCloseCallAsNoAnswer,
  nonVotingReasons,
  onSetNotes,
  onSetPhone,
  settingPhone,
  onIncrementCallAttempts,
  incrementingCallAttempts,
  onRecordNoAnswer,
  onRecordCallAnswered,
  recordingCallOutcome,
  onExtendNoAnswerStreakThreshold,
}: {
  contact: ElectionDayVoter | null;
  onClose: () => void;
  onToggleRideRequested: (contact: ElectionDayVoter) => void;
  onSendToDriver: (contact: ElectionDayVoter) => void;
  onCancelRideCoordination: (contact: ElectionDayVoter) => void;
  onSetReminder: (contact: ElectionDayVoter, minutes: number) => void;
  onSetReminderAt: (contact: ElectionDayVoter, at: Date) => void;
  onCancelReminder: (contact: ElectionDayVoter) => void;
  /** Reminder Lifecycle v1: loads this contact's full reminder audit trail
   * (created/closed/cancelled/rescheduled) - fetched lazily, only on first
   * expand of the history section (this modal is reused across every row,
   * so an unconditional fetch on every open would be wasteful). */
  onLoadReminderEvents: (contactId: string) => Promise<ReminderEvent[]>;
  onToggleVoted: (contact: ElectionDayVoter, voted: boolean) => void;
  /** `reasonId: null` clears the selection. Gated on `voter.markVoted` by the
   * caller (`useElectionDay.ts`'s `setNonVotingReason`) - only wired to the
   * voted-toggle-area reason dropdown below, which is itself only rendered
   * for `voter.markVoted` holders. */
  onSetNonVotingReason: (id: string, reasonId: string | null) => void;
  /** Call Outcome Tracking: the 6/6-cap "close as לא עונה" action from
   * `CallAttemptsDialog`, gated on `voter.viewPhone` instead of
   * `onSetNonVotingReason` above's `voter.markVoted` (`useElectionDay.ts`'s
   * `closeCallAsNoAnswer`) since finishing an exhausted call is a
   * call-handling action, not a voting one - a role that can dial/record
   * outcomes but not mark voted must still be able to close this out.
   * Deliberately a separate prop (not a shared handler with a
   * permission-override parameter) so each call site's permission boundary
   * is visible at its own call site, not threaded through. Takes only `id`
   * - the trusted `close_call_as_no_answer` action (Multi-Tenant Phase 4B
   * Frontend Cutover) resolves the workspace's "לא עונה" catalog row
   * server-side, unlike `onSetNonVotingReason`'s client-computed
   * `reasonId`. */
  onCloseCallAsNoAnswer: (id: string) => void;
  nonVotingReasons: readonly NonVotingReason[];
  onSetNotes: (id: string, notes: string) => void;
  onSetPhone: (id: string, phone: string) => Promise<unknown>;
  settingPhone: boolean;
  /** Fired on every call-button click (the dial attempt itself) - resolves
   * to the updated voter so the caller can tell whether the threshold was
   * just reached. */
  onIncrementCallAttempts: (id: string) => Promise<ElectionDayVoter | undefined>;
  /** UI-level defense-in-depth against rapid double-click while an increment
   * request is in flight - the DB-side WHERE guard on
   * election_day_increment_call_attempts is the actual source of truth,
   * this just avoids firing a redundant request. */
  incrementingCallAttempts: boolean;
  /** Call Outcome Tracking: explicit "❌ לא ענה" for the most recent dial -
   * only usable while `contact.pendingCallId` is set (a real, unresolved
   * dial exists). Resolves to the updated voter so the caller can tell
   * whether the no-answer checkpoint was just reached. */
  onRecordNoAnswer: (id: string, callId: string) => Promise<ElectionDayVoter | undefined>;
  /** Call Outcome Tracking: explicit "✅ ענה" for the most recent dial - same
   * `pendingCallId` gate as `onRecordNoAnswer`. */
  onRecordCallAnswered: (
    id: string,
    callId: string,
  ) => Promise<ElectionDayVoter | undefined>;
  /** UI-level defense-in-depth against rapid double-submit on either outcome
   * button - the RPCs' own `pending_call_id` guard is the actual source of
   * truth, this just avoids firing a redundant request. */
  recordingCallOutcome: boolean;
  onExtendNoAnswerStreakThreshold: (id: string) => Promise<ElectionDayVoter | undefined>;
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

  const showCall = can("voter.viewPhone");
  const showVotedToggle = can("voter.markVoted");

  // Final 6/6 State-Safety Fix: reuses the existing resolveFollowUpStatus()
  // "closed" branch (a non-voting reason with requiresFollowUp: false) -
  // the same predicate the worklist filter/reports already use - rather
  // than inventing a separate "is this call case closed" flag. Reopening a
  // closed case must be an explicit future action, never an accidental
  // side effect of dialing, so the call button/outcome buttons are simply
  // not offered while closed (mirrored server-side in the 3 call-outcome
  // RPCs, which independently refuse to act on a closed voter too).
  const reasonsById = useMemo(
    () => new Map(nonVotingReasons.map((r) => [r.id, r])),
    [nonVotingReasons],
  );
  const isCaseClosed = contact
    ? resolveFollowUpStatus(contact, reasonsById) === "closed"
    : false;

  const showRideActions = can("voter.manageRide");
  const showRideStatus = can("voter.viewRideStatus");

  return (
    <Modal open={contact !== null} onClose={onClose} title={fullName}>
      {contact && (
        <div className="space-y-4">
          {/* Voter identity - calm neutral surface, no color competition. */}
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

          {/* Due reminder - restrained status block near the top, shown only
           * while actually due (a future reminder's time/date is shown
           * further down, alongside its own change/cancel controls). */}
          <PermissionGuard permission="voter.viewReminderStatus">
            {reminderState === "due" && (
              <div className="flex items-center gap-2.5 rounded-xl bg-rose-50 px-3.5 py-2.5 ring-1 ring-rose-100">
                <span className="text-lg" aria-hidden>
                  ⏰
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-rose-700">
                    {ELECTION_DAY_TEXT.reminder.dueLabel}
                  </p>
                  {contact.reminderAt && (
                    <p className="text-xs text-rose-600">
                      {formatReminderDisplay(contact.reminderAt)}
                    </p>
                  )}
                </div>
              </div>
            )}
          </PermissionGuard>

          {/* Call - the one dominant, colorful primary action in this modal.
           * Outcome buttons only appear once a real, unresolved dial exists
           * (`pendingCallId`) - dialing alone never implies an outcome.
           * Final 6/6 State-Safety Fix: once the case is closed, the call
           * affordance is replaced entirely by a status line - no dial, no
           * outcome buttons, ever, until an explicit future reopen action
           * exists. */}
          {showCall && (
            <div className="space-y-2">
              {isCaseClosed ? (
                <p className="rounded-xl bg-slate-100 px-4 py-3 text-center text-sm font-semibold text-slate-500">
                  {ELECTION_DAY_TEXT.modal.caseClosedLabel}
                </p>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={!contact.phone || incrementingCallAttempts}
                  onClick={() => {
                    if (!contact.phone) return;
                    // Navigation is immediate/synchronous - the attempt
                    // counter is a fire-and-forget side effect that must
                    // never delay dialing. Dialing alone never means
                    // "no answer" - the outcome buttons below (which this
                    // enables, via the fresh pendingCallId the RPC
                    // returns) are the only thing that can advance or
                    // reset the no-answer streak.
                    window.location.href = telHref(contact.phone);
                    void onIncrementCallAttempts(contact.id);
                  }}
                >
                  📞 {ELECTION_DAY_TEXT.modal.call}
                </Button>
              )}

              {/* Call Outcome Tracking: only usable while a real, unresolved
               * dial exists - never a standalone action. Neutral styling for
               * both outcomes (neither is "destructive") - red is reserved
               * for cancel/delete actions elsewhere in this modal. */}
              {!isCaseClosed && contact.pendingCallId && (
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="secondary"
                    disabled={recordingCallOutcome}
                    onClick={() => {
                      const callId = contact.pendingCallId;
                      if (!callId) return;
                      void onRecordNoAnswer(contact.id, callId).then((updated) => {
                        if (
                          updated &&
                          updated.noAnswerStreak === updated.noAnswerStreakThreshold
                        ) {
                          setCallAttemptsDialogOpen(true);
                        }
                      });
                    }}
                  >
                    ❌ {ELECTION_DAY_TEXT.callAttempts.noAnswerButton}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={recordingCallOutcome}
                    onClick={() => {
                      const callId = contact.pendingCallId;
                      if (!callId) return;
                      void onRecordCallAnswered(contact.id, callId);
                    }}
                  >
                    ✅ {ELECTION_DAY_TEXT.callAttempts.answeredButton}
                  </Button>
                </div>
              )}

              {/* Counters - secondary information, always both visible
               * together (the active streak, and the raw total dial count)
               * so neither reads as more authoritative than the other. */}
              <div className="flex items-center justify-between px-0.5 text-xs font-semibold tabular-nums text-slate-400">
                <span dir="ltr">
                  {ELECTION_DAY_TEXT.callAttempts.streakLabel(
                    contact.noAnswerStreak,
                    contact.noAnswerStreakThreshold,
                  )}
                </span>
                <span dir="ltr">
                  {ELECTION_DAY_TEXT.callAttempts.totalCount(contact.callAttempts)}
                </span>
              </div>
            </div>
          )}

          {showVotedToggle && (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => onToggleVoted(contact, !contact.voted)}
            >
              {contact.voted
                ? `↩️ ${ELECTION_DAY_TEXT.voted.unmarkButton}`
                : `👍 ${ELECTION_DAY_TEXT.voted.markButton}`}
            </Button>
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

          {/* Reminder - one clean section: the existing reminder's time (only
           * while "future" - the "due" state's own restrained block already
           * ran near the top), the change/cancel controls, and the
           * collapsible history. Reschedule reuses the same ReminderMenu as
           * a fresh reminder - relabeled (never phrased as "add a new
           * reminder") since at most one is ever active per voter (a single
           * `reminder_at` column - there is structurally no way to hold two
           * at once). Cancel stays the one red action here - the only
           * destructive one in this section. */}
          {(can("voter.viewReminderStatus") || can("voter.manageReminder")) && (
            <div className="space-y-2 rounded-xl bg-slate-50 p-3.5">
              <PermissionGuard permission="voter.viewReminderStatus">
                {reminderState === "future" && contact.reminderAt && (
                  <p className="text-sm font-semibold text-amber-600">
                    ⏰{" "}
                    {ELECTION_DAY_TEXT.reminder.activeLabel(
                      formatReminderDisplay(contact.reminderAt),
                    )}
                  </p>
                )}
              </PermissionGuard>
              <PermissionGuard permission="voter.manageReminder">
                <div className="flex gap-2">
                  <ReminderMenu
                    reminderAt={contact.reminderAt}
                    onSelect={(minutes) => onSetReminder(contact, minutes)}
                    onSelectCustom={(at) => onSetReminderAt(contact, at)}
                    label={
                      reminderState === "future" || reminderState === "due"
                        ? ELECTION_DAY_TEXT.reminder.rescheduleButton
                        : undefined
                    }
                    triggerVariant="secondary"
                    triggerClassName="w-full"
                  />
                  {(reminderState === "future" || reminderState === "due") && (
                    // "✓ סמן כטופל" removed (Call Outcome Tracking) - it had
                    // no valid meaning in the answered/no-answer flow (an
                    // open reminder is now only ever closed by voting, a
                    // case-closing non-voting reason, or this explicit
                    // cancel). Historical `reminderClosedReason: "handled"`
                    // rows/the underlying RPC are untouched - see
                    // `useElectionDay.ts`'s `closeReminder`.
                    <Button variant="danger" onClick={() => onCancelReminder(contact)}>
                      {ELECTION_DAY_TEXT.reminder.cancelButton}
                    </Button>
                  )}
                </div>
              </PermissionGuard>

              {/* Reminder Lifecycle v1: collapsible per-contact audit trail -
               * default collapsed (this modal is already long, per
               * NotesField's doc comment above about being reused across
               * many rows) and fetched lazily on first expand only. */}
              <PermissionGuard permission="voter.viewReminderHistory">
                <div className="-mx-3.5 -mb-3.5 overflow-hidden rounded-b-xl border-t border-slate-200">
                  <button
                    type="button"
                    onClick={toggleHistory}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    <span>{ELECTION_DAY_TEXT.reminder.history.sectionTitle}</span>
                    {historyOpen ? (
                      <ChevronUp className="size-4 shrink-0" />
                    ) : (
                      <ChevronDown className="size-4 shrink-0" />
                    )}
                  </button>
                  {historyOpen && (
                    <div className="space-y-1.5 px-3.5 pb-3.5">
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
                            {/* `actorName` is denormalized audit text, never
                             * a verified identity - see the constant's own
                             * doc comment - so it's shown as a plain line,
                             * never with any "verified" styling, and skipped
                             * entirely when null rather than showing a
                             * fabricated "unknown" placeholder. */}
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
            </div>
          )}

          {/* Transportation - one compact section: current status first,
           * then the existing required actions. Cancel is the only
           * destructive control here, so it's the only red one. */}
          {(showRideActions || showRideStatus) && (
            <div className="space-y-2.5 rounded-xl bg-slate-50 p-3.5">
              {showRideStatus && (
                <p
                  className={cn(
                    "text-sm font-bold",
                    contact.rideArranged
                      ? "text-emerald-600"
                      : contact.rideRequested
                        ? "text-amber-600"
                        : "text-slate-400",
                  )}
                >
                  {contact.rideArranged
                    ? `✅ ${ELECTION_DAY_TEXT.modal.coordinatedLabel}`
                    : contact.rideRequested
                      ? `⚠️ ${ELECTION_DAY_TEXT.modal.rideRequestActiveLabel}`
                      : ELECTION_DAY_TEXT.status.notArranged}
                </p>
              )}
              {showRideActions && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => onToggleRideRequested(contact)}
                    >
                      {ELECTION_DAY_TEXT.modal.rideRequestButton}
                    </Button>
                    <Button variant="secondary" onClick={() => onSendToDriver(contact)}>
                      🚗 {ELECTION_DAY_TEXT.driver.sendButton}
                    </Button>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full"
                    disabled={!contact.rideArranged && !contact.rideRequested}
                    onClick={() => onCancelRideCoordination(contact)}
                  >
                    {ELECTION_DAY_TEXT.modal.cancelCoordinationButton}
                  </Button>
                </>
              )}
            </div>
          )}

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
            canCloseAsNoAnswer={showCall}
            canExtend={contact.noAnswerStreakThreshold === 3}
            onCloseAsNoAnswer={() => {
              onCloseCallAsNoAnswer(contact.id);
              setCallAttemptsDialogOpen(false);
            }}
            onContinue={() => {
              void onExtendNoAnswerStreakThreshold(contact.id);
              setCallAttemptsDialogOpen(false);
            }}
          />
        </div>
      )}
    </Modal>
  );
}
