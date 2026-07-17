import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center animate-fade-in">
      <div className="grid size-14 place-items-center rounded-2xl bg-primary-50">
        <Icon className="size-7 text-primary-500" />
      </div>
      <p className="font-bold text-slate-700">{title}</p>
      {hint && <p className="max-w-xs text-sm text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}
