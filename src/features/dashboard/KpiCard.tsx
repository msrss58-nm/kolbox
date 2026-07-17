import type { LucideIcon } from "lucide-react";
import { Card } from "../../components/ui/Card";
import { useCountUp } from "../../hooks/useCountUp";
import { cn, fmtNum } from "../../lib/utils";

export type KpiTone = "default" | "supporter" | "potential" | "opponent" | "primary";

const TONE_CLASSES: Record<KpiTone, string> = {
  default: "bg-slate-100 text-slate-500",
  supporter: "bg-supporter-soft text-emerald-700",
  potential: "bg-potential-soft text-amber-700",
  opponent: "bg-opponent-soft text-rose-700",
  primary: "bg-primary-50 text-primary-600",
};

export function KpiCard({
  icon: Icon,
  label,
  value,
  suffix = "",
  sub,
  tone = "default",
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  suffix?: string;
  sub?: string;
  tone?: KpiTone;
}) {
  const animated = useCountUp(value);
  return (
    <Card className="flex items-start gap-3 p-4 animate-fade-in-up">
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-xl",
          TONE_CLASSES[tone],
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-semibold text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-extrabold tabular-nums text-slate-800">
          {fmtNum(animated)}
          {suffix}
        </p>
        {sub && <p className="mt-0.5 truncate text-xs text-slate-400">{sub}</p>}
      </div>
    </Card>
  );
}
