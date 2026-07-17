import { useEffect, useState } from "react";
import { APP_CONFIG } from "../../constants/config";

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

const ZERO: CountdownParts = {
  days: 0,
  hours: 0,
  minutes: 0,
  seconds: 0,
  expired: false,
};

function diffToParts(ms: number): CountdownParts {
  if (ms <= 0) return { ...ZERO, expired: true };
  const totalSeconds = Math.floor(ms / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: false,
  };
}

/** Ticks once a second toward `deadline` (ISO string). `Date.now()` only
 * ever runs inside the interval callback, never during render - see
 * CLAUDE.md's React Compiler purity rule. */
export function useCountdown(deadline: string | null): CountdownParts {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Deferred to a microtask (like useAsyncData's .then/.catch) rather than
    // called synchronously in the effect body, per the set-state-in-effect rule.
    Promise.resolve().then(() => setNow(Date.now()));
    const id = setInterval(
      () => setNow(Date.now()),
      APP_CONFIG.electionDayCountdownTickMs,
    );
    return () => clearInterval(id);
  }, []);

  if (!deadline || now === null) return ZERO;
  return diffToParts(new Date(deadline).getTime() - now);
}
