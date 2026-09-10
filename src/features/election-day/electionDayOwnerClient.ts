import type { RawRoleRow } from "../../permissions/roleRecordMapper";
import type { NewRole, RoleUpdate } from "../../services/api/types";

/**
 * Phase 3C Roles Mutations: pure fetch wrappers around the Owner-only
 * backend surface (`api/election-day/owner-session.ts` / `owner-reauth.ts` /
 * `owner-roles.ts`) - mirrors `electionDaySessionClient.ts`'s/
 * `electionDayTrustedRolesClient.ts`'s own conventions exactly (a fixed,
 * small discriminated-union result per call, no HTTP status/error code ever
 * leaking past this module). No React/Zustand dependency.
 *
 * Every call here requires the caller to supply a Supabase Owner access
 * token explicitly - this module never reads it from any store or client
 * itself, so it stays trivially testable and has no hidden coupling to
 * `ownerAuthClient`.
 */

const OWNER_SESSION_ENDPOINT = "/api/election-day/owner-session";
const OWNER_REAUTH_ENDPOINT = "/api/election-day/owner-reauth";
const OWNER_ROLES_ENDPOINT = "/api/election-day/owner-roles";
// Stage 3B provisioning ops ride the generic Owner-JWT action router
// rather than a new endpoint - this project is at 12/12 Vercel Hobby
// Functions and a 13th file is impossible.
const OWNER_ACTIONS_ENDPOINT = "/api/election-day/owner-actions";

export interface OwnerContext {
  ownerId: string;
  workspaceId: string;
}

export type OwnerSessionResult =
  | { status: "ok"; context: OwnerContext }
  | { status: "unauthorized" }
  | { status: "error" };

function isOwnerContext(value: unknown): value is OwnerContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.ownerId === "string" && typeof v.workspaceId === "string";
}

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

/** Validates a Supabase Owner access token against the live `election_owners`
 * table and returns the server-derived {ownerId, workspaceId} - never trust
 * a locally-decoded JWT claim as Owner authority. */
export async function fetchOwnerSession(
  accessToken: string,
): Promise<OwnerSessionResult> {
  try {
    const res = await fetch(OWNER_SESSION_ENDPOINT, {
      method: "GET",
      headers: bearer(accessToken),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return isOwnerContext(body) ? { status: "ok", context: body } : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type OwnerRolesReadResult =
  | { status: "ok"; rows: RawRoleRow[] }
  | { status: "unauthorized" }
  | { status: "error" };

function isRawRoleRowShape(value: unknown): value is RawRoleRow {
  return typeof value === "object" && value !== null;
}

export async function fetchOwnerRoles(
  accessToken: string,
): Promise<OwnerRolesReadResult> {
  try {
    const res = await fetch(OWNER_ROLES_ENDPOINT, {
      method: "GET",
      headers: bearer(accessToken),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return Array.isArray(body) && body.every(isRawRoleRowShape)
        ? { status: "ok", rows: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type OwnerReauthAction =
  | "create_role"
  | "update_role"
  | "delete_role"
  | "clone_role"
  // Stage 3B. Mirrors owner-reauth.ts's server-side ALLOWED_OWNER_ACTIONS,
  // which is the authority - this union only stops a typo compiling.
  | "bootstrap_first_user";

export type OwnerReauthResult =
  | { status: "ok"; proof: string }
  | { status: "wrong_password" }
  | { status: "rate_limited" }
  | { status: "error" };

/** Password step-up - mints a fresh, one-time, action-bound proof. The
 * raw proof is returned to the caller's own async control flow only; this
 * module never stores it anywhere. */
export async function ownerReauth(
  accessToken: string,
  password: string,
  action: OwnerReauthAction,
): Promise<OwnerReauthResult> {
  try {
    const res = await fetch(OWNER_REAUTH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(accessToken) },
      body: JSON.stringify({ password, action }),
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const proof = (body as { reauthProof?: unknown } | null)?.reauthProof;
      return typeof proof === "string" && proof
        ? { status: "ok", proof }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "wrong_password" };
    if (res.status === 429) return { status: "rate_limited" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export type OwnerRoleMutationResult =
  | { status: "ok"; row: RawRoleRow }
  | { status: "ok_void" }
  | { status: "error"; code: string };

async function postOwnerRolesMutation(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<OwnerRoleMutationResult> {
  try {
    const res = await fetch(OWNER_ROLES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(accessToken) },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (res.status === 200) {
      if (parsed && typeof parsed === "object" && "ok" in (parsed as object)) {
        return { status: "ok_void" };
      }
      return isRawRoleRowShape(parsed)
        ? { status: "ok", row: parsed }
        : { status: "error", code: "SERVER_ERROR" };
    }
    const code =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : "SERVER_ERROR";
    return { status: "error", code };
  } catch {
    return { status: "error", code: "SERVER_ERROR" };
  }
}

export function createOwnerRole(
  accessToken: string,
  proof: string,
  input: NewRole,
): Promise<OwnerRoleMutationResult> {
  return postOwnerRolesMutation(accessToken, {
    op: "create",
    reauthProof: proof,
    name: input.name,
    description: input.description,
    permissions: input.permissions,
    scopeType: input.scopeType,
  });
}

export function updateOwnerRole(
  accessToken: string,
  proof: string,
  input: RoleUpdate,
): Promise<OwnerRoleMutationResult> {
  return postOwnerRolesMutation(accessToken, {
    op: "update",
    reauthProof: proof,
    roleId: input.id,
    name: input.name,
    description: input.description,
    permissions: input.permissions,
    scopeType: input.scopeType,
  });
}

export function deleteOwnerRole(
  accessToken: string,
  proof: string,
  id: string,
): Promise<OwnerRoleMutationResult> {
  return postOwnerRolesMutation(accessToken, {
    op: "delete",
    reauthProof: proof,
    roleId: id,
  });
}

export function cloneOwnerRole(
  accessToken: string,
  proof: string,
  id: string,
  newName: string,
): Promise<OwnerRoleMutationResult> {
  return postOwnerRolesMutation(accessToken, {
    op: "clone",
    reauthProof: proof,
    roleId: id,
    newName,
  });
}

/* ==========================================================================
 * Stage 3B - workspace provisioning
 *
 * These three calls are the only Owner surface reachable BEFORE an
 * election_owners row exists. fetchOwnerProvisioningState in particular must
 * never be confused with fetchOwnerSession above: that one 401s for an Owner
 * who has been approved but has not provisioned yet, which is precisely the
 * state this flow exists to handle.
 * ========================================================================== */

export type OwnerProvisioningStateName =
  | "provisioned"
  | "pending"
  | "expired"
  | "invalid";

export interface OwnerProvisioningState {
  state: OwnerProvisioningStateName;
  ownerId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  electionEndAt: string | null;
  loginCode: string | null;
  pendingName: string | null;
  pendingEmail: string | null;
  pendingExpiresAt: string | null;
  hasPermissionUsers: boolean;
}

export type OwnerProvisioningStateResult =
  | { status: "ok"; state: OwnerProvisioningState }
  | { status: "unauthorized" }
  | { status: "error" };

function asStateName(v: unknown): OwnerProvisioningStateName | null {
  return v === "provisioned" || v === "pending" || v === "expired" || v === "invalid"
    ? v
    : null;
}

function strOrNullField(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function fetchOwnerProvisioningState(
  accessToken: string,
): Promise<OwnerProvisioningStateResult> {
  try {
    const res = await fetch(`${OWNER_ACTIONS_ENDPOINT}?op=provisioning_state`, {
      method: "GET",
      headers: bearer(accessToken),
    });
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status !== 200) return { status: "error" };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: "error" };
    }
    if (!body || typeof body !== "object") return { status: "error" };
    const v = body as Record<string, unknown>;
    const name = asStateName(v.state);
    if (!name) return { status: "error" };

    return {
      status: "ok",
      state: {
        state: name,
        ownerId: strOrNullField(v.ownerId),
        workspaceId: strOrNullField(v.workspaceId),
        workspaceName: strOrNullField(v.workspaceName),
        electionEndAt: strOrNullField(v.electionEndAt),
        loginCode: strOrNullField(v.loginCode),
        pendingName: strOrNullField(v.pendingName),
        pendingEmail: strOrNullField(v.pendingEmail),
        pendingExpiresAt: strOrNullField(v.pendingExpiresAt),
        hasPermissionUsers: v.hasPermissionUsers === true,
      },
    };
  } catch {
    return { status: "error" };
  }
}

export interface ProvisionedWorkspace {
  workspaceId: string;
  ownerId: string;
  workspaceName: string;
  electionEndAt: string;
  loginCode: string;
  alreadyProvisioned: boolean;
}

export type ProvisionWorkspaceResult =
  | { status: "ok"; workspace: ProvisionedWorkspace }
  | { status: "error"; code: string };

async function postOwnerAction(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  try {
    const res = await fetch(OWNER_ACTIONS_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(accessToken) },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    if (res.status === 200) return { ok: true, data: parsed };
    const code =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : "SERVER_ERROR";
    return { ok: false, code };
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }
}

export async function provisionWorkspace(
  accessToken: string,
  input: { workspaceName: string; electionEndAt: string },
): Promise<ProvisionWorkspaceResult> {
  const result = await postOwnerAction(accessToken, {
    op: "provision_workspace",
    workspaceName: input.workspaceName,
    electionEndAt: input.electionEndAt,
  });
  if (!result.ok) return { status: "error", code: result.code };

  const v = result.data as Record<string, unknown> | null;
  if (
    !v ||
    typeof v.workspace_id !== "string" ||
    typeof v.owner_id !== "string" ||
    typeof v.login_code !== "string"
  ) {
    return { status: "error", code: "SERVER_ERROR" };
  }
  return {
    status: "ok",
    workspace: {
      workspaceId: v.workspace_id,
      ownerId: v.owner_id,
      workspaceName: typeof v.workspace_name === "string" ? v.workspace_name : "",
      electionEndAt: typeof v.election_end_at === "string" ? v.election_end_at : "",
      loginCode: v.login_code,
      alreadyProvisioned: v.already_provisioned === true,
    },
  };
}

export type BootstrapFirstUserResult =
  | { status: "ok"; name: string }
  | { status: "error"; code: string };

export async function bootstrapFirstUser(
  accessToken: string,
  proof: string,
  input: { name: string; password: string; roleId: string },
): Promise<BootstrapFirstUserResult> {
  const result = await postOwnerAction(accessToken, {
    op: "bootstrap_first_user",
    reauthProof: proof,
    name: input.name,
    password: input.password,
    roleId: input.roleId,
  });
  if (!result.ok) return { status: "error", code: result.code };

  // The RPC returns a single-row table, so the router forwards an array.
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as Record<
    string,
    unknown
  > | null;
  return row && typeof row.name === "string"
    ? { status: "ok", name: row.name }
    : { status: "error", code: "SERVER_ERROR" };
}
