import { PhoneMissed } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { usePermissions } from "../../permissions/usePermissions";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import type { CallAttemptsWatchlistRow } from "./followUpBreakdown";

const text = ELECTION_DAY_TEXT.dashboard.callAttemptsWatchlist;
const callAttemptsText = ELECTION_DAY_TEXT.callAttempts;

/** Same "he-IL", hour/minute-only formatting already used for a plain local
 * clock time elsewhere (RefreshRow in ElectionDayDashboard.tsx,
 * reminderDisplay.ts) - no new timezone/formatting logic. */
function formatLastAttempt(iso: string | null): string {
  if (!iso) return text.noLastAttempt;
  return new Date(iso).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Dashboard "בוחרים עם 2+ ניסיונות חיוג" - the drill-down behind
 * `followUp.callAttempts2Plus`'s KPI tile (same `rows`, built by
 * `buildCallAttemptsWatchlist`, never a separately-computed set). Clicking a
 * row opens the same single-contact modal every other surface uses.
 *
 * Gated the same way the KPI section it belongs to already is
 * (`voter.viewVotedStatus`) plus `voter.viewName`, since the card
 * unconditionally shows a name - fail-closed: a role missing either never
 * sees the card at all rather than a partially-blank one. There is no
 * dedicated "view call attempts" permission, so the count is covered by the
 * same `voter.viewVotedStatus` gate the KPI tile itself uses - not
 * `voter.viewPhone`, which this card never displays (no phone number shown,
 * unlike `attentionAlerts.ts`'s unrelated callAttempts alert row). The
 * coordinator column degrades independently (`voter.viewCoordinator`),
 * mirroring `NonVotingReasonDrillDownModal`'s `showCoordinatorBreakdown`.
 */
export function CallAttemptsWatchlistCard({
  rows,
  onOpenVoter,
}: {
  rows: CallAttemptsWatchlistRow[];
  onOpenVoter: (id: string) => void;
}) {
  const { can } = usePermissions();
  if (!can("voter.viewVotedStatus") || !can("voter.viewName")) {
    return null;
  }
  const showCoordinator = can("voter.viewCoordinator");

  return (
    <Card className="min-w-0">
      <CardTitle className="flex items-center gap-1.5">
        <PhoneMissed className="size-4 text-rose-500" />
        {text.title}
      </CardTitle>
      {rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState icon={PhoneMissed} title={text.empty} />
        </div>
      ) : (
        <ul className="mt-1 max-h-64 divide-y divide-slate-100 overflow-y-auto">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onOpenVoter(row.id)}
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 py-2 text-start hover:bg-slate-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-800">
                    {row.firstName} {row.lastName}
                  </p>
                  {showCoordinator && (
                    <p className="truncate text-xs text-slate-500">
                      {row.coordinator || text.noCoordinator}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold tabular-nums text-rose-700">
                    {callAttemptsText.count(row.callAttempts, row.callAttemptsThreshold)}
                  </span>
                  <span className="text-[11px] tabular-nums text-slate-400" dir="ltr">
                    {formatLastAttempt(row.lastCallAttemptAt)}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
