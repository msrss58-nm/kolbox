import { useMemo } from "react";
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

interface WatchlistGroup {
  /** null = the "ללא אחראי" bucket, rendered last. */
  coordinator: string | null;
  rows: CallAttemptsWatchlistRow[];
}

/** Purely presentational grouping for display - never re-sorts within a
 * group (each bucket keeps `rows`' own incoming order, i.e.
 * `buildCallAttemptsWatchlist`'s existing callAttempts-desc/name tie-break),
 * and never changes which voters appear. Groups are ordered alphabetically
 * by coordinator name (same `localeCompare(b, "he")` convention already used
 * for the coordinator filter list in `useElectionDay.ts`), with the
 * no-coordinator bucket always last. */
function groupRowsByCoordinator(rows: CallAttemptsWatchlistRow[]): WatchlistGroup[] {
  const byCoordinator = new Map<string, CallAttemptsWatchlistRow[]>();
  for (const row of rows) {
    const key = row.coordinator || "";
    const bucket = byCoordinator.get(key);
    if (bucket) bucket.push(row);
    else byCoordinator.set(key, [row]);
  }
  const groups: WatchlistGroup[] = [...byCoordinator.entries()]
    .filter(([coordinator]) => coordinator !== "")
    .sort((a, b) => a[0].localeCompare(b[0], "he"))
    .map(([coordinator, groupRows]) => ({ coordinator, rows: groupRows }));
  const noCoordinatorRows = byCoordinator.get("");
  if (noCoordinatorRows) groups.push({ coordinator: null, rows: noCoordinatorRows });
  return groups;
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
  const showCoordinator = can("voter.viewCoordinator");
  // Grouping only ever runs on already-eligible `rows` (the exact set the
  // KPI tile counts) - it never adds/removes/reorders-across-groups a voter,
  // only buckets the existing sorted list for display. Ungated (runs even
  // when the card itself is about to render null below) since it's cheap and
  // hooks must stay unconditional.
  const groups = useMemo(
    () =>
      showCoordinator ? groupRowsByCoordinator(rows) : [{ coordinator: null, rows }],
    [rows, showCoordinator],
  );

  if (!can("voter.viewVotedStatus") || !can("voter.viewName")) {
    return null;
  }

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
        <div className="mt-1 max-h-64 divide-y divide-slate-100 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.coordinator ?? ""} className="py-0.5">
              {showCoordinator && (
                <p className="truncate px-1 pb-0.5 pt-1.5 text-[11px] font-bold text-slate-500">
                  {group.coordinator ?? text.noCoordinator}
                </p>
              )}
              <ul>
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => onOpenVoter(row.id)}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-1 py-1 text-start hover:bg-slate-50"
                    >
                      <p className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">
                        {row.firstName} {row.lastName}
                      </p>
                      <span
                        className="shrink-0 text-[11px] tabular-nums text-slate-400"
                        dir="ltr"
                      >
                        {formatLastAttempt(row.lastCallAttemptAt)}
                      </span>
                      <span className="shrink-0 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold tabular-nums text-rose-700">
                        {callAttemptsText.count(
                          row.noAnswerStreak,
                          row.noAnswerStreakThreshold,
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
