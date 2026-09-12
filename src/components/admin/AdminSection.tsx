import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * One administration section inside `AdminShell`'s content area.
 *
 * Layout: one RTL toolbar row - the title and its primary action together at
 * the start (right), search / filters in the remaining space - then the body,
 * which is the ONLY region that scrolls, so a long list never makes the page
 * itself grow. Forms and editors belong in dialogs opened from `actions`.
 *
 * `panel` (lists): the body is a single white data panel filling all the
 * remaining height; children render flush inside it (no `AdminListFrame`),
 * and an empty state centers inside it. Without `panel` (compact content -
 * details, short read-only lists) the body is plain and children bring their
 * own compact frame.
 */
export function AdminSection({
  title,
  description,
  actions,
  toolbar,
  children,
  testId,
  panel = false,
}: {
  title: string;
  description?: ReactNode;
  /** Primary section actions (e.g. "add"), shown right beside the title. */
  actions?: ReactNode;
  /** Search / filter controls, in the same row after the title and actions. */
  toolbar?: ReactNode;
  children: ReactNode;
  testId?: string;
  panel?: boolean;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex h-full min-h-0 flex-col gap-3 p-4 lg:gap-4 lg:p-6"
    >
      <div className="shrink-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2
            id={headingId}
            className="min-w-0 text-lg font-extrabold text-slate-800 lg:text-xl"
          >
            {title}
          </h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          {toolbar && (
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:ms-auto lg:w-auto">
              {toolbar}
            </div>
          )}
        </div>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {/* Vertical scrolling only - rows truncate rather than widen the region,
          so a horizontal scrollbar never appears here. The plain body's 4px
          inset keeps a child frame's ring / shadow from being clipped. */}
      <div
        data-admin-scroll-region
        className={cn(
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
          panel ? "rounded-xl bg-white shadow-sm ring-1 ring-slate-200" : "-m-1 p-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** The single white frame a compact section's list sits in - one level, never
 * a card inside a card (and never inside a `panel` section). */
export function AdminListFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200",
        className,
      )}
    >
      {children}
    </div>
  );
}
