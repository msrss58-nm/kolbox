import { useCallback } from "react";
import { useAsyncData } from "../../hooks/useAsyncData";
import { api } from "../../services/api";
import type { Activist } from "../../types";

/**
 * Loads the activist roster and exposes a local sorted-upsert for add/edit
 * forms - avoids an extra network round-trip since the caller already has
 * the saved record.
 */
export function useActivists() {
  const fetchActivists = useCallback(() => api.listActivists(), []);
  const { data: activists, setData } = useAsyncData(fetchActivists);

  const upsert = useCallback(
    (activist: Activist) => {
      setData((prev) => {
        const list = prev ?? [];
        const exists = list.some((a) => a.id === activist.id);
        const next = exists
          ? list.map((a) => (a.id === activist.id ? activist : a))
          : [...list, activist];
        return next.sort((a, b) => b.tagCount - a.tagCount);
      });
    },
    [setData],
  );

  return { activists, upsert };
}
