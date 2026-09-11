import { useCallback, useEffect, useRef } from "react";
import { useAsyncData } from "../../hooks/useAsyncData";
import { multiEntityOwnerAuthClient } from "../../services/supabase/multiEntityOwnerAuthClient";
import {
  fetchMultiEntityAggregates,
  fetchMultiEntityWorkspaceAggregate,
  type MultiEntityAggregatesResult,
  type MultiEntityWorkspaceAggregateResult,
} from "./multiEntityOwnerClient";
import { useMultiEntityOwnerSession } from "./multiEntityOwnerSession";

/**
 * Platform Stage 7: the dashboard's data hooks.
 *
 * FRESHNESS - one trigger, no polling: the fetcher is keyed on the session
 * store's `context` object, which is replaced on EVERY successful server
 * re-resolution (route entry, the guard's tab-visible revalidation, the
 * manual "refresh" button). So each authoritative re-check of the seat is
 * followed by a fresh aggregate read, and an assignment added or removed
 * shows up on that next read.
 *
 * STORAGE - in memory only (component state via `useAsyncData`). Nothing is
 * written to localStorage/sessionStorage/IndexedDB; a reload starts empty.
 *
 * A 401 from an aggregate endpoint hands control back to the guard by
 * re-running the store's single resolver (which lands on `forbidden` or
 * `signed_out`); the cooldown stops a pathological 401 loop.
 */

type Fetched<T> = T & { fetchedAt: number };

const RE_RESOLVE_COOLDOWN_MS = 10_000;

async function currentAccessToken(): Promise<string | null> {
  try {
    const { data } = await multiEntityOwnerAuthClient.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useReResolveOnUnauthorized(result: { status: string } | null) {
  const refreshStatus = useMultiEntityOwnerSession((s) => s.refreshStatus);
  const lastForcedAt = useRef(0);
  useEffect(() => {
    if (result?.status !== "unauthorized") return;
    const now = Date.now();
    if (now - lastForcedAt.current < RE_RESOLVE_COOLDOWN_MS) return;
    lastForcedAt.current = now;
    void refreshStatus();
  }, [result, refreshStatus]);
}

export function useMultiEntityAggregates() {
  const context = useMultiEntityOwnerSession((s) => s.context);
  const fetcher = useCallback(async (): Promise<Fetched<MultiEntityAggregatesResult>> => {
    if (!context) return { status: "unauthorized", fetchedAt: Date.now() };
    const token = await currentAccessToken();
    const result: MultiEntityAggregatesResult = token
      ? await fetchMultiEntityAggregates(token)
      : { status: "unauthorized" };
    return { ...result, fetchedAt: Date.now() };
  }, [context]);
  const { data, loading } = useAsyncData(fetcher);
  useReResolveOnUnauthorized(data);
  return { result: data, loading };
}

export function useMultiEntityWorkspaceAggregate(workspaceId: string) {
  const context = useMultiEntityOwnerSession((s) => s.context);
  const fetcher = useCallback(async (): Promise<
    Fetched<MultiEntityWorkspaceAggregateResult>
  > => {
    if (!context) return { status: "unauthorized", fetchedAt: Date.now() };
    // A malformed id can never be an assigned workspace - no request needed.
    if (!UUID_PATTERN.test(workspaceId))
      return { status: "not_assigned", fetchedAt: Date.now() };
    const token = await currentAccessToken();
    const result: MultiEntityWorkspaceAggregateResult = token
      ? await fetchMultiEntityWorkspaceAggregate(token, workspaceId)
      : { status: "unauthorized" };
    return { ...result, fetchedAt: Date.now() };
  }, [context, workspaceId]);
  const { data, loading } = useAsyncData(fetcher);
  useReResolveOnUnauthorized(data);
  return { result: data, loading };
}
