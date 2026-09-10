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

/* ==========================================================================
 * Stage 3B - approve a new Election Owner.
 *
 * POSTs to the SAME endpoint as the session read above, with an `op`
 * multiplex. Not a stylistic choice: this project is at 12/12 Vercel Hobby
 * Functions with no per-project exclusion mechanism, so a dedicated file is
 * impossible. Keeping the operation on the Platform principal's own endpoint
 * also keeps it away from the Election Day handlers, whose Origin allow-list
 * would reject this origin outright.
 *
 * The response's activationLink is a ONE-TIME credential. It is returned to
 * the caller's own control flow and never stored, cached, or logged here.
 * ========================================================================== */

const PLATFORM_APPROVE_OWNER_OP = "create_owner_access";

export interface CreatedOwnerAccess {
  pendingId: string;
  expiresAt: string | null;
  alreadyExisted: boolean;
  /** Null when the approval succeeded but link generation did not - the
   * approval still stands and a link can be regenerated. */
  activationLink: string | null;
}

export type CreateOwnerAccessResult =
  | { status: "ok"; access: CreatedOwnerAccess }
  | { status: "error"; code: string };

export async function createOwnerAccess(
  accessToken: string,
  input: { name: string; email: string; phone?: string },
): Promise<CreateOwnerAccessResult> {
  try {
    const res = await fetch(PLATFORM_SESSION_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        op: PLATFORM_APPROVE_OWNER_OP,
        name: input.name,
        email: input.email,
        ...(input.phone ? { phone: input.phone } : {}),
      }),
    });

    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }

    if (res.status === 201) {
      const v = parsed as Record<string, unknown> | null;
      if (!v || typeof v.pendingId !== "string") {
        return { status: "error", code: "SERVER_ERROR" };
      }
      return {
        status: "ok",
        access: {
          pendingId: v.pendingId,
          expiresAt: typeof v.expiresAt === "string" ? v.expiresAt : null,
          alreadyExisted: v.alreadyExisted === true,
          activationLink: typeof v.activationLink === "string" ? v.activationLink : null,
        },
      };
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
