import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { APP_CONFIG } from "../../constants/config";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { resolveOverdueReminderPopups } from "./overdueReminderPopups";
import { formatReminderDisplay } from "./reminderDisplay";

/** Just the "HH:MM" portion of a reminder's time - the single-reminder
 * card's due-time line always reads "המועד הגיע ב-HH:MM" (this card is only
 * ever showing an already-due reminder, never a future/other-day one), so
 * it doesn't need `formatReminderDisplay`'s generic "on <date> at <time>"
 * sentence built for every lifecycle state. */
function formatDueTime(reminderAt: string): string {
  return new Date(reminderAt).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Persistent Reminders: a fixed, professional card at the physical TOP-LEFT
 * of the app, styled in the same dark-navy family as the sidebar
 * (`bg-sidebar`/`bg-sidebar-hover`, `src/index.css`'s `--color-sidebar*`
 * tokens) so it reads as a permanent piece of app chrome, not a temporary
 * toast. Every card/row is purely derived from persisted contact fields via
 * `resolveOverdueReminderPopups` - there is no separate "is this dismissed"/
 * "is this expanded" flag tied to any one contact, so the stack's count and
 * contents survive a reload/re-login/navigation exactly like every other
 * derived Election Day view, and a card disappears only when its underlying
 * reminder actually resolves (a real recorded call outcome, a cancel, a
 * vote, or a case-closing non-voting reason) - never merely from being
 * clicked or from a dial alone (see `overdueReminderPopups.ts`'s own doc
 * comment for the full history of that distinction).
 *
 * Deliberately pinned to the physical LEFT edge (`left-*`, not the RTL
 * logical `start-*`/`ms-*` this codebase otherwise always uses) - an
 * explicit, product-approved exception for this one fixed-corner overlay,
 * not a drift from the RTL convention: the desktop sidebar occupies the
 * physical RIGHT (`AppShell`'s "start side = right in RTL"), so pinning
 * left keeps this clear of it regardless of text direction. `items-end`
 * (not `items-start`) on the multi-reminder container, for the same
 * reason: `align-items` is cross-axis, and in a `dir="rtl"` flex column
 * `flex-start` resolves to the RTL inline-start side - physical RIGHT, not
 * left. `items-end` resolves to the physical left in RTL, keeping the
 * collapsed bar and the expanded list flush against the same pinned edge
 * regardless of width. Top-anchored (`top-*`, growing downward via a plain
 * `flex-col`) rather than the earlier bottom-anchored version - on mobile
 * this sits below `AppShell`'s sticky topbar (`top-16`) so it never covers
 * the logo/logout button there; on desktop (`md:top-6`) there's no topbar
 * to clear.
 *
 * One reminder renders as a single always-expanded card (no click-to-expand
 * needed - there's nothing to disambiguate). More than one renders as a
 * compact count bar that expands into a scrollable list of slim rows
 * (never large per-row cards) - `expanded` is pure UI state, not persisted,
 * and resets to closed once the count reaches zero (render-phase-compare,
 * CLAUDE.md's sanctioned pattern) so the bar always starts collapsed the
 * next time more than one reminder is due.
 *
 * Deliberately funnels every card/row through the same `onOpen` action
 * (the shared contact modal, where the full call/outcome flow lives) rather
 * than duplicating quick-dial/postpone controls here - avoids a noisy stack
 * of large, busy cards, per the approved redesign.
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
  onOpen,
}: {
  contacts: readonly ElectionDayVoter[];
  /** Global Due-Reminder Alert: opens the full contact modal (the same
   * shared instance every other screen's row-click uses) - lets the
   * coordinator jump straight from an overdue card to the voter's full
   * detail, including the call-outcome buttons. */
  onOpen: (id: string) => void;
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
  // bar always starts collapsed the next time more than one reminder is due.
  const [expanded, setExpanded] = useState(false);
  const [trackedDueCount, setTrackedDueCount] = useState(due.length);
  if (due.length !== trackedDueCount) {
    setTrackedDueCount(due.length);
    if (due.length === 0) setExpanded(false);
  }

  if (due.length === 0) return null;

  const text = ELECTION_DAY_TEXT.reminder.popup;

  // Single reminder: one always-visible card, no expand step.
  if (due.length === 1) {
    const contact = due[0];
    return (
      <div className="pointer-events-none fixed left-3 top-16 z-50 md:left-6 md:top-6">
        <button
          type="button"
          onClick={() => onOpen(contact.id)}
          className="pointer-events-auto flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-3.5 rounded-2xl bg-sidebar p-5 text-start shadow-lg ring-1 ring-white/10 transition hover:bg-sidebar-hover active:brightness-110"
        >
          <div className="flex items-center gap-2.5">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full bg-amber-400/15 text-lg"
              aria-hidden
            >
              ⏰
            </span>
            <p className="text-sm font-bold uppercase tracking-wide text-amber-400">
              {text.cardLabel}
            </p>
          </div>
          <div className="min-w-0">
            <p className="truncate text-xl font-extrabold text-white">
              {contact.firstName} {contact.lastName}
            </p>
            {contact.reminderAt && (
              <p className="mt-1 truncate text-sm font-medium text-slate-200">
                {text.dueTimeLabel(formatDueTime(contact.reminderAt))}
              </p>
            )}
          </div>
          <span className="flex w-full items-center justify-center rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-bold text-white">
            {text.openButton}
          </span>
        </button>
      </div>
    );
  }

  // Multiple reminders: compact count bar -> scrollable list of slim rows.
  const visible = due.slice(0, APP_CONFIG.electionDayReminderPopupVisibleCount);
  const overflowCount = due.length - visible.length;

  return (
    <div className="pointer-events-none fixed left-3 top-16 z-50 flex flex-col items-end gap-2 md:left-6 md:top-6">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-sidebar px-4 py-2.5 text-sm font-bold text-white shadow-2xl ring-1 ring-white/10 transition hover:bg-sidebar-hover"
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-400/20 text-xs font-bold text-amber-400">
          {due.length}
        </span>
        {text.barLabel(due.length)}
        {expanded ? (
          <ChevronUp className="size-4 shrink-0 text-slate-400" />
        ) : (
          <ChevronDown className="size-4 shrink-0 text-slate-400" />
        )}
      </button>

      {expanded && (
        <div className="pointer-events-auto flex max-h-[60vh] w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-1 overflow-y-auto rounded-2xl bg-sidebar p-2 shadow-2xl ring-1 ring-white/10 animate-fade-in-up">
          {visible.map((contact) => (
            <button
              key={`${contact.id}:${contact.reminderAt}`}
              type="button"
              onClick={() => onOpen(contact.id)}
              className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-start hover:bg-sidebar-hover active:brightness-110"
            >
              <span className="shrink-0 text-base" aria-hidden>
                ⏰
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">
                  {contact.firstName} {contact.lastName}
                </p>
                <p className="truncate text-xs text-slate-300">
                  {contact.reminderAt && formatReminderDisplay(contact.reminderAt, now)}
                </p>
              </div>
            </button>
          ))}
          {overflowCount > 0 && (
            <p className="px-2.5 py-1.5 text-center text-xs font-semibold text-slate-400">
              {text.moreCount(overflowCount)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
