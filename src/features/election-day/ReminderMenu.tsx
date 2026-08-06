import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { DateTimePicker } from "../../components/ui/DateTimePicker";
import { COMMON_TEXT } from "../../constants/common-text";
import { REMINDER_MINUTES_OPTIONS, ELECTION_DAY_TEXT } from "./election-day.constants";

/** Start of today (local time) - the earliest date a custom reminder can be
 * set for. A stable module-level function (not a component-scope constant)
 * so it's always evaluated fresh when the custom picker opens, never a
 * stale "today" from whenever the module first loaded. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A small "set a follow-up reminder" menu - reuses the same click-outside
 * pattern as MultiSelectDropdown. Picking one of the 3 fixed options is a
 * one-shot action (fires immediately, closes); picking "קביעת שעה" instead
 * swaps the menu's own content to the shared `DateTimePicker` + a
 * confirm/cancel pair, in place - no separate Modal. */
export function ReminderMenu({
  reminderAt,
  onSelect,
  onSelectCustom,
}: {
  /** The contact's current reminder timestamp (or `null`) - only used to
   * default the custom picker to the existing reminder when one is already
   * set (editing), rather than "now" (fresh). */
  reminderAt: string | null;
  onSelect: (minutes: (typeof REMINDER_MINUTES_OPTIONS)[number]) => void;
  onSelectCustom: (at: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [draft, setDraft] = useState<Date | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const closeAll = () => {
    setOpen(false);
    setCustomMode(false);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeAll();
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && closeAll();
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openCustom = () => {
    setDraft(reminderAt ? new Date(reminderAt) : new Date());
    setCustomMode(true);
  };

  const confirmCustom = () => {
    if (!draft) return;
    onSelectCustom(draft);
    closeAll();
  };

  return (
    <div ref={rootRef} className="relative flex-1">
      <Button
        type="button"
        className="w-full bg-[#f59f00] text-white hover:bg-[#e08e00] active:bg-[#c97e00]"
        onClick={() => setOpen((o) => !o)}
      >
        ⏰ {ELECTION_DAY_TEXT.reminder.button}
      </Button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-56 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200 animate-fade-in">
          {!customMode ? (
            <>
              {REMINDER_MINUTES_OPTIONS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    onSelect(minutes);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-start text-sm text-slate-700 hover:bg-slate-50"
                >
                  {ELECTION_DAY_TEXT.reminder.options[minutes]}
                </button>
              ))}
              <button
                type="button"
                onClick={openCustom}
                className="block w-full px-3 py-2 text-start text-sm text-slate-700 hover:bg-slate-50"
              >
                {ELECTION_DAY_TEXT.reminder.customOption}
              </button>
            </>
          ) : (
            <div className="space-y-2 p-2">
              <DateTimePicker
                value={draft}
                onChange={setDraft}
                minDate={startOfToday()}
              />
              <div className="flex gap-2">
                <Button className="flex-1" disabled={!draft} onClick={confirmCustom}>
                  {ELECTION_DAY_TEXT.reminder.customConfirm}
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1"
                  onClick={() => setCustomMode(false)}
                >
                  {COMMON_TEXT.cancel}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
