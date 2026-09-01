import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import { Card, CardTitle } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { APP_CONFIG } from "../../constants/config";
import { useAsyncData } from "../../hooks/useAsyncData";
import { usePermissions } from "../../permissions/usePermissions";
import type { ElectionDayVoter } from "../../types";
import { buildCoordinatorReminderSupervision } from "./coordinatorReminderSupervision";
import { CoordinatorReminderDetailModal } from "./CoordinatorReminderDetailModal";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { fetchCoordinatorsTrusted } from "./electionDayTrustedCoordinatorAllocationClient";
import { formatWaitingDuration } from "./reminderDisplay";

const text = ELECTION_DAY_TEXT.dashboard.reminderSupervision;

/**
 * Manager Dashboard Reminders ("תזכורות לטיפול") - supervisory visibility
 * into which coordinators currently have DUE reminders waiting, distinct
 * from (and never a replacement for) the personal popup stack a scoped
 * coordinator sees (`OverdueReminderStack.tsx`). Manager-only: gated on
 * `role.scopeType === "all"`, the exact complementary condition
 * `OverdueReminderStack` already uses to decide who gets personal popups -
 * a manager was already excluded from those, unchanged by this card.
 *
 * Purely derived from `scopedContacts` (already-fetched, already
 * Realtime-subscribed - see `useElectionDay.ts`) via the shared
 * `resolveReminderLifecycleState`/"due" definition - no new fetch, no new
 * RPC, no polling. Own local ticking `now` (same tick interval
 * `OverdueReminderStack` uses) only so the displayed "waiting X" durations
 * keep advancing between real data changes - the row set itself
 * (which coordinators/voters appear) still only actually changes when the
 * underlying reminder data does, via the existing Realtime subscription.
 */
export function CoordinatorReminderSupervisionCard({
  contacts,
}: {
  contacts: readonly ElectionDayVoter[];
}) {
  const { role } = usePermissions();
  const [selectedCoordinator, setSelectedCoordinator] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Own small fetch for phone resolution only - the reminder rows
  // themselves stay derived purely from `contacts` as before, never gated
  // on this. See `resolveCoordinatorPhoneForReminderRow`'s own comment for
  // why an unmatched/ambiguous name still shows no phone.
  //
  // Multi-Tenant Phase 4B Frontend Cutover: cut over from the legacy
  // `api.listCoordinators()` global plain SELECT to the same trusted,
  // session-derived read `useCoordinatorAllocation.ts` already uses
  // (`fetchCoordinatorsTrusted`) - no longer a "separate consumer with its
  // own legacy read", per the approved cutover scope. During
  // `ElectionDayGuard`'s roster-empty bootstrap window (no session yet)
  // this fetch fails silently (`useAsyncData` stores the rejection in its
  // own unread `error` state, never throws/logs) - harmless, since `role`
  // also can't resolve without a session, so `isManager` below is already
  // `false` and this card renders nothing in that window regardless of
  // which read this fetch uses.
  const fetchCoordinators = useCallback(() => fetchCoordinatorsTrusted(), []);
  const { data: coordinators } = useAsyncData(fetchCoordinators);

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(
      () => setNow(new Date()),
      APP_CONFIG.electionDayReminderPopupTickMs,
    );
    return () => clearInterval(id);
  }, []);

  const isManager = role?.scopeType === "all";

  const rows = useMemo(
    () => (isManager ? buildCoordinatorReminderSupervision(contacts, now) : []),
    [isManager, contacts, now],
  );

  if (!isManager) return null;

  const selectedRow = rows.find((r) => r.coordinator === selectedCoordinator) ?? null;
  const visibleCount = APP_CONFIG.electionDayReminderSupervisionVisibleCount;
  const hasMore = rows.length > visibleCount;
  const visibleRows = expanded ? rows : rows.slice(0, visibleCount);

  return (
    <>
      <Card className="min-w-0">
        <CardTitle>{text.title}</CardTitle>
        {rows.length === 0 ? (
          <div className="mt-2">
            <EmptyState icon={BellRing} title={text.empty} />
          </div>
        ) : (
          <div className="mt-2 min-w-0 divide-y divide-slate-100">
            {visibleRows.map((row) => (
              <button
                key={row.coordinator}
                type="button"
                onClick={() => setSelectedCoordinator(row.coordinator)}
                className="flex min-w-0 w-full items-center justify-between gap-3 py-2 text-start transition hover:bg-amber-50"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">
                  {row.coordinator}
                </span>
                <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-amber-700">
                  {text.dueCount(row.dueCount)}
                </span>
                <span className="hidden shrink-0 whitespace-nowrap text-xs text-slate-500 sm:inline">
                  {text.oldestWaiting(formatWaitingDuration(row.oldestReminderAt, now))}
                </span>
              </button>
            ))}
          </div>
        )}
        {hasMore && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 w-full rounded-lg py-1.5 text-center text-xs font-semibold text-primary-600 hover:bg-primary-50"
          >
            {expanded ? text.showFewer : text.showAll(rows.length)}
          </button>
        )}
      </Card>

      <CoordinatorReminderDetailModal
        open={selectedCoordinator !== null}
        row={selectedRow}
        now={now}
        coordinators={coordinators ?? []}
        onClose={() => setSelectedCoordinator(null)}
      />
    </>
  );
}
