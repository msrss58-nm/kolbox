import { BellRing } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { isReminderActive } from "./reminderStatus";
import { VotedBadge } from "./VotedBadge";

export function ElectionDayRow({
  contact,
  onOpen,
}: {
  contact: ElectionDayVoter;
  onOpen: () => void;
}) {
  const reminderActive = isReminderActive(contact.reminderAt);

  return (
    <button
      onClick={onOpen}
      className={cn(
        "block w-full border-b border-slate-100 text-start transition-colors last:border-b-0 hover:bg-slate-50",
        contact.voted && "bg-slate-50/60 text-slate-400",
        reminderActive && !contact.voted && "reminder-pulse hover:brightness-95",
      )}
    >
      {/* Desktop row */}
      <div className="hidden px-4 py-3 text-center md:grid md:grid-cols-[0.5fr_1.1fr_0.8fr_0.5fr_0.7fr_0.9fr_0.8fr_1fr_7rem] md:items-center md:gap-3">
        <span className="min-w-0 truncate text-sm tabular-nums text-slate-500">
          {contact.masad || "-"}
        </span>
        <p
          className={cn(
            "flex min-w-0 items-center justify-center gap-1.5 truncate text-sm font-bold",
            contact.voted ? "text-slate-400 line-through" : "text-slate-800",
          )}
        >
          <span className="truncate">
            {contact.firstName} {contact.lastName}
          </span>
          {reminderActive && (
            <BellRing
              className="size-3.5 shrink-0 text-amber-500"
              aria-label={ELECTION_DAY_TEXT.reminder.badge}
            />
          )}
        </p>
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.street || "-"}
        </span>
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.houseNumber || "-"}
        </span>
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.city || "-"}
        </span>
        <span className="min-w-0 truncate text-sm tabular-nums text-slate-600" dir="ltr">
          {contact.phone}
        </span>
        <span className="min-w-0 truncate text-sm text-slate-600">
          {contact.coordinator}
        </span>
        <span className="min-w-0 truncate text-sm text-slate-500">
          {contact.notes || "-"}
        </span>
        <div className="flex min-w-0 items-center justify-center overflow-hidden">
          <VotedBadge voted={contact.voted} />
        </div>
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
              {contact.coordinator} ·{" "}
              <span dir="ltr" className="tabular-nums">
                {contact.phone}
              </span>
            </p>
            {contact.notes && (
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
