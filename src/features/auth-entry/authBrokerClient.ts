/**
 * Fetch wrappers for the KOLBOX Auth broker and the target-origin handoff.
 *
 * The handoff code returned by `brokerLogin` is held by the caller in a JS
 * variable and submitted as a form field. It is NEVER written to the URL,
 * `localStorage`, `sessionStorage`, a cookie, or a DOM attribute that
 * survives navigation - that absence is a login-CSRF control, not hygiene.
 *
 * The transaction value itself never reaches this module at all: it lives in
 * the target origin's `__Host-` HttpOnly cookie, which no script can read.
 */

export interface BrokerLoginSuccess {
  status: "ok";
  code: string;
  targetOrigin: string;
  realm: string;
}

/** One shape for every failure. The caller cannot distinguish causes, because
 * the server does not tell it any. */
export type BrokerLoginResult =
  | BrokerLoginSuccess
  | { status: "failed" }
  | { status: "network" };

/**
 * ONE credential-bearing request, to ONE realm - the realm of the endpoint
 * the calling screen was built with. There is no realm field in the body and
 * no fallback to another endpoint on failure.
 */
export async function brokerLogin(input: {
  endpoint: string;
  username: string;
  password: string;
}): Promise<BrokerLoginResult> {
  let res: Response;
  try {
    res = await fetch(input.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
      }),
    });
  } catch {
    return { status: "network" };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const b = (body ?? {}) as {
    ok?: boolean;
    code?: unknown;
    targetOrigin?: unknown;
    realm?: unknown;
  };

  if (res.status !== 200) return { status: "failed" };
  if (
    b.ok !== true ||
    typeof b.code !== "string" ||
    typeof b.targetOrigin !== "string" ||
    typeof b.realm !== "string"
  ) {
    return { status: "failed" };
  }
  return { status: "ok", code: b.code, targetOrigin: b.targetOrigin, realm: b.realm };
}

export interface TxnInfo {
  realm: string;
  displayName: string;
  displayContext: string | null;
}

/** Same-origin read of the pending transaction's display copy. Never
 * consumes it, and returns no email, id, token or code. */
export async function readTxnInfo(): Promise<TxnInfo | null> {
  try {
    const res = await fetch("/api/auth/txn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.status !== 200) return null;
    const b = (await res.json()) as {
      ok?: boolean;
      realm?: unknown;
      displayName?: unknown;
      displayContext?: unknown;
    };
    if (
      b?.ok !== true ||
      typeof b.realm !== "string" ||
      typeof b.displayName !== "string"
    ) {
      return null;
    }
    return {
      realm: b.realm,
      displayName: b.displayName,
      displayContext: typeof b.displayContext === "string" ? b.displayContext : null,
    };
  } catch {
    return null;
  }
}

export type CompleteResult =
  | { status: "session"; redirect: string }
  | { status: "owner"; tokenHash: string; redirect: string }
  | { status: "cancelled" }
  | { status: "failed" };

/**
 * Leg 2. `action: "cancel"` consumes the transaction and mints nothing, so a
 * cancelled sign-in can never be resumed afterwards.
 */
export async function completeHandoff(
  action: "continue" | "cancel",
): Promise<CompleteResult> {
  let res: Response;
  try {
    res = await fetch("/api/auth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch {
    return { status: "failed" };
  }
  if (res.status !== 200) return { status: "failed" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: "failed" };
  }
  const b = body as {
    ok?: boolean;
    cancelled?: boolean;
    redirect?: unknown;
    tokenHash?: unknown;
  };
  if (b?.ok !== true) return { status: "failed" };
  if (b.cancelled === true) return { status: "cancelled" };
  if (typeof b.tokenHash === "string" && typeof b.redirect === "string") {
    return { status: "owner", tokenHash: b.tokenHash, redirect: b.redirect };
  }
  if (typeof b.redirect === "string") return { status: "session", redirect: b.redirect };
  return { status: "failed" };
}
