/**
 * Phase 3B Step 2: pure fetch wrapper around the trusted server-side
 * session endpoint (`api/election-day/session.ts`, deployed in Phase 3B
 * Step 1). No React/Zustand dependency - `electionDaySession.ts`'s zustand
 * store is the only caller.
 *
 * The raw session token never reaches this module (or any other JS) - it
 * only ever exists as the HttpOnly `__Host-kb_ed_session` cookie, sent/read
 * automatically by the browser on same-origin requests.
 */

const SESSION_ENDPOINT = "/api/election-day/session";

export interface ServerSessionUser {
  id: string;
  name: string;
  roleId: string;
  /** Server-derived metadata only - never an authorization authority on the
   * frontend (see CLAUDE.md's Phase 3B notes). */
  workspaceId: string;
}

/**
 * The only 4 outcomes callers need to distinguish - internal details (which
 * HTTP status, which server error code) never leak past this module.
 * `rate_limited` is structurally impossible from `getSession()` (the GET
 * path has no rate-limit check server-side) - it only ever occurs from
 * `login()`.
 */
export type SessionClientResult =
  | { status: "authenticated"; user: ServerSessionUser }
  | { status: "unauthenticated" }
  | { status: "rate_limited" }
  | { status: "error" };

function isServerSessionUser(value: unknown): value is ServerSessionUser {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.roleId === "string" &&
    typeof v.workspaceId === "string"
  );
}

async function parseSessionResponse(res: Response): Promise<SessionClientResult> {
  if (res.status === 200) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: "error" };
    }
    return isServerSessionUser(body)
      ? { status: "authenticated", user: body }
      : { status: "error" };
  }
  if (res.status === 401) return { status: "unauthenticated" };
  if (res.status === 429) return { status: "rate_limited" };
  // 403 FORBIDDEN_ORIGIN, 5xx, and anything else unexpected all collapse to
  // the same generic "error" category - none of these are ever the user's
  // fault, and none of them should be distinguishable from a plain network
  // failure by the caller.
  return { status: "error" };
}

export async function getSession(): Promise<SessionClientResult> {
  try {
    const res = await fetch(SESSION_ENDPOINT, { method: "GET" });
    return await parseSessionResponse(res);
  } catch {
    return { status: "error" };
  }
}

export async function login(
  name: string,
  password: string,
): Promise<SessionClientResult> {
  try {
    const res = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password }),
    });
    return await parseSessionResponse(res);
  } catch {
    return { status: "error" };
  }
}

/**
 * The only 2 outcomes a caller needs: did the server confirm the session is
 * gone, or not. The deployed DELETE contract is idempotent and always
 * returns 200 (revoking + clearing the cookie when a session existed, a
 * pure no-op when it didn't) - a non-200 response or a network failure are
 * both `"error"`, indistinguishable from each other, same as every other
 * result in this module. `401` is not part of the deployed contract for
 * this endpoint/method and is deliberately not special-cased.
 */
export type LogoutClientResult = { status: "ok" } | { status: "error" };

export async function logout(): Promise<LogoutClientResult> {
  try {
    const res = await fetch(SESSION_ENDPOINT, { method: "DELETE" });
    return res.status === 200 ? { status: "ok" } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}
