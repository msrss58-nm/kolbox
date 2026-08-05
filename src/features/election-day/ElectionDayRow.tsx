import { BellRing } from "lucide-react";
import { cn } from "../../lib/utils";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { ElectionDayColumnDef } from "./electionDayRowColumns";
import { isReminderActive } from "./reminderStatus";
import { VotedBadge } from "./VotedBadge";

function DesktopCell({
  columnKey,
  contact,
  showReminderBadge,
}: {
  columnKey: ElectionDayColumnDef["key"];
  contact: ElectionDayVoter;
  showReminderBadge: boolean;
}) {
  switch (columnKey) {
    case "masad":
      return (
        <span className="min-w-0 truncate text-sm tabular-nums text-slate-500">
          {contact.masad || "-"}
        </span>
      );
    case "name":
      return (
        <p
          className={cn(
            "flex min-w-0 items-center justify-center gap-1.5 truncate text-sm font-bold",
            contact.voted ? "text-slate-400 line-through" : "text-slate-800",
          )}
        >
          <span className="truncate">
            {contact.firstName} {contact.lastName}
          </span>
          {showReminderBadge && isReminderActive(contact.reminderAt) && (
            <BellRing
              className="size-3.5 shrink-0 text-amber-500"
              aria-label={ELECTION_DAY_TEXT.reminder.badge}
            />
          )}
        </p>
      );
    case "street":
      return (
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.street || "-"}
        </span>
      );
    case "houseNumber":
      return (
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.houseNumber || "-"}
        </span>
      );
    case "city":
      return (
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.city || "-"}
        </span>
      );
    case "phone":
      return (
        <span className="min-w-0 truncate text-sm tabular-nums text-slate-600" dir="ltr">
          {contact.phone || "-"}
        </span>
      );
    case "coordinator":
      return (
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.coordinator}
        </span>
      );
    case "notes":
      return (
        <span className="min-w-0 truncate text-sm text-slate-500">
          {contact.notes || "-"}
        </span>
      );
    case "status":
      return (
        <div className="flex min-w-0 items-center justify-center overflow-hidden">
          <VotedBadge voted={contact.voted} />
        </div>
      );
  }
}

export function ElectionDayRow({
  contact,
  columns,
  onOpen,
}: {
  contact: ElectionDayVoter;
  columns: readonly ElectionDayColumnDef[];
  onOpen: () => void;
}) {
  const { can } = usePermissions();
  const showReminderBadge = can("voter.viewReminderStatus");
  const showCoordinator = can("voter.viewCoordinator");
  const showNotes = can("voter.viewNotes");
  const reminderActive = showReminderBadge && isReminderActive(contact.reminderAt);

  return (
    <button
      onClick={onOpen}
      className={cn(
        "block w-full border-b border-slate-100 text-start transition-colors last:border-b-0 hover:bg-slate-50",
        contact.voted && "bg-slate-50/60 text-slate-400",
        reminderActive && !contact.voted && "reminder-pulse hover:brightness-95",
      )}
    >
      {/* Desktop row - one cell per currently-visible column, in the same
       * order/width as ElectionDayList's header (single source of truth:
       * electionDayRowColumns.ts). */}
      <div
        className="hidden px-4 py-3 text-center md:grid md:items-center md:gap-3"
        style={{ gridTemplateColumns: columns.map((c) => c.width).join(" ") }}
      >
        {columns.map((col) => (
          <DesktopCell
            key={col.key}
            columnKey={col.key}
            contact={contact}
            showReminderBadge={showReminderBadge}
          />
        ))}
      </div>

      {/* Mobile card */}
      <div className="space-y-2 px-4 py-3 md:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p
              className={cn(
                "flex items-center gap-1.5 truncate font-bold",
                contact.voted ? "text-slate-400 line-through" : "text-slate-800",
              )}
            >
              {contact.firstName} {contact.lastName}
              {reminderActive && (
                <BellRing className="size-3.5 shrink-0 text-amber-500" aria-hidden />
              )}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {[contact.city, contact.street, contact.houseNumber || ""]
                .filter(Boolean)
                .join(" · ")}
              {contact.city || contact.street ? " · " : ""}
              {showCoordinator && `${contact.coordinator} · `}
              <span dir="ltr" className="tabular-nums">
                {contact.phone || "-"}
              </span>
            </p>
            {showNotes && contact.notes && (
              <p className="mt-0.5 truncate text-xs text-slate-400">{contact.notes}</p>
            )}
          </div>
          <div className="shrink-0">
            <VotedBadge voted={contact.voted} />
          </div>
        </div>
      </div>
    </button>
  );
}
