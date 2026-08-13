import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  dense,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** Reduces vertical padding at desktop widths only (`md:py-8` instead of
   * `py-16`) - mobile is untouched since the override only takes effect at
   * the `md:` breakpoint. For an empty state embedded inside an
   * already-compact card/section (e.g. a short roster list) rather than
   * filling a full page/tab, where the default `py-16` reads as an
   * oversized gap on wide screens. Defaults to `false` so every existing
   * call site is byte-for-byte unchanged. */
  dense?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 text-center animate-fade-in",
        dense ? "py-16 md:py-8" : "py-16",
      )}
    >
      <div className="grid size-14 place-items-center rounded-2xl bg-primary-50">
        <Icon className="size-7 text-primary-500" />
      </div>
      <p className="font-bold text-slate-700">{title}</p>
      {hint && <p className="max-w-xs text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}
