import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/utils";
import { PLATFORM_OWNER_TEXT } from "./platform-owner.constants";
import { formatDateTime } from "./multiEntityFormat";
import { LtrValue } from "./MultiEntityLtrValue";
import type { MultiEntityWorkspace } from "./platformOwnerClient";

const text = PLATFORM_OWNER_TEXT.multiEntity.workspaces;

function Pill({ children, tone }: { children: string; tone: "on" | "off" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        tone === "on" && "bg-supporter-soft text-emerald-800",
        tone === "off" && "bg-unclassified-soft text-slate-500",
        tone === "muted" && "bg-slate-100 text-slate-500",
      )}
    >
      {children}
    </span>
  );
}

/**
 * One workspace. A stacked card at 360/390px, a single line from `sm:` up.
 *
 * `loginCode` is ALWAYS shown, not only when a name repeats:
 * `election_workspaces.name` carries no uniqueness constraint of any kind, so
 * the code is the only guaranteed-unique human-readable discriminator, and an
 * operator about to change who can see a tenant should never have to guess
 * which one they are looking at. When a name genuinely repeats, an explicit
 * hint says so.
 *
 * An ended workspace stays visible and assignable. `is_active` is derived from
 * the clock on the read path and the assign RPC deliberately never filters on
 * it, so hiding or blocking those rows here would invent a restriction the
 * backend does not have.
 */
export function MultiEntityWorkspaceRow({
  workspace,
  duplicateName,
  busy,
  disabled,
  blockedReason,
  error,
  onAssign,
  onUnassign,
}: {
  workspace: MultiEntityWorkspace;
  duplicateName: boolean;
  busy: boolean;
  disabled: boolean;
  /** Non-null when there is no seat: actions are inert and the reason shows. */
  blockedReason: string | null;
  error: string | null;
  onAssign: () => void;
  onUnassign: () => void;
}) {
  return (
    <li
      className={cn(
        "space-y-2 rounded-xl p-3 ring-1",
        workspace.isAssigned
          ? "bg-primary-50/40 ring-primary-200"
          : "bg-white ring-slate-200",
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1.5">
          <p className="font-bold break-words text-slate-800">{workspace.name}</p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone={workspace.isActive ? "on" : "off"}>
              {workspace.isActive ? text.active : text.ended}
            </Pill>
            <Pill tone={workspace.isAssigned ? "on" : "muted"}>
              {workspace.isAssigned ? text.assigned : text.unassigned}
            </Pill>
          </div>

          <p className="text-xs text-slate-500">
            <span className="font-semibold">{text.codeLabel}: </span>
            <LtrValue
              value={workspace.loginCode}
              className="inline-block text-xs font-semibold text-slate-700"
            />
          </p>

          {duplicateName && (
            <p className="text-xs font-semibold text-amber-800">{text.duplicateName}</p>
          )}

          <p className="text-xs text-slate-400">
            {workspace.isAssigned && workspace.assignedAt
              ? text.assignedAt(formatDateTime(workspace.assignedAt))
              : text.endsAt(formatDateTime(workspace.electionEndAt))}
          </p>
        </div>

        <Button
          variant={workspace.isAssigned ? "danger-outline" : "secondary"}
          size="sm"
          loading={busy}
          disabled={disabled}
          onClick={workspace.isAssigned ? onUnassign : onAssign}
          className="w-full shrink-0 sm:w-auto"
        >
          {workspace.isAssigned ? text.unassign : text.assign}
        </Button>
      </div>

      {blockedReason && <p className="text-xs text-slate-500">{blockedReason}</p>}

      {error && (
        <p role="alert" className="text-sm font-medium text-opponent">
          {error}
        </p>
      )}
    </li>
  );
}
