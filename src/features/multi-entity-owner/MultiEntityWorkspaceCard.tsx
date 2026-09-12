import {
  Activity,
  Building2,
  CalendarClock,
  ChevronLeft,
  EyeOff,
  Flag,
  Lock,
} from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../components/ui/Card";
import { cn } from "../../lib/utils";
import { formatDateTime } from "../platform-owner/multiEntityFormat";
import { MULTI_ENTITY_OWNER_TEXT } from "./multi-entity-owner.constants";
import { multiEntityWorkspacePath } from "./multiEntityAggregateFormat";
import { MultiEntityMetrics } from "./MultiEntityMetrics";
import type {
  MultiEntityReportStatus,
  MultiEntityWorkspaceAggregate,
} from "./multiEntityOwnerClient";

const text = MULTI_ENTITY_OWNER_TEXT;

const STATUS_STYLE: Record<
  MultiEntityReportStatus,
  { icon: typeof Activity; className: string }
> = {
  reported: {
    icon: Activity,
    className: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  },
  suppressed: { icon: EyeOff, className: "bg-amber-50 text-amber-800 ring-amber-200" },
  ended: { icon: Flag, className: "bg-slate-100 text-slate-700 ring-slate-200" },
  unavailable: { icon: Lock, className: "bg-slate-100 text-slate-700 ring-slate-200" },
};

type WithheldStatus = Exclude<MultiEntityReportStatus, "reported">;

/** Status in WORDS plus an icon - never color alone. */
export function MultiEntityStatusBadge({ status }: { status: MultiEntityReportStatus }) {
  const { icon: Icon, className } = STATUS_STYLE[status];
  return (
    <span
      data-testid="workspace-status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {text.status[status]}
    </span>
  );
}

/** Why a workspace shows no numbers. Deliberately contains no number at all. */
export function MultiEntityWithheldNotice({ status }: { status: WithheldStatus }) {
  const Icon = STATUS_STYLE[status].icon;
  return (
    <p
      data-testid="withheld-notice"
      className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
      <span>{text.withheld[status]}</span>
    </p>
  );
}

/**
 * Platform Stage 7: one assigned workspace on the dashboard. Numbers render
 * ONLY for a `reported` row; `suppressed`, `ended` and (Stage 9) `unavailable`
 * rows show a notice and nothing derived from any count.
 */
export function MultiEntityWorkspaceCard({
  workspace,
}: {
  workspace: MultiEntityWorkspaceAggregate;
}) {
  return (
    <Card
      className="flex h-full flex-col gap-3 animate-fade-in"
      data-testid="workspace-card"
      data-status={workspace.status}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-50">
          <Building2 className="size-5 text-primary-500" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="break-words font-bold text-slate-800">{workspace.name}</h3>
          {/* Under the name (not beside it) so a long status never squeezes
              the name or the date on a 360px phone. */}
          <MultiEntityStatusBadge status={workspace.status} />
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <CalendarClock
              className="size-3.5 shrink-0 text-slate-400"
              aria-hidden="true"
            />
            <span className="min-w-0">
              {text.home.endsAtLabel}: {formatDateTime(workspace.electionEndAt)}
            </span>
          </p>
        </div>
      </div>

      {workspace.status === "reported" && workspace.metrics ? (
        <>
          <MultiEntityMetrics metrics={workspace.metrics} headingLevel="h4" />
          <Link
            to={multiEntityWorkspacePath(workspace.workspaceId)}
            aria-label={text.home.openDetails(workspace.name)}
            className="mt-auto inline-flex h-11 items-center justify-center gap-1.5 self-start rounded-xl px-4 text-sm font-semibold text-primary-700 ring-1 ring-primary-100 hover:bg-primary-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
          >
            {text.home.viewDetails}
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Link>
        </>
      ) : workspace.status === "reported" ? null : (
        <MultiEntityWithheldNotice status={workspace.status} />
      )}
    </Card>
  );
}
