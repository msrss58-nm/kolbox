import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * One administration section inside `AdminShell`'s content area.
 *
 * The title / actions / toolbar block is fixed; the body is the ONLY region
 * that scrolls, so a long list never makes the page itself grow. Forms and
 * editors belong in dialogs opened from `actions`, not in the body.
 */
export function AdminSection({
  title,
  description,
  actions,
  toolbar,
  children,
  testId,
  bodyClassName,
}: {
  title: string;
  description?: ReactNode;
  /** Primary section actions (e.g. "add"), shown beside the title. */
  actions?: ReactNode;
  /** Search / filter controls, shown on their own row under the title. */
  toolbar?: ReactNode;
  children: ReactNode;
  testId?: string;
  bodyClassName?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 space-y-3 border-b border-slate-200 bg-white px-4 py-3 lg:px-6 lg:py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id={headingId}
              className="text-base font-extrabold text-slate-800 lg:text-lg"
            >
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 text-sm text-slate-500">{description}</p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
        {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
      </div>
      <div
        data-admin-scroll-region
        className={cn("min-h-0 flex-1 overflow-y-auto p-4 lg:p-6", bodyClassName)}
      >
        {children}
      </div>
    </section>
  );
}

/** The single white frame a section's list sits in - one level, never a card
 * inside a card. */
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
