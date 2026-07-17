import { cn } from "../lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("size-10", className)} aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#logo-g)" />
      <rect x="16" y="30" width="32" height="18" rx="3" fill="#fff" opacity="0.95" />
      <rect x="26" y="27" width="12" height="4" rx="2" fill="#c7d2fe" />
      <path
        d="M32 12l3.5 7.5 8 1-6 5.5 1.5 8-7-4-7 4 1.5-8-6-5.5 8-1z"
        fill="#fde047"
        transform="translate(0,-2) scale(0.72) translate(12.5,8)"
      />
    </svg>
  );
}

export function Logo({
  className,
  light = false,
}: {
  className?: string;
  light?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="size-9" />
      <span
        className={cn(
          "text-xl font-extrabold tracking-tight",
          light ? "text-white" : "text-slate-800",
        )}
      >
        קול<span className="text-primary-400">בוקס</span>
      </span>
    </div>
  );
}
