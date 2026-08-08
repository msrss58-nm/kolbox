import type { ElectionDayVoter } from "../../types";

export interface TurnoutPacePoint {
  hour: number;
  label: string;
  cumulative: number;
}

export interface TurnoutPaceStats {
  lastHourCount: number;
  prevHourCount: number;
  /** `null` when the previous hour had zero votes - a percentage change from
   * zero is meaningless, so callers must render a neutral state instead. */
  changePct: number | null;
  currentPacePerHour: number;
}

export interface TurnoutPaceResult {
  series: TurnoutPacePoint[];
  stats: TurnoutPaceStats;
}

const EMPTY_STATS: TurnoutPaceStats = {
  lastHourCount: 0,
  prevHourCount: 0,
  changePct: null,
  currentPacePerHour: 0,
};

/**
 * "קצב הצבעה" chart data - a real cumulative curve built entirely from
 * `votedAt` timestamps (no fabricated turnout goal/target). Buckets by local
 * hour-of-day, from the earliest recorded vote through the current hour.
 * Contacts with no `votedAt` (not yet voted) are simply not counted -
 * matches `resolveFollowUpStatus`'s own "voted always wins" precedence,
 * though this function only needs the raw voted/votedAt pair, not the full
 * follow-up state.
 */
export function buildTurnoutPaceSeries(
  contacts: readonly ElectionDayVoter[],
  now: Date = new Date(),
): TurnoutPaceResult {
  const votedTimes = contacts
    .filter((c) => c.voted && c.votedAt)
    .map((c) => new Date(c.votedAt as string));

  if (votedTimes.length === 0) {
    return { series: [], stats: EMPTY_STATS };
  }

  const nowHour = now.getHours();
  const minHour = Math.min(nowHour, ...votedTimes.map((d) => d.getHours()));

  const countByHour = new Map<number, number>();
  for (const d of votedTimes) {
    const h = d.getHours();
    countByHour.set(h, (countByHour.get(h) ?? 0) + 1);
  }

  const series: TurnoutPacePoint[] = [];
  let cumulative = 0;
  for (let h = minHour; h <= nowHour; h++) {
    cumulative += countByHour.get(h) ?? 0;
    series.push({ hour: h, label: `${String(h).padStart(2, "0")}:00`, cumulative });
  }

  const lastHourCount = countByHour.get(nowHour) ?? 0;
  const prevHourCount = countByHour.get(nowHour - 1) ?? 0;
  const changePct =
    prevHourCount > 0 ? ((lastHourCount - prevHourCount) / prevHourCount) * 100 : null;
  const hoursElapsed = Math.max(1, nowHour - minHour + 1);
  const currentPacePerHour = cumulative / hoursElapsed;

  return {
    series,
    stats: { lastHourCount, prevHourCount, changePct, currentPacePerHour },
  };
}
