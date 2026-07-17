import type { ElectionDayVoter } from "../../types";
import { RideStatusBadge } from "./RideStatusBadge";

export function ElectionDayRow({
  contact,
  onOpen,
}: {
  contact: ElectionDayVoter;
  onOpen: () => void;
}) {
  const address = [contact.street, contact.houseNumber || ""].filter(Boolean).join(" ");

  return (
    <button
      onClick={onOpen}
      className="block w-full border-b border-slate-100 text-start transition-colors last:border-b-0 hover:bg-slate-50"
    >
      {/* Desktop row */}
      <div className="hidden px-4 py-3 md:grid md:grid-cols-[1.3fr_0.8fr_1fr_0.9fr_0.9fr_auto] md:items-center md:gap-3">
        <p className="truncate text-sm font-bold text-slate-800">
          {contact.firstName} {contact.lastName}
        </p>
        <span className="truncate text-sm text-slate-600">{contact.city || "-"}</span>
        <span className="truncate text-sm text-slate-600">{address || "-"}</span>
        <span className="text-sm tabular-nums text-slate-600" dir="ltr">
          {contact.phone}
        </span>
        <span className="truncate text-sm text-slate-600">{contact.coordinator}</span>
        <RideStatusBadge arranged={contact.rideArranged} />
      </div>

      {/* Mobile card */}
      <div className="space-y-2 px-4 py-3 md:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-bold text-slate-800">
              {contact.firstName} {contact.lastName}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              {[contact.city, address].filter(Boolean).join(" · ")}
              {contact.city || address ? " · " : ""}
              {contact.coordinator} ·{" "}
              <span dir="ltr" className="tabular-nums">
                {contact.phone}
              </span>
            </p>
          </div>
          <RideStatusBadge arranged={contact.rideArranged} />
        </div>
      </div>
    </button>
  );
}
