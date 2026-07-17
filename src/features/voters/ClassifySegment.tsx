import { CLASSIFICATION_LABELS } from "../../constants/labels";
import { cn } from "../../lib/utils";
import type { Classification } from "../../types";

const options: { value: Classification; activeClass: string }[] = [
  { value: "supporter", activeClass: "bg-supporter text-white" },
  { value: "potential", activeClass: "bg-potential text-white" },
  { value: "opponent", activeClass: "bg-opponent text-white" },
];

/**
 * Thumb-friendly segmented control for one-tap classification.
 * Tapping the active value clears back to "unclassified".
 */
export function ClassifySegment({
  value,
  onChange,
  size = "md",
  disabled,
  tone = "light",
}: {
  value: Classification;
  onChange: (next: Classification) => void;
  size?: "sm" | "md";
  disabled?: boolean;
  /** "dark" - for placement on a dark surface, e.g. the bulk-actions bar. */
  tone?: "light" | "dark";
}) {
  return (
    <div
      className={cn(
        "inline-flex rounded-xl p-1",
        tone === "dark" ? "bg-white/10" : "bg-slate-100",
        disabled && "pointer-events-none opacity-60",
      )}
      role="group"
      aria-label="סיווג"
    >
      {options.map(({ value: v, activeClass }) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(value === v ? "unclassified" : v)}
          className={cn(
            "rounded-lg font-semibold transition-all",
            size === "sm" ? "px-2.5 py-1 text-xs" : "min-h-9 px-3.5 py-1.5 text-sm",
            value === v
              ? cn(activeClass, "shadow-sm")
              : tone === "dark"
                ? "text-primary-100 hover:bg-white/15 hover:text-white"
                : "text-slate-500 hover:bg-white hover:text-slate-700",
          )}
          aria-pressed={value === v}
        >
          {CLASSIFICATION_LABELS[v]}
        </button>
      ))}
    </div>
  );
}
