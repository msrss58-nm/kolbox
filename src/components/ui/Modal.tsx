import { useEffect, useRef, type ReactNode } from "react";
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
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** When `false`, the modal has no way for the user to dismiss it on their
   * own - no X button, no backdrop click, no Escape - because there is no
   * valid "do nothing" outcome (e.g. a forced decision dialog). `onClose`
   * itself still exists on the type so a caller can close it programmatically
   * after handling one of its own actions. Defaults to `true` (today's
   * behavior, unchanged for every existing caller). */
  dismissible?: boolean;
}) {
  // `onClose` is excluded from the registration effect's deps (a ref carries
  // its latest value instead) - callers routinely pass a fresh inline
  // closure every render (e.g. `onClose={() => setX(null)}`), and including
  // it as a dep would re-run the effect on every such render. That re-run
  // pops this modal's id off `openModalStack` and pushes a NEW one at the
  // END - if a second, non-dismissible modal was already stacked on top of
  // this one, this modal would wrongly become "topmost" and start
  // swallowing Escape/backdrop dismissal meant to be blocked by the modal
  // above it (found live: the call-attempts dialog's non-dismissible
  // guarantee broke exactly this way whenever its parent contact modal
  // re-rendered - e.g. after every call-attempts counter update - while
  // both were open at once).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Stable per-instance identity, created once on first render (not per
  // effect run) so both the stack-registration effect below AND the
  // backdrop's onClick handler can agree on "is this instance topmost" -
  // the backdrop click needs the same topmost check the Escape handler
  // already has (see next comment), which means it needs this id outside
  // the effect too.
  const idRef = useRef<object | null>(null);
  idRef.current ??= {};

  useEffect(() => {
    if (!open) return;
    // Guaranteed non-null: set synchronously above on every render before
    // any effect can run.
    const id = idRef.current!;
    openModalStack.push(id);
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!dismissible) return;
      if (openModalStack[openModalStack.length - 1] !== id) return;
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openModalStack = openModalStack.filter((x) => x !== id);
      if (openModalStack.length === 0) document.body.style.overflow = "";
    };
  }, [open, dismissible]);

  if (!open) return null;

  // A stacked-on-top modal's backdrop can visually receive the click even
  // when this modal is the one underneath - `backdrop-blur-sm` here is a
  // `backdrop-filter`, which makes this div a new containing block for any
  // descendant `position: fixed` element (including a nested Modal's own
  // backdrop), so paint/hit-test order for two stacked modals doesn't
  // reliably follow plain DOM nesting (found live: a click always hit the
  // outer modal's backdrop, even with a non-dismissible modal stacked on
  // top of it). The topmost-in-stack check below - the same one Escape
  // already uses - makes backdrop dismissal correct regardless of which
  // DOM element the click physically landed on.
  const handleBackdropClick = () => {
    if (!dismissible) return;
    if (openModalStack[openModalStack.length - 1] !== idRef.current) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-950/50 backdrop-blur-sm animate-fade-in md:items-center md:p-6"
      onClick={handleBackdropClick}
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
          {dismissible && (
            <button
              onClick={onClose}
              className="touch-target -me-2 grid place-items-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="סגירה"
            >
              <X className="size-5" />
            </button>
          )}
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
