import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { APP_CONFIG } from "../../constants/config";
import { telHref } from "../../lib/phone";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { resolveOverdueReminderPopups } from "./overdueReminderPopups";
import { formatReminderDisplay } from "./reminderDisplay";
import { ReminderMenu } from "./ReminderMenu";

/**
 * Persistent Reminders: a compact, non-blocking, left-anchored bar
 * ("יש לך N תזכורות לטיפול") that expands, on click, into up to 5
 * overdue-reminder cards - replaces both the old toast-based notification
 * (auto-dismissed after 4s, left no trace after a reload) and an earlier,
 * always-expanded version of this same stack. Every card is purely derived
 * from persisted contact fields via `resolveOverdueReminderPopups` - there
 * is no separate "is this popup dismissed"/"is this expanded" flag tied to
 * any one contact; a card disappears only when its underlying data
 * actually changes (a call attempt, a close, a cancel, or a reschedule),
 * so the bar's count and the expanded list both survive a reload/
 * re-login/navigation exactly like every other derived Election Day view.
 * `expanded` itself is pure UI state (not persisted, not meant to be) -
 * it resets to closed once the count reaches zero, so the bar always
 * starts collapsed the next time a reminder becomes due.
 *
 * Deliberately pinned to the physical LEFT edge (`left-*`, not the RTL
 * logical `start-*`/`ms-*` this codebase otherwise always uses) - an
 * explicit, product-approved exception for this one fixed-corner overlay,
 * not a drift from the RTL convention: it keeps the stack clear of the
 * right-side sidebar/nav and the bottom-center `ToastContainer` regardless
 * of text direction. The expanded panel grows upward from the bar
 * (`flex-col-reverse`) and is height-capped/scrollable so it can never
 * cover the mobile bottom nav or dominate a small screen.
 *
 * Manager visibility: gated on the resolved role's `scopeType` (the same
 * signal `electionDayScope.ts`'s `resolveVisibleContacts` already uses to
 * decide "sees everyone" vs "sees only my own contacts"), not a role
 * name/id check - `scopeType === "all"` (managers, by product decision)
 * never sees these; only a scoped (`"assigned_to_me"`) role with
 * `voter.viewReminderStatus` does.
 */
export function OverdueReminderStack({
  contacts,
  onSetReminder,
  onSetReminderAt,
  onIncrementCallAttempts,
  incrementingCallAttempts,
}: {
  contacts: readonly ElectionDayVoter[];
  onSetReminder: (id: string, minutes: number) => void;
  onSetReminderAt: (id: string, at: Date) => void;
  onIncrementCallAttempts: (id: string) => void;
  incrementingCallAttempts: boolean;
}) {
  const { can, role } = usePermissions();

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(
      () => setNow(new Date()),
      APP_CONFIG.electionDayReminderPopupTickMs,
    );
    return () => clearInterval(id);
  }, []);

  const showPopups =
    role?.scopeType === "assigned_to_me" && can("voter.viewReminderStatus");

  const due = useMemo(
    () => (showPopups ? resolveOverdueReminderPopups(contacts, now) : []),
    [showPopups, contacts, now],
  );

  // Render-phase-compare reset (CLAUDE.md's sanctioned pattern for "reset
  // state when some value changes" - never a setState-in-effect) - once
  // the due count reaches zero, `expanded` snaps back to closed, so the
  // bar always starts collapsed the next time a reminder becomes due.
  const [expanded, setExpanded] = useState(false);
  const [trackedDueCount, setTrackedDueCount] = useState(due.length);
  if (due.length !== trackedDueCount) {
    setTrackedDueCount(due.length);
    if (due.length === 0) setExpanded(false);
  }

  if (due.length === 0) return null;

  const visible = due.slice(0, APP_CONFIG.electionDayReminderPopupVisibleCount);
  const overflowCount = due.length - visible.length;
  const canCall = can("voter.viewPhone");
  const canManageReminder = can("voter.manageReminder");

  return (
    <div className="pointer-events-none fixed bottom-20 left-4 z-50 flex flex-col-reverse items-start gap-2 md:bottom-6">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-primary-600 px-4 py-2.5 text-sm font-bold text-white shadow-xl transition hover:bg-primary-700 active:bg-primary-800"
      >
        <span aria-hidden>⏰</span>
        {ELECTION_DAY_TEXT.reminder.popup.barLabel(due.length)}
      </button>

      {expanded && (
        <div className="pointer-events-auto flex max-h-[60vh] w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto">
          {visible.map((contact) => (
            <div
              key={`${contact.id}:${contact.reminderAt}`}
              // `relative focus-within:z-30`: each card sits in a scrollable
              // stack of siblings, and `ReminderMenu`'s own dropdown is an
              // absolutely-positioned child (not portaled) - without this,
              // an open dropdown can render underneath the next card in the
              // list, making its options unclickable. Elevating only the
              // card whose menu is actually focused/open (not all of them)
              // keeps the rest of the stack's normal layering untouched.
              className="relative z-0 rounded-xl bg-white p-3 shadow-xl ring-1 ring-slate-200 animate-fade-in-up focus-within:z-30"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-lg" aria-hidden>
                  ⏰
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-slate-800">
                    {contact.firstName} {contact.lastName}
                  </p>
                  <p className="truncate text-xs text-slate-500">{contact.coordinator}</p>
                  <p className="mt-0.5 text-xs font-semibold text-rose-600">
                    {ELECTION_DAY_TEXT.reminder.dueLabel}
                    {contact.reminderAt &&
                      ` · ${formatReminderDisplay(contact.reminderAt, now)}`}
                  </p>
                </div>
              </div>
              {(canCall || canManageReminder) && (
                <div className="mt-2 flex gap-2">
                  {canCall && (
                    <Button
                      className="flex-1 bg-[#00a400] text-white hover:bg-[#008f00] active:bg-[#007a00] disabled:bg-slate-200 disabled:text-slate-400"
                      disabled={!contact.phone || incrementingCallAttempts}
                      onClick={() => {
                        if (!contact.phone) return;
                        window.location.href = telHref(contact.phone);
                        onIncrementCallAttempts(contact.id);
                      }}
                    >
                      📞 {ELECTION_DAY_TEXT.modal.call}
                    </Button>
                  )}
                  {canManageReminder && (
                    <ReminderMenu
                      reminderAt={contact.reminderAt}
                      onSelect={(minutes) => onSetReminder(contact.id, minutes)}
                      onSelectCustom={(at) => onSetReminderAt(contact.id, at)}
                      label={ELECTION_DAY_TEXT.reminder.popup.postponeButton}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
          {overflowCount > 0 && (
            <div className="w-fit rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-lg">
              {ELECTION_DAY_TEXT.reminder.popup.moreCount(overflowCount)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
