/**
 * Platform Stage 2: pure fetch wrapper around the Platform Owner session
 * endpoint (`GET /api/platform/session`). Mirrors
 * `electionDayOwnerClient.ts`'s conventions exactly - a small discriminated
 * union per call, no HTTP status ever leaking past this module, no
 * React/zustand dependency, and the access token supplied explicitly by the
 * caller (this module never reads any Supabase client itself).
 *
 * The SERVER is the authority. It independently verifies the JWT signature,
 * requires `claims.aal === "aal2"`, and requires membership of the singleton
 * `platform_owners` row. A `200` from here is the ONLY thing that may unlock
 * the console - client-side state (a cached owner object, a locally-decoded
 * AAL claim) is never sufficient on its own.
 */

const PLATFORM_SESSION_ENDPOINT = "/api/platform/session";

export interface PlatformOwnerContext {
  platformOwnerId: string;
  email: string;
}

export type PlatformOwnerSessionResult =
  | { status: "ok"; context: PlatformOwnerContext }
  /** 401 - not a Platform Owner, not `aal2`, or a bad/revoked token. */
  | { status: "unauthorized" }
  /** Transport failure, 405, 500, or an unparseable/malformed body. */
  | { status: "error" };

function isPlatformOwnerContext(value: unknown): value is PlatformOwnerContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.platformOwnerId === "string" && typeof v.email === "string";
}

export async function fetchPlatformOwnerSession(
  accessToken: string,
): Promise<PlatformOwnerSessionResult> {
  try {
    const res = await fetch(PLATFORM_SESSION_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 200) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { status: "error" };
      }
      return isPlatformOwnerContext(body)
        ? { status: "ok", context: body }
        : { status: "error" };
    }
    if (res.status === 401) return { status: "unauthorized" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
