import { useEffect, useRef, useState } from "react";
import { APP_CONFIG } from "../constants/config";

/** Animates 0 → target with ease-out once the target is known. */
export function useCountUp(
  target: number,
  durationMs = APP_CONFIG.countUpDurationMs,
): number {
  const [value, setValue] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, durationMs]);

  return value;
}
