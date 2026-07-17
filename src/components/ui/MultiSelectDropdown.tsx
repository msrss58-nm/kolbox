import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { COMMON_TEXT } from "../../constants/common-text";
import { cn } from "../../lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * A checkbox-list dropdown for selecting zero or more values from a fixed
 * option set - the multi-value counterpart to a native `<select>`. Closed
 * button shows the sole selection's label, an "N נבחרו" count for multiple,
 * or `emptyLabel` when nothing is selected.
 */
export function MultiSelectDropdown({
  emptyLabel,
  options,
  selected,
  onChange,
  className,
}: {
  emptyLabel: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
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

  const toggleValue = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  const buttonText =
    selected.length === 0
      ? emptyLabel
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? emptyLabel)
        : COMMON_TEXT.multiSelect.selectedCount(selected.length);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-xl bg-white px-3.5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200 transition focus:outline-none focus:ring-2 focus:ring-primary-500"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{buttonText}</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-slate-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-full min-w-48 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-slate-200 animate-fade-in">
          <div
            role="listbox"
            aria-multiselectable="true"
            className="max-h-64 overflow-y-auto p-1.5"
          >
            {options.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <button
                  type="button"
                  key={opt.value}
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggleValue(opt.value)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-slate-50"
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded border",
                      checked
                        ? "border-primary-600 bg-primary-600 text-white"
                        : "border-slate-300",
                    )}
                  >
                    {checked && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="truncate text-slate-700">{opt.label}</span>
                </button>
              );
            })}
          </div>
          {/* Fixed footer - stays put while the options above it scroll, and
              is disabled (not hidden) until there's something to clear. */}
          <button
            type="button"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
            className="w-full border-t border-slate-100 px-2.5 py-2 text-start text-xs font-medium text-slate-400 hover:text-primary-600 disabled:pointer-events-none disabled:opacity-40"
          >
            {COMMON_TEXT.multiSelect.clearAll}
          </button>
        </div>
      )}
    </div>
  );
}
