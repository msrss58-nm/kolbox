import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { CLASSIFICATION_LABELS } from "../../constants/labels";
import type { Classification } from "../../types";

const classificationStyles: Record<Classification, string> = {
  supporter: "bg-supporter-soft text-emerald-800",
  potential: "bg-potential-soft text-amber-800",
  opponent: "bg-opponent-soft text-rose-800",
  unclassified: "bg-unclassified-soft text-slate-500",
};

export function ClassificationBadge({
  classification,
  className,
}: {
  classification: Classification;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        classificationStyles[classification],
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", {
          "bg-supporter": classification === "supporter",
          "bg-potential": classification === "potential",
          "bg-opponent": classification === "opponent",
          "bg-unclassified": classification === "unclassified",
        })}
      />
      {CLASSIFICATION_LABELS[classification]}
    </span>
  );
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-semibold text-primary-700",
        className,
      )}
      {...props}
    />
  );
}
