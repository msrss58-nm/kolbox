import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Input } from "../ui/Field";
import { cn } from "../../lib/utils";

/** A section toolbar's search field: the shared `Input` with a leading search
 * icon. `className` sizes the field (it lands on the wrapper). `ps-9!`: `cn`
 * does not merge Tailwind classes, so the icon inset must win over the base
 * `px-3.5` explicitly. */
export function AdminSearch({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn("relative", className)}>
      <Search
        className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400"
        aria-hidden
      />
      <Input type="search" {...props} className="ps-9!" />
    </div>
  );
}

const COUNT_PILL =
  "shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-500";

/**
 * One administration section inside `AdminShell`'s content area.
 *
 * Desktop (`md` and up): a working area capped at 1280px and centered, so
 * neither the toolbar nor a list stretches across a wide monitor. Inside it,
 * one RTL toolbar grouped at the start (right) - title, primary action, search
 * / filters, count - then the body, which is the ONLY region that scrolls, so
 * a long list never makes the page itself grow.
 *
 * Phones (below `md`): a compact header - the title with the count beside it
 * as the summary, then search / filters stacked full width - the list as
 * stacked cards, and the primary action in a fixed bottom bar (the product's
 * mobile bottom-bar pattern); the section reserves room so no card hides
 * under it. The description stays (smaller) - it can carry meaning, e.g.
 * the Multi-Entity privacy note.
 *
 * Forms and editors belong in dialogs opened from `actions`.
 *
 * `panel` (lists): on desktop the body is a single white data panel filling
 * all the remaining height, children flush inside it; on phones it is plain
 * and the children render as cards. An empty state centers in the body.
 * Without `panel` (compact content - details, short read-only lists) the body
 * is plain and children bring their own compact frame.
 */
export function AdminSection({
  title,
  description,
  actions,
  actionsEnd,
  toolbar,
  count,
  children,
  testId,
  panel = false,
}: {
  title: string;
  description?: ReactNode;
  /** Primary section actions (e.g. "add"): beside the title on desktop, in
   * the fixed bottom bar on phones. */
  actions?: ReactNode;
  /** Section actions pinned to the END of the header row - the LEFT side in
   * RTL, opposite the title - for a section whose primary action reads better
   * away from the heading. On phones it joins the same fixed bottom bar as
   * `actions`, so there is still one place a primary action lives. */
  actionsEnd?: ReactNode;
  /** Search / filter controls, grouped after the title and actions. */
  toolbar?: ReactNode;
  /** A short count (e.g. "26 משתמשים"): closes the toolbar on desktop, sits
   * beside the title on phones. */
  count?: ReactNode;
  children: ReactNode;
  testId?: string;
  panel?: boolean;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={cn(
        "flex h-full min-h-0 flex-col p-4 lg:px-8 lg:pt-7 lg:pb-8",
        (actions || actionsEnd) && "max-md:pb-[5.5rem]",
      )}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-3 lg:gap-3.5">
        <div className="shrink-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2
              id={headingId}
              className="min-w-0 text-lg font-extrabold text-slate-800 lg:me-1.5 lg:text-[1.375rem]"
            >
              {title}
            </h2>
            {count && (
              <span role="status" className={cn(COUNT_PILL, "md:hidden")}>
                {count}
              </span>
            )}
            {actions && (
              <div className="hidden flex-wrap items-center gap-2 md:flex">{actions}</div>
            )}
            {actions && (toolbar || count) && (
              <span
                aria-hidden
                className="mx-1 hidden h-6.5 w-px bg-slate-200 md:block"
              />
            )}
            {(toolbar || count) && (
              <div
                className={cn(
                  "flex w-full min-w-0 flex-wrap items-center gap-2.5 md:w-auto",
                  !toolbar && "max-md:hidden",
                )}
              >
                {toolbar}
                {count && (
                  <span role="status" className={cn(COUNT_PILL, "hidden md:inline")}>
                    {count}
                  </span>
                )}
              </div>
            )}
            {actionsEnd && (
              <div
                data-testid="section-actions-end"
                className="ms-auto hidden flex-wrap items-center gap-2 md:flex"
              >
                {actionsEnd}
              </div>
            )}
          </div>
          {description && (
            <p className="mt-1.5 text-xs text-slate-500 md:text-sm">{description}</p>
          )}
        </div>
        {/* Vertical scrolling only - rows truncate rather than widen the region,
            so a horizontal scrollbar never appears here. The plain body's 4px
            inset keeps a child card's ring / shadow from being clipped. */}
        <div
          data-admin-scroll-region
          className={cn(
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
            panel
              ? "max-md:-m-1 max-md:p-1 md:rounded-xl md:bg-white md:shadow-sm md:ring-1 md:ring-slate-200"
              : "-m-1 p-1",
          )}
        >
          {children}
        </div>
      </div>
      {/* Phones: the primary action stays reachable at the bottom. An
          end-aligned desktop action joins it here rather than getting its own
          bar - on a phone there is no "other end" to align to. */}
      {(actions || actionsEnd) && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden *:flex-1">
          {actions}
          {actionsEnd}
        </div>
      )}
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
