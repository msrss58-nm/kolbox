import { useSyncExternalStore } from "react";
import { APP_CONFIG } from "../constants/config";

const query = `(min-width: ${APP_CONFIG.desktopBreakpointPx}px)`;

function subscribe(cb: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

/** True at Tailwind's `md:` breakpoint and up. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
