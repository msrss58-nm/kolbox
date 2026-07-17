import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const fieldClasses =
  "h-11 w-full rounded-xl bg-white px-3.5 text-sm text-slate-800 shadow-sm ring-1 ring-slate-200 transition placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-slate-50 disabled:text-slate-400";

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {error && <span className="block text-xs font-medium text-opponent">{error}</span>}
    </label>
  );
}

const PICKER_TYPES = new Set(["date", "datetime-local", "time", "month", "week"]);

export function Input({
  className,
  invalid,
  type,
  onClick,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const isPicker = type !== undefined && PICKER_TYPES.has(type);
  return (
    <input
      type={type}
      className={cn(
        fieldClasses,
        invalid && "ring-2 ring-opponent",
        isPicker && "cursor-pointer",
        className,
      )}
      onClick={(e) => {
        onClick?.(e);
        // Native date/time inputs only open their picker when the tiny
        // calendar icon is clicked - showPicker() makes the whole field act
        // as the trigger, which is what users expect from a "date field".
        if (isPicker) e.currentTarget.showPicker?.();
      }}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldClasses, "appearance-none", className)} {...props}>
      {children}
    </select>
  );
}
