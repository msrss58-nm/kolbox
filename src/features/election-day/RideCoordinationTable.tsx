import { Card, CardTitle } from "../../components/ui/Card";
import { cn } from "../../lib/utils";
import type { ElectionDayVoter } from "../../types";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

/** Compact "who still needs their ride" list for the dashboard's narrow side
 * column - everyone who either needs a ride or has one coordinated, and
 * hasn't voted yet (computed in useElectionDay's `rideCoordinationQueue`,
 * sorted by pipeline stage). Rows not yet coordinated with a driver show a
 * plain status badge (nothing to complete yet - that happens in the contact
 * modal); once coordinated, the badge becomes the completion toggle: "תואם
 * הסעה" while pending, "בוצע הסעה" once the driver reports back - clicking
 * again reverts it, same as every other status toggle in this feature. */
export function RideCoordinationTable({
  contacts,
  onToggleCompleted,
}: {
  contacts: ElectionDayVoter[];
  onToggleCompleted: (contact: ElectionDayVoter, completed: boolean) => void;
}) {
  return (
    <Card>
      <CardTitle>🚕 {ELECTION_DAY_TEXT.dashboard.rideCoordination.title}</CardTitle>
      {contacts.length === 0 ? (
        <p className="mt-2 text-sm text-slate-400">
          {ELECTION_DAY_TEXT.dashboard.rideCoordination.empty}
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-slate-100">
          {contacts.map((contact) => {
            const address = [contact.street, contact.houseNumber || ""]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={contact.id} className="flex items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-800">
                    {contact.firstName} {contact.lastName}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {[address, contact.city].filter(Boolean).join(", ")}
                  </p>
                  <p className="truncate text-xs tabular-nums text-slate-400" dir="ltr">
                    {contact.phone || "-"}
                  </p>
                </div>
                {contact.rideArranged ? (
                  <button
                    type="button"
                    onClick={() => onToggleCompleted(contact, !contact.rideCompleted)}
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-xs font-bold transition-colors",
                      contact.rideCompleted
                        ? "bg-emerald-500 text-white"
                        : "bg-amber-100 text-amber-700 hover:bg-amber-200",
                    )}
                  >
                    {contact.rideCompleted
                      ? ELECTION_DAY_TEXT.dashboard.rideCoordination.statusDone
                      : ELECTION_DAY_TEXT.dashboard.rideCoordination.statusPending}
                  </button>
                ) : (
                  <span className="shrink-0 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-700">
                    {ELECTION_DAY_TEXT.dashboard.rideCoordination.statusRequested}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
