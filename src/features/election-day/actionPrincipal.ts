import { ownerAuthClient } from "../../services/supabase/ownerAuthClient";

/**
 * WHICH PRINCIPAL the Election Day / Budget module surfaces are being driven
 * by right now - the ONE place that decides it, and the ONE place the trusted
 * clients read it from.
 *
 * Both principals already have a COMPLETE, symmetric server surface:
 *   worker -> POST /api/election-day/actions        (HttpOnly session cookie)
 *   owner  -> POST /api/election-day/owner-actions  (Owner JWT, Bearer)
 * `actions.ts` and `owner-actions.ts` share the same op table, the same body
 * shape (`{ op, ...args }`), the same `?op=` GET convention and the same
 * response/error codes, and the owner side re-resolves the Owner's workspace
 * live and gates every module op on the workspace entitlement
 * (`election_day_owner_has_module`). So this module selects an ENDPOINT and a
 * CREDENTIAL - it never introduces a second protocol, a second screen or a
 * second permission model.
 *
 * Deliberately a module-level value rather than a store read: the trusted
 * clients are plain fetch wrappers imported by `electionDaySession` itself,
 * so reading the session store from them would be a circular import. The
 * session bootstrap is the single writer (see `setActionPrincipal`), exactly
 * the module-level capture pattern this codebase already uses elsewhere.
 *
 * Default is "worker" so every pre-existing code path is byte-identical
 * unless an Owner session was actually resolved.
 */
export type ActionPrincipal = "worker" | "owner";

let current: ActionPrincipal = "worker";

/** Set ONLY by `electionDaySession`'s bootstrap/login/logout, never guessed
 * from "is some token present" - a browser can legitimately hold both an
 * Owner Auth session and a worker cookie, and the resolved session decides. */
export function setActionPrincipal(principal: ActionPrincipal): void {
  current = principal;
}

export function getActionPrincipal(): ActionPrincipal {
  return current;
}

export function isOwnerPrincipal(): boolean {
  return current === "owner";
}

/** A pair of equivalent endpoints, one per principal. */
export interface TrustedEndpoints {
  worker: string;
  owner: string;
}

/**
 * Issues one trusted request against whichever endpoint belongs to the
 * current principal, attaching the Owner bearer token when that is the
 * Owner. The worker branch is the original call, unchanged: same URL, same
 * headers, same cookie-carrying default credentials.
 *
 * A missing Owner token is NOT silently downgraded to the worker endpoint -
 * that would send an Owner's action as an unauthenticated worker call. It
 * throws, and the caller's existing error path reports it.
 */
export async function trustedFetch(
  endpoints: TrustedEndpoints,
  init: RequestInit = {},
  search = "",
): Promise<Response> {
  if (current !== "owner") {
    return await fetch(`${endpoints.worker}${search}`, init);
  }
  const { data } = await ownerAuthClient.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error("OWNER_SESSION_MISSING");
  }
  return await fetch(`${endpoints.owner}${search}`, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });
}
