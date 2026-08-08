import type { LucideIcon } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { cn } from "../../lib/utils";

/** Screen-local tone palette for the redesigned dashboard's icon stat tiles
 * - deliberately not `dashboard/KpiCard.tsx`'s `KpiTone` (that one only
 * covers supporter/potential/opponent/primary/default). This screen needs a
 * wider range (blue/amber/rose/purple) to color-code unrelated categories
 * (turnout vs. rides vs. reasons vs. workload) - plain Tailwind classes,
 * same convention `RideCoordinationTable.tsx` already uses for its status
 * badges. */
export type ElectionDayStatTone =
  | "slate"
  | "primary"
  | "success"
  | "info"
  | "warning"
  | "danger"
  | "purple";

const TONE_TEXT_CLASSES: Record<ElectionDayStatTone, string> = {
  slate: "text-slate-500",
  primary: "text-primary-600",
  success: "text-emerald-600",
  info: "text-blue-600",
  warning: "text-amber-600",
  danger: "text-rose-600",
  purple: "text-purple-600",
};

export function ElectionDayStatTile({
  icon: Icon,
  label,
  value,
  sub,
  tone = "slate",
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  sub?: string;
  tone?: ElectionDayStatTone;
}) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-xs font-semibold text-slate-500">{label}</h3>
        <Icon className={cn("size-4 shrink-0", TONE_TEXT_CLASSES[tone])} />
      </div>
      <p
        className={cn(
          "mt-1.5 text-2xl font-extrabold tabular-nums",
          TONE_TEXT_CLASSES[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 truncate text-xs font-semibold text-slate-400">{sub}</p>}
    </Card>
  );
}
