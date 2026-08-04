import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

/** Explicit stack of currently-open Modal instances (shared module-wide, since
 * two Modals can legitimately be open at once - e.g. the phone-edit dialog
 * opened from within the voter detail modal). Only the topmost entry should
 * react to Escape, and the scroll lock should only release once the stack is
 * empty - a flat per-instance listener/toggle would let an inner modal's
 * Escape or close also close/unlock the outer one underneath it. A fresh
 * object identity is created per effect run (not a ref/useId) so a
 * push/cleanup pair always matches even under StrictMode's double-invoke. */
let openModalStack: object[] = [];

/**
 * Modal - centered dialog on desktop, full-width bottom sheet on mobile.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const id = {};
    openModalStack.push(id);
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openModalStack[openModalStack.length - 1] !== id) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openModalStack = openModalStack.filter((x) => x !== id);
      if (openModalStack.length === 0) document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm animate-fade-in md:items-center md:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-[90dvh] w-full flex-col overflow-hidden bg-white shadow-2xl animate-fade-in-up",
          "rounded-t-3xl md:rounded-2xl",
          wide ? "md:max-w-2xl" : "md:max-w-md",
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          <button
            onClick={onClose}
            className="touch-target -me-2 grid place-items-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="סגירה"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
