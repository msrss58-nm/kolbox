/**
 * Platform Stage 5: pure fetch wrapper around the Multi-Entity Owner session
 * endpoint (`GET /api/multi-entity/session`). Same conventions as
 * `platformOwnerClient.ts` - a small discriminated union, no HTTP status
 * leaking past this module, no React/zustand dependency, and the access token
 * supplied explicitly by the caller.
 *
 * The SERVER is the authority. It verifies the JWT (getUser -> getClaims
 * aal2 -> the exclusive seat) and derives the assigned-workspace list from
 * committed rows on every call. A `200` here is the ONLY thing that may unlock
 * the Multi-Entity surface; nothing client-side is ever sufficient.
 */

const MULTI_ENTITY_SESSION_ENDPOINT = "/api/multi-entity/session";

/** Authorization metadata only - never login_code, never business data. */
export interface MultiEntityWorkspace {
  workspaceId: string;
  name: string;
  electionEndAt: string;
  assignedAt: string;
}

export interface MultiEntityOwnerContext {
  authUserId: string;
  email: string;
  name: string;
  workspaces: MultiEntityWorkspace[];
}

export type MultiEntityOwnerSessionResult =
  | { status: "ok"; context: MultiEntityOwnerContext }
  /** 401 - not the current Multi-Entity Owner, not aal2, or a bad/revoked token. */
  | { status: "unauthorized" }
  /** Transport failure, 405, 500, or an unparseable/malformed body. */
  | { status: "error" };

function isWorkspace(value: unknown): value is MultiEntityWorkspace {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.workspaceId === "string" &&
    typeof v.name === "string" &&
    typeof v.electionEndAt === "string" &&
    typeof v.assignedAt === "string"
  );
}

function toContext(value: unknown): MultiEntityOwnerContext | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.authUserId !== "string" ||
    typeof v.email !== "string" ||
    typeof v.name !== "string" ||
    !Array.isArray(v.workspaces) ||
    !v.workspaces.every(isWorkspace)
  ) {
    return null;
  }
  // Rebuilt field by field so nothing unexpected is ever carried into state.
  return {
    authUserId: v.authUserId,
    email: v.email,
    name: v.name,
    workspaces: v.workspaces.map((w: MultiEntityWorkspace) => ({
      workspaceId: w.workspaceId,
      name: w.name,
      electionEndAt: w.electionEndAt,
      assignedAt: w.assignedAt,
    })),
  };
}

export async function fetchMultiEntityOwnerSession(
  accessToken: string,
): Promise<MultiEntityOwnerSessionResult> {
  try {
    const res = await fetch(MULTI_ENTITY_SESSION_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      const context = toContext(body);
      return context ? { status: "ok", context } : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
