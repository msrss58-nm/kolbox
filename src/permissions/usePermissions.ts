import { useMemo } from "react";
import { useElectionDaySession } from "../features/election-day/electionDaySession";
import { computePermissions, type PermissionsResult } from "./computePermissions";

export type UsePermissionsResult = PermissionsResult;

/**
 * General-purpose permission hook - the engine itself (types /
 * `permissionsMap` / `hasPermission` / `resolveEffectiveRole` /
 * `computePermissions`) has zero React or Election Day dependency. The
 * only Election-Day-specific piece is this hook's role SOURCE
 * (`useElectionDaySession`), isolated here so a future second role source
 * (e.g. the main app's Supabase `profiles.role`) could be wired in without
 * touching the engine itself.
 *
 * A missing session (nobody signed in yet, including the pre-roster
 * bootstrap window) yields `role: null` and denies every permission - if a
 * bootstrap/loading flow needs different treatment, that is a Stage 2
 * UI-layer decision, not something this hook papers over with an implicit
 * elevated role.
 *
 * Not yet connected to any component (Stage 1 - see task-plan.md).
 */
export function usePermissions(): UsePermissionsResult {
  const sessionUser = useElectionDaySession((s) => s.user);
  return useMemo(() => computePermissions(sessionUser?.role ?? null), [sessionUser]);
}
