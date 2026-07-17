import { useEffect, useState } from "react";
import { APP_CONFIG } from "../constants/config";

/** Returns `value`, updated only after it stops changing for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs = APP_CONFIG.searchDebounceMs): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
