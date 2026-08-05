import type { RoleCatalogStatus } from "../../permissions/roleCatalogController";
import type { RoleRecord } from "../../permissions/types";
import type { ElectionDayVoter } from "../../types";

/**
 * The single choke point that decides which contacts a signed-in Election
 * Day session may see (Dynamic Roles & Permissions Phase 1) - every
 * derived value in `useElectionDay.ts` (`stats`/`coordinatorBreakdown`/
 * `rideCoordinationQueue`/the paginated list/etc.) reads through
 * `scopedContacts`, which is this function's result, instead of the raw
 * fetched list.
 *
 * Fail-closed by construction: the ONLY ways to see every contact are (a)
 * no Election Day session exists yet at all (the pre-existing, approved
 * bootstrap window - see `ElectionDayGuard`, unrelated to and unchanged by
 * this phase) or (b) a resolved role whose `scopeType` is exactly `"all"`.
 * Every other state - the catalog still loading, a failed fetch, a session
 * role with no matching catalog row, or a resolved role with a missing/
 * unrecognized `scopeType` - returns `[]`, never the unfiltered list. There
 * is no path that reaches "show everything" through a `null`/error/loading
 * state; only an explicit `scopeType === "all"` does.
 *
 * Pure and dependency-free (no hook, no store import) so it is directly
 * Node-testable (see `scripts/smoke-election-day-scope.ts`) the same way
 * `computePermissions.ts` is.
 */
export function resolveVisibleContacts(
  contacts: ElectionDayVoter[] | null,
  sessionUser: { name: string } | null,
  catalogStatus: RoleCatalogStatus,
  role: RoleRecord | null,
): ElectionDayVoter[] | null {
  if (!contacts) return contacts; // the contact list itself hasn't loaded yet - unrelated to roles
  if (!sessionUser) return contacts; // pre-existing bootstrap window - unchanged, out of scope here
  if (catalogStatus !== "loaded") return []; // idle / loading / error -> fail closed
  if (!role) return []; // session's role text matched no catalog row -> fail closed
  if (role.scopeType === "all") return contacts;
  if (role.scopeType === "assigned_to_me") {
    return contacts.filter((c) => c.coordinator === sessionUser.name);
  }
  return []; // missing/unrecognized scopeType -> fail closed
}
