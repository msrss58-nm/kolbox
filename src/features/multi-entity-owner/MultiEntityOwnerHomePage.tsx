import { useState } from "react";
import { Building2, CalendarClock, LogOut, RefreshCw } from "lucide-react";
import { LogoMark } from "../../components/Logo";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { formatDateTime } from "../platform-owner/multiEntityFormat";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

const text = MULTI_ENTITY_OWNER_TEXT.home;

/**
 * Platform Stage 5: the minimal authenticated Multi-Entity surface - only what
 * is needed to PROVE entity-scoped authorization: who the verified seat holder
 * is, and which workspaces the server says are assigned right now (or an
 * explicit "none" state). No metrics, no campaign data, no workspace
 * drill-down - that is Stage 6 (read backend) and Stage 7 (dashboard).
 *
 * Rendered only under `MultiEntityOwnerAuthGuard`, i.e. after the server's
 * own 200. "Refresh" re-runs the full server resolution, so an unassignment
 * disappears from the list and a seat replacement drops to "forbidden".
 */
export function MultiEntityOwnerHomePage() {
  const context = useMultiEntityOwnerSession((s) => s.context);
  const refreshStatus = useMultiEntityOwnerSession((s) => s.refreshStatus);
  const logout = useMultiEntityOwnerSession((s) => s.logout);
  const loggingOut = useMultiEntityOwnerSession((s) => s.loggingOut);
  const [refreshing, setRefreshing] = useState(false);

  if (!context) return null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="min-h-dvh bg-surface">
      <header className="border-b border-slate-100 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 md:px-6">
          <LogoMark className="size-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-slate-800">
              {text.signedInAs(context.name)}
            </p>
            <p dir="ltr" className="truncate text-end text-xs text-slate-500">
              {context.email}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => void logout()}
            loading={loggingOut}
            className="shrink-0"
            aria-label={text.logout}
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">{text.logout}</span>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6 md:px-6 md:py-8">
        <div className="flex items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-extrabold text-slate-800">{text.title}</h1>
            <p className="text-sm text-slate-500" data-testid="workspace-count">
              {text.count(context.workspaces.length)}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => void refresh()}
            loading={refreshing}
            className="shrink-0"
            aria-label={text.refresh}
          >
            <RefreshCw className="size-4" />
            <span className="hidden sm:inline">{text.refresh}</span>
          </Button>
        </div>

        {context.workspaces.length === 0 ? (
          <Card>
            <EmptyState
              icon={Building2}
              title={text.emptyTitle}
              hint={text.emptyHint}
              dense
            />
          </Card>
        ) : (
          <ul className="space-y-3" data-testid="workspace-list">
            {context.workspaces.map((w) => (
              <li key={w.workspaceId}>
                <Card className="space-y-3 animate-fade-in">
                  <div className="flex items-center gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-50">
                      <Building2 className="size-5 text-primary-500" />
                    </div>
                    <p className="min-w-0 flex-1 truncate font-bold text-slate-800">
                      {w.name}
                    </p>
                  </div>
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div className="flex items-center gap-2 text-slate-600">
                      <CalendarClock className="size-4 shrink-0 text-slate-400" />
                      <dt className="font-semibold">{text.endsAtLabel}:</dt>
                      <dd>{formatDateTime(w.electionEndAt)}</dd>
                    </div>
                    <div className="flex items-center gap-2 text-slate-600">
                      <dt className="font-semibold">{text.assignedAtLabel}:</dt>
                      <dd>{formatDateTime(w.assignedAt)}</dd>
                    </div>
                  </dl>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <p className="text-center text-xs text-slate-400">{text.stageNote}</p>
      </main>
    </div>
  );
}
