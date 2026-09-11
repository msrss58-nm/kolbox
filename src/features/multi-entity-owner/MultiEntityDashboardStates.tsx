import { useEffect, useRef } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/Skeleton";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";

const text = MULTI_ENTITY_OWNER_TEXT.home;

/** First load - announced to assistive tech, no numbers of any kind. */
export function MultiEntityDashboardSkeleton() {
  return (
    <div
      role="status"
      aria-label={text.loading}
      data-testid="dashboard-loading"
      className="space-y-3"
    >
      <Skeleton className="h-40 rounded-2xl" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    </div>
  );
}

/**
 * A failed read. Replaces the data entirely (stale numbers are never kept on
 * screen next to an error) and takes keyboard focus when it appears, so a
 * screen-reader or keyboard user lands on it.
 */
export function MultiEntityLoadError({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Card>
      <div
        ref={ref}
        tabIndex={-1}
        role="alert"
        data-testid="dashboard-error"
        className="flex flex-col items-center gap-3 py-8 text-center outline-none"
      >
        <div className="grid size-12 place-items-center rounded-2xl bg-amber-50">
          <AlertTriangle className="size-6 text-amber-600" aria-hidden="true" />
        </div>
        <p className="font-bold text-slate-800">{text.loadError.title}</p>
        <p className="max-w-sm text-sm text-slate-500">{text.loadError.body}</p>
        <Button variant="secondary" onClick={onRetry} loading={retrying}>
          <RefreshCw className="size-4" aria-hidden="true" />
          {text.loadError.retry}
        </Button>
      </div>
    </Card>
  );
}
