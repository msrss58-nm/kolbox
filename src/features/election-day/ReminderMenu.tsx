import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { REMINDER_MINUTES_OPTIONS, ELECTION_DAY_TEXT } from "./election-day.constants";

/** A small "set a follow-up reminder" menu - reuses the same click-outside
 * pattern as MultiSelectDropdown, but is a one-shot action menu (picking an
 * option fires immediately and closes) rather than a persistent selection. */
export function ReminderMenu({
  onSelect,
}: {
  onSelect: (minutes: (typeof REMINDER_MINUTES_OPTIONS)[number]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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
        <div className="absolute z-20 mt-1 w-full min-w-36 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200 animate-fade-in">
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
        </div>
      )}
    </div>
  );
}
