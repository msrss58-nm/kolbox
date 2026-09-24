import { useEffect, useRef } from "react";

/**
 * Runs `task` repeatedly while the document is VISIBLE, and once immediately
 * when it becomes visible again after having been hidden.
 *
 * For authoritative data that can change in a place this tab cannot be
 * notified about - another browser, another session, another principal
 * entirely. A post-mutation callback cannot cover that case and neither can
 * re-reading on navigation, because the operator may simply sit on the screen.
 *
 * Two properties make it safe to leave running:
 *  - Nothing ticks while the tab is hidden. The interval is torn down on
 *    `hidden` and rebuilt on `visible`, so a backgrounded console issues no
 *    requests at all rather than quietly polling in the background.
 *  - Ticks never overlap. While one run is still in flight the next tick is
 *    skipped, so a slow or failing read cannot pile requests up.
 *
 * `task` is read through a ref, so an inline closure does not restart the
 * timer on every render; only `everyMs` does.
 */
export function useVisibleInterval(
  task: () => Promise<unknown> | void,
  everyMs: number,
): void {
  const taskRef = useRef(task);
  // Refreshed in an effect, not during render - the React Compiler rule
  // forbids touching a ref in the render phase. Runs after every commit, which
  // is exactly "always the latest closure" for a timer that fires later.
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let running = false;
    let cancelled = false;

    const run = () => {
      if (running || cancelled || document.visibilityState !== "visible") return;
      running = true;
      void Promise.resolve(taskRef.current()).finally(() => {
        running = false;
      });
    };

    const start = () => {
      if (timer !== null) return;
      timer = setInterval(run, everyMs);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Catch up on whatever changed while the tab was away, then resume.
        run();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [everyMs]);
}
