/**
 * Phase 3C: pure fetch wrapper around the trusted, session-derived
 * `create_permission_user` v3 flow (`api/election-day/reauth.ts` +
 * `api/election-day/permission-users.ts`, both already deployed to
 * Production - Phase 3A/3B). No React/Zustand dependency, mirroring
 * `electionDaySessionClient.ts`'s own pattern exactly.
 *
 * The raw proof `reauthForCreatePermissionUser` resolves is NOT cached by
 * this module (or anywhere in it) - the caller (`useCreatePermissionUserTrusted.ts`)
 * must hold it only as a local variable for one continuous async flow and
 * never write it into `electionDayReauthProof.ts`'s store, which is
 * exclusively the legacy general-purpose proof cache shared by the other 10
 * `_v2` reauth-gated actions.
 */

const REAUTH_ENDPOINT = "/api/election-day/reauth";
const PERMISSION_USERS_ENDPOINT = "/api/election-day/permission-users";

export type TrustedReauthResult =
  | { status: "ok"; proof: string }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "error" };

export interface TrustedCreatedPermissionUser {
  id: string;
  name: string;
  roleId: string;
  workspaceId: string;
}

export type TrustedCreateResult =
  | { status: "ok"; user: TrustedCreatedPermissionUser }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "role_not_found" }
  | { status: "duplicate_name" }
  | { status: "invalid_request" }
  | { status: "error" };

function isTrustedCreatedPermissionUser(
  value: unknown,
): value is TrustedCreatedPermissionUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.roleId === "string" &&
    typeof v.workspaceId === "string"
  );
}

/** Mints a short-lived, action-bound proof for the `create_permission_user`
 * action against the current HttpOnly session. The browser never supplies
 * an actor/workspace - both are derived server-side from the session
 * cookie. Only `{status:"ok", proof}` on 200; every other outcome collapses
 * to one of the 3 remaining cases, never a raw HTTP status/body leaking
 * further than this function. */
export async function reauthForCreatePermissionUser(
  password: string,
): Promise<TrustedReauthResult> {
  try {
    const res = await fetch(REAUTH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action: "create_permission_user" }),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const proof =
        body &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).reauthProof === "string"
          ? ((body as Record<string, unknown>).reauthProof as string)
          : null;
      return proof ? { status: "ok", proof } : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 429) return { status: "rate_limited" };
    // 400 INVALID_REQUEST/INVALID_ACTION, 403 FORBIDDEN_ORIGIN, 5xx, and
    // anything else unexpected all collapse to the same generic "error" -
    // none of these should occur from this module's own well-formed
    // request, and none should be distinguishable from a plain network
    // failure by the caller (same reasoning as electionDaySessionClient.ts).
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Creates a PermissionUser via the trusted server path - the session
 * cookie proves the caller, `reauthProof` proves recent step-up
 * authentication for this exact action. `roleId` is a requested business
 * selection only, never an authority - the server independently verifies it
 * belongs to the caller's own workspace. */
export async function createPermissionUserTrusted(
  input: { name: string; password: string; roleId: string },
  reauthProof: string,
): Promise<TrustedCreateResult> {
  try {
    const res = await fetch(PERMISSION_USERS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        password: input.password,
        roleId: input.roleId,
        reauthProof,
      }),
    });
    if (res.status === 201) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return isTrustedCreatedPermissionUser(body)
        ? { status: "ok", user: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    if (res.status === 409) return { status: "duplicate_name" };
    if (res.status === 400) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "invalid_request" };
      }
      const code =
        body && typeof body === "object"
          ? (body as Record<string, unknown>).error
          : undefined;
      return code === "ROLE_NOT_FOUND"
        ? { status: "role_not_found" }
        : { status: "invalid_request" };
    }
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
