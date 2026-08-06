import { useEffect, useMemo } from "react";
import { useElectionDaySession } from "../features/election-day/electionDaySession";
import { computePermissions, type PermissionsResult } from "./computePermissions";
import { useRoleCatalogStore } from "./roleCatalogStore";

export type UsePermissionsResult = PermissionsResult;

/**
 * General-purpose permission hook - the engine itself (types /
 * `permissionsMap` / `hasPermission` / `resolveSessionRole` /
 * `computePermissions`) has zero React or Election Day dependency. The
 * Election-Day-specific pieces are this hook's two sources - the session
 * (`useElectionDaySession`) and the live role catalog (`useRoleCatalogStore`,
 * Dynamic Roles & Permissions Phase 1) - isolated here so either could be
 * swapped without touching the engine itself.
 *
 * Triggers `ensureLoaded()` only while a session actually exists: with no
 * session, `computePermissions` already denies everything regardless of the
 * catalog, so fetching it would be pure waste (and would otherwise fire an
 * unauthenticated RPC call on every page of the main app, since this hook is
 * also called unconditionally from `AppLayout`). Runs on every render where
 * the catalog is `"idle"` or `"error"` (not `"loading"`/`"loaded"`) - so a
 * failed fetch gets one more attempt on the next mount (e.g. leaving and
 * returning to `/election-day`), bounded by React's own render cadence, never
 * an unbounded timer loop.
 *
 * A missing session (nobody signed in yet, including the pre-roster
 * bootstrap window) yields `role: null` and denies every permission - if a
 * bootstrap/loading flow needs different treatment, that is a UI-layer
 * decision, not something this hook papers over with an implicit elevated
 * role. Loading/error/an unrecognized role text resolve exactly the same
 * way - see `computePermissions`'s fail-closed contract.
 */
export function usePermissions(): UsePermissionsResult {
  const sessionUser = useElectionDaySession((s) => s.user);
  const catalogStatus = useRoleCatalogStore((s) => s.status);
  const roles = useRoleCatalogStore((s) => s.roles);
  const ensureLoaded = useRoleCatalogStore((s) => s.ensureLoaded);

  useEffect(() => {
    if (sessionUser && (catalogStatus === "idle" || catalogStatus === "error")) {
      void ensureLoaded();
    }
  }, [sessionUser, catalogStatus, ensureLoaded]);

  return useMemo(
    () => computePermissions(sessionUser?.roleId ?? null, catalogStatus, roles),
    [sessionUser, catalogStatus, roles],
  );
}
