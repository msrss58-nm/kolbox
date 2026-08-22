import type { ButtonHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
type Size = "sm" | "md" | "lg";

const variants: Record<Variant, string> = {
  primary:
    "bg-primary-600 text-white shadow-sm shadow-primary-600/30 hover:bg-primary-700 active:bg-primary-800",
  secondary:
    "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 active:bg-slate-100",
  ghost: "text-slate-600 hover:bg-slate-100 active:bg-slate-200",
  danger: "bg-opponent text-white hover:brightness-95 active:brightness-90",
  /** Restrained destructive treatment for low-frequency, high-consequence
   * actions (e.g. "הסר אחראי") that must stay discoverable without
   * visually dominating the primary/secondary actions beside them - mirrors
   * the muted-icon-until-hover destructive pattern already used elsewhere
   * in the app (e.g. `PermissionUsersPanel.tsx`/`RideCoordinatorsPanel.tsx`'s
   * delete icons), just as a labeled button. */
  "danger-outline":
    "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-opponent-soft hover:text-opponent hover:ring-opponent/30 active:bg-rose-100 active:text-opponent active:ring-opponent/50",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3 text-sm gap-1.5",
  md: "h-11 px-4 text-sm gap-2", // 44px - touch friendly
  lg: "h-12 px-6 text-base gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500",
        "disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}
