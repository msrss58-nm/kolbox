/**
 * Phase 3C Users (EXPAND, not yet wired to the frontend): pure fetch
 * wrappers around the trusted, session-derived roster/delete/reset-password
 * v3 flow (`api/election-day/permission-users.ts`'s GET handler,
 * `api/election-day/permission-users-delete.ts`,
 * `api/election-day/permission-users-reset-password.ts`). No React/Zustand
 * dependency, mirroring `electionDayTrustedPermissionUserClient.ts`'s own
 * pattern exactly.
 *
 * Neither `deletePermissionUserTrusted` nor `resetPermissionUserPasswordTrusted`
 * caches the reauth proof passed to them - the caller (the dedicated trusted
 * hooks) must hold it only as a local variable for one continuous async
 * flow and never write it into `electionDayReauthProof.ts`'s store, which is
 * exclusively the legacy general-purpose proof cache shared by the other 9
 * still-legacy `_v2` reauth-gated actions.
 */

const PERMISSION_USERS_ENDPOINT = "/api/election-day/permission-users";
const DELETE_ENDPOINT = "/api/election-day/permission-users-delete";
const RESET_PASSWORD_ENDPOINT = "/api/election-day/permission-users-reset-password";

export interface TrustedRosterUser {
  id: string;
  name: string;
  roleId: string;
}

export type TrustedRosterResult =
  | { status: "ok"; users: TrustedRosterUser[] }
  | { status: "unauthorized" }
  | { status: "error" };

function isTrustedRosterUser(value: unknown): value is TrustedRosterUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.name === "string" && typeof v.roleId === "string"
  );
}

/** Session-derived, workspace-scoped roster read - no reauth proof needed
 * (a read carries no step-up requirement). Does NOT replace `ApiClient.
 * listPermissionUsers()` (the legacy, unscoped roster read) - that remains
 * the only roster source the live UI actually renders from until a
 * separate, later, explicit frontend cutover decision. */
export async function fetchTrustedPermissionUsersRoster(): Promise<TrustedRosterResult> {
  try {
    const res = await fetch(PERMISSION_USERS_ENDPOINT, { method: "GET" });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return Array.isArray(body) && body.every(isTrustedRosterUser)
        ? { status: "ok", users: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type TrustedReauthResult =
  | { status: "ok"; proof: string }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "error" };

async function reauthForAction(
  password: string,
  action: "delete_permission_user" | "reset_permission_user_password",
): Promise<TrustedReauthResult> {
  try {
    const res = await fetch("/api/election-day/reauth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, action }),
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
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Mints a one-time, action-bound proof for the `delete_permission_user`
 * action against the current HttpOnly session. */
export function reauthForDeletePermissionUser(
  password: string,
): Promise<TrustedReauthResult> {
  return reauthForAction(password, "delete_permission_user");
}

/** Mints a one-time, action-bound proof for the `reset_permission_user_password`
 * action against the current HttpOnly session. */
export function reauthForResetPermissionUserPassword(
  password: string,
): Promise<TrustedReauthResult> {
  return reauthForAction(password, "reset_permission_user_password");
}

export type TrustedDeleteResult =
  | { status: "ok" }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "cannot_delete_self" }
  | { status: "user_not_found" }
  | { status: "invalid_request" }
  | { status: "error" };

/** Deletes a PermissionUser via the trusted server path - the session
 * cookie proves the caller, `reauthProof` proves recent one-time step-up
 * authentication for this exact action and exact call. The server derives
 * actor/workspace itself and rejects a target outside the caller's own
 * workspace with the SAME error as a nonexistent id. */
export async function deletePermissionUserTrusted(
  targetUserId: string,
  reauthProof: string,
): Promise<TrustedDeleteResult> {
  try {
    const res = await fetch(DELETE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId, reauthProof }),
    });
    if (res.status === 200) return { status: "ok" };
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    if (res.status === 404) return { status: "user_not_found" };
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
      return code === "CANNOT_DELETE_SELF"
        ? { status: "cannot_delete_self" }
        : { status: "invalid_request" };
    }
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export interface TrustedResetPasswordResult_Ok {
  id: string;
  name: string;
  roleId: string;
}

export type TrustedResetPasswordResult =
  | { status: "ok"; user: TrustedResetPasswordResult_Ok }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "user_not_found" }
  | { status: "invalid_password" }
  | { status: "error" };

function isTrustedResetPasswordUser(
  value: unknown,
): value is TrustedResetPasswordResult_Ok {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.name === "string" && typeof v.roleId === "string"
  );
}

/** Resets a PermissionUser's password via the trusted server path. On
 * success, the server also revokes every one of the target's active
 * sessions and outstanding legacy reauth proofs - an already-authenticated
 * compromised session cannot remain valid after this call. */
export async function resetPermissionUserPasswordTrusted(
  targetUserId: string,
  newPassword: string,
  reauthProof: string,
): Promise<TrustedResetPasswordResult> {
  try {
    const res = await fetch(RESET_PASSWORD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId, newPassword, reauthProof }),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return isTrustedResetPasswordUser(body)
        ? { status: "ok", user: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    if (res.status === 404) return { status: "user_not_found" };
    if (res.status === 400) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "invalid_password" };
      }
      const code =
        body && typeof body === "object"
          ? (body as Record<string, unknown>).error
          : undefined;
      return code === "INVALID_PASSWORD"
        ? { status: "invalid_password" }
        : { status: "error" };
    }
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
