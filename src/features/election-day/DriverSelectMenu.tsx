import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import type { RideCoordinator } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

/** One-shot "send this ride request to a driver" popover - same
 * click-outside pattern as `ReminderMenu`, listing the fixed, pre-registered
 * ride-coordinator roster instead of time options. */
export function DriverSelectMenu({
  coordinators,
  onSelect,
}: {
  coordinators: RideCoordinator[];
  onSelect: (coordinatorId: string) => void;
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
        className="w-full bg-[#ff9800] text-white hover:bg-[#f08c00] active:bg-[#db7d00]"
        onClick={() => setOpen((o) => !o)}
      >
        🚗 {ELECTION_DAY_TEXT.driver.sendButton}
      </Button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-48 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200 animate-fade-in">
          {coordinators.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-slate-400">
              {ELECTION_DAY_TEXT.driver.noCoordinators}
            </p>
          ) : (
            coordinators.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onSelect(c.id);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-start text-sm hover:bg-slate-50"
              >
                <span className="font-semibold text-slate-700">{c.name}</span>
                <span className="ms-1.5 text-xs tabular-nums text-slate-400" dir="ltr">
                  {c.phone}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
