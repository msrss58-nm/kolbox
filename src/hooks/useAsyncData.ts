import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

export interface UseAsyncDataResult<T> {
  /** `null` until the first successful load. */
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Re-runs the fetcher (e.g. after a mutation invalidates the data). */
  reload: () => void;
  /**
   * Writes to the local cache without a network round-trip - for optimistic
   * updates after a mutation the caller already knows the result of
   * (e.g. patching one classified voter into the fetched list).
   */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * Runs `fetcher` on mount and whenever its identity changes, exposing the
 * load/data/error state every page currently re-implements by hand.
 *
 * `fetcher` must be stable across renders - wrap it in `useCallback`
 * (or pass a function with no closed-over changing values).
 *
 * @example
 * const fetchStats = useCallback(() => api.getStats(), []);
 * const { data: stats, loading } = useAsyncData(fetchStats);
 */
export function useAsyncData<T>(fetcher: () => Promise<T>): UseAsyncDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Flip back to "loading" the instant a new request starts, without an
  // effect - comparing-and-setting during render is React's sanctioned
  // alternative to a state-reset effect (react.dev "You Might Not Need an
  // Effect" → adjusting state during render). The effect below then only
  // ever calls setState from inside its async .then/.catch/.finally
  // continuations, which run after render, not synchronously in the effect.
  const [trackedRequest, setTrackedRequest] = useState<[typeof fetcher, number]>([
    fetcher,
    reloadToken,
  ]);
  if (trackedRequest[0] !== fetcher || trackedRequest[1] !== reloadToken) {
    setTrackedRequest([fetcher, reloadToken]);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return { data, loading, error, reload, setData };
}
