/**
 * KOLBOX Auth origin - the broker and the two-leg cross-origin handoff.
 *
 * Reached through the `auth_op` partition at the very top of
 * api/platform/session.ts, before any Platform Owner code runs - the same
 * structural trick `me_op` already uses, so the two verifiers never share a
 * decision. Lives in an underscore-prefixed module so it is NOT a Vercel
 * Function: the project stays at exactly 12/12 Hobby Functions.
 *
 * FOUR OPS, each gated to the deployment that may answer it (see _surfaceGate):
 *   login     auth deployment only    authenticate once, resolve realm, issue
 *                                     a one-time handoff code. Mints nothing.
 *   continue  target deployments only LEG 1: consume the code, write THIS
 *                                     origin's own HttpOnly txn cookie, 303.
 *   txn       target deployments only read the confirmation copy (no consume)
 *   complete  target deployments only LEG 2: match the cookie, then mint -
 *                                     or, on cancel, consume and mint nothing.
 *
 * The session is gated on BOTH a valid one-time Postgres handoff AND a
 * matching target-origin cookie the auth origin can never manufacture. That
 * is what defeats login CSRF / session swapping - an attacker planting their
 * OWN valid code - which TTL, single-use and origin binding do not address.
 *
 * NEVER LOGGED: the raw handoff code and the raw transaction value are hashed
 * on first use and only digests exist afterwards. They travel in a POST body
 * and a cookie respectively - never in a URL, so they cannot reach access
 * logs, `Referer`, history or a bookmark.
 */
import { createHash, randomBytes } from "node:crypto";
import { getAnonAuthClient, getServiceClient } from "../election-day/_ownerAuth.js";
import {
  authOrigin,
  constantTimeEquals,
  isAuthDeployment,
  targetDeploymentRealms,
} from "../_surfaceGate.js";

export interface BrokerRequest {
  method?: string;
  url?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}

export interface BrokerResponse {
  status: (code: number) => BrokerResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => unknown;
}

const PARTITION_KEY = "auth_op";
const AUTH_OPS = new Set<string>(["login", "continue", "txn", "complete"]);

/** 90 s for the code (architecture invariant); 120 s for the RP transaction,
 * which must survive a redirect plus a human reading the confirmation. */
const CODE_TTL_SECONDS = 90;
const TXN_TTL_SECONDS = 120;

const TXN_COOKIE = "__Host-kb_auth_txn";
const SESSION_COOKIE = "__Host-kb_ed_session";
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

const MAX_IDENTIFIER_ATTEMPTS_PER_WINDOW = 10;
const MAX_IP_ATTEMPTS_PER_WINDOW = 30;

/** Every failure answers with exactly this. One shape, one status, for
 * unknown identifier, wrong password, wrong workspace code, a valid Supabase
 * account that is not an owner, an expired approval, a consumed code and a
 * wrong-browser transaction alike. */
const GENERIC_FAILURE = { ok: false as const };

/** A fixed floor on the response time of credential-bearing ops, to blunt the
 * timing difference between "bcrypt actually ran" and "no such user". Best
 * effort, not a proof - recorded as such in the architecture. */
const MIN_LOGIN_RESPONSE_MS = 400;

function queryOf(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const idx = url.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : url.slice(idx + 1));
}

/** Presence of the key alone decides. A malformed value still belongs to THIS
 * handler and is rejected here - it never falls through to the Platform path. */
export function isAuthBrokerRequest(url: string | undefined): boolean {
  return queryOf(url).has(PARTITION_KEY);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toPgBytea(hex: string): string {
  return `\\x${hex}`;
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function noStore(res: BrokerResponse): void {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
}

/** No CORS headers are ever emitted by these ops - a cross-origin form POST
 * is a CORS *simple request* and triggers no preflight, so the Origin check
 * below is the control. Emitting any ACAO would only make the response
 * readable cross-origin. */
function deny(res: BrokerResponse, status: number): void {
  noStore(res);
  res.status(status).json(status === 404 ? { error: "NOT_FOUND" } : GENERIC_FAILURE);
}

function clientIp(req: BrokerRequest): string | null {
  const fwd = headerValue(req.headers["x-forwarded-for"]);
  if (!fwd) return null;
  const first = fwd.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** `a@b.com` -> `a***@b.com`. Never returns more than the first character of
 * the local part, and is applied BEFORE the value is stored, so no raw email
 * is ever written to the handoff row. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function bodyOf(req: BrokerRequest): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === "object" && !Array.isArray(b))
    return b as Record<string, unknown>;
  if (typeof b === "string") {
    try {
      const parsed: unknown = JSON.parse(b);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A cross-origin form POST arrives urlencoded, not JSON.
      const params = new URLSearchParams(b);
      const out: Record<string, unknown> = {};
      for (const [k, v] of params) out[k] = v;
      return out;
    }
  }
  return {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Rejects any body carrying a key outside the allow-list, so a crafted extra
 * field can never reach a downstream call. */
function keysAllowed(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

async function sleepUntil(startedAt: number, floorMs: number): Promise<void> {
  const remaining = floorMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

// ---------------------------------------------------------------------------
// login - AUTH DEPLOYMENT ONLY
// ---------------------------------------------------------------------------

type Realm = "worker" | "election_owner" | "platform_owner" | "multi_entity_owner";

const REALM_TARGET_ENV: Record<Exclude<Realm, "worker">, string> = {
  election_owner: "KOLBOX_ELECTION_ORIGIN",
  platform_owner: "KOLBOX_PLATFORM_ORIGIN",
  multi_entity_owner: "KOLBOX_MULTI_ENTITY_ORIGIN",
};

function targetOriginFor(realm: Realm): string | null {
  const key = realm === "worker" ? "KOLBOX_ELECTION_ORIGIN" : REALM_TARGET_ENV[realm];
  const raw = (process.env[key] ?? "").trim();
  return raw === "" ? null : raw.replace(/\/+$/, "");
}

async function handleLogin(req: BrokerRequest, res: BrokerResponse): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== "POST") return deny(res, 405);

  // Same-origin only: the entry form lives on this very origin.
  const origin = headerValue(req.headers.origin);
  const auth = authOrigin();
  if (!origin || !auth || !constantTimeEquals(origin, auth)) return deny(res, 403);

  const body = bodyOf(req);
  if (!keysAllowed(body, ["identifier", "password", "workspaceCode"])) {
    return deny(res, 400);
  }
  const identifier = str(body.identifier).trim();
  const password = str(body.password);
  const workspaceCode = str(body.workspaceCode).trim();
  if (identifier === "" || password === "") {
    await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
    return deny(res, 401);
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny(res, 500);
  }

  // Rate limit BEFORE any credential work, reusing the existing buckets.
  const idBucket = `auth:id:${sha256Hex(identifier.toLowerCase())}`;
  const ip = clientIp(req);
  const [idAttempts, ipAttempts] = await Promise.all([
    supabase.rpc("election_day_register_login_attempt", { p_bucket_key: idBucket }),
    ip
      ? supabase.rpc("election_day_register_login_attempt", {
          p_bucket_key: `auth:ip:${ip}`,
        })
      : Promise.resolve({ data: 0, error: null }),
  ]);
  if (idAttempts.error || ipAttempts.error) return deny(res, 500);
  if (
    ((idAttempts.data ?? 0) as number) > MAX_IDENTIFIER_ATTEMPTS_PER_WINDOW ||
    ((ipAttempts.data ?? 0) as number) > MAX_IP_ATTEMPTS_PER_WINDOW
  ) {
    await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
    return deny(res, 429);
  }

  let realm: Realm | null = null;
  let authUserId: string | null = null;
  let actorId: string | null = null;
  let workspaceId: string | null = null;
  let displayName = "";
  let displayContext: string | null = null;

  if (workspaceCode !== "") {
    // WORKER REALM. Chosen by the presence of a workspace code - an input that
    // exists in exactly one realm. Exactly ONE credential-bearing call; a
    // failure is never retried against another realm.
    const { data, error } = await supabase.rpc("election_day_verify_credentials_v1", {
      p_workspace_code: workspaceCode,
      p_name: identifier,
      p_password: password,
    });
    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      actor_id: string;
      actor_name: string;
      workspace_id: string;
      workspace_name: string;
    };
    realm = "worker";
    actorId = row.actor_id;
    workspaceId = row.workspace_id;
    displayName = row.actor_name;
    displayContext = row.workspace_name;
  } else {
    // OWNER CLASS. ONE authentication against the shared auth.users - never
    // three speculative attempts. The realm is then a POST-AUTHENTICATION
    // lookup using no password at all.
    let anonClient: ReturnType<typeof getAnonAuthClient>;
    try {
      anonClient = getAnonAuthClient();
    } catch {
      return deny(res, 500);
    }
    const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword(
      {
        email: identifier,
        password,
      },
    );
    if (signInError || !signIn?.user) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    const userId = signIn.user.id;
    const email = signIn.user.email ?? identifier;
    // The broker holds no session: this isolated client is signed out
    // immediately, LOCALLY, so it can never revoke the principal's real
    // sessions on their own origin (all owner realms share auth.users).
    await anonClient.auth.signOut({ scope: "local" });

    // Fixed order. Each resolver answers only "mine / not mine" and never
    // names a realm, which is what makes try-in-order safe rather than an
    // oracle. None of these takes a password.
    const probes: { realm: Realm; fn: string }[] = [
      { realm: "platform_owner", fn: "platform_resolve_owner_context" },
      { realm: "election_owner", fn: "election_day_resolve_owner_context" },
      { realm: "multi_entity_owner", fn: "multi_entity_resolve_owner_context" },
    ];
    for (const probe of probes) {
      const { data, error } = await supabase.rpc(probe.fn, { p_auth_user_id: userId });
      if (!error && data && (!Array.isArray(data) || data.length > 0)) {
        realm = probe.realm;
        break;
      }
    }
    if (realm === null) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    authUserId = userId;
    // Masked BEFORE storage, so no raw email is ever written to the row.
    displayName = maskEmail(email);
  }

  const target = targetOriginFor(realm);
  if (!target) return deny(res, 500);

  const rawCode = randomBytes(32).toString("hex");
  const { error: issueError } = await supabase.rpc("auth_handoff_issue", {
    p_code_hash: toPgBytea(sha256Hex(rawCode)),
    p_realm: realm,
    p_target_origin: target,
    p_auth_user_id: authUserId,
    p_actor_id: actorId,
    p_workspace_id: workspaceId,
    p_display_name: displayName,
    p_display_context: displayContext,
    p_ttl_seconds: CODE_TTL_SECONDS,
  });
  if (issueError) {
    await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
    return deny(res, 500);
  }

  await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
  noStore(res);
  // The code is returned to the SAME-ORIGIN caller only, held in memory by
  // the page, and submitted as a form field. It is never placed in a URL,
  // localStorage, sessionStorage or a cookie.
  res.status(200).json({ ok: true, code: rawCode, targetOrigin: target, realm });
}

// ---------------------------------------------------------------------------
// continue - LEG 1, TARGET DEPLOYMENTS ONLY
// ---------------------------------------------------------------------------

async function handleContinue(
  req: BrokerRequest,
  res: BrokerResponse,
  realms: readonly string[],
  self: string,
): Promise<void> {
  if (req.method !== "POST") return deny(res, 405);

  // The ONE deliberate cross-origin allowance in the system, scoped to this
  // op: the form_post arrives from the auth origin.
  const origin = headerValue(req.headers.origin);
  const auth = authOrigin();
  if (!origin || !auth || !constantTimeEquals(origin, auth)) return deny(res, 403);

  // Forbidden headers - script cannot set these. Absent ⇒ legacy client,
  // treated exactly like a missing Origin (rejected; the direct per-origin
  // login routes remain the documented fallback).
  const fetchSite = headerValue(req.headers["sec-fetch-site"]);
  const fetchMode = headerValue(req.headers["sec-fetch-mode"]);
  if (fetchSite !== "cross-site" || fetchMode !== "navigate") return deny(res, 403);

  const body = bodyOf(req);
  if (!keysAllowed(body, ["code"])) return deny(res, 400);
  const code = str(body.code);
  if (code === "") return deny(res, 401);

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny(res, 500);
  }

  // The target origin's OWN transaction value. Generated here, on the target
  // origin - the auth origin can never manufacture it.
  const rawTxn = randomBytes(32).toString("hex");
  const { error } = await supabase.rpc("auth_handoff_consume", {
    p_code_hash: toPgBytea(sha256Hex(code)),
    p_txn_hash: toPgBytea(sha256Hex(rawTxn)),
    p_txn_ttl_seconds: TXN_TTL_SECONDS,
    p_expected_realm: realms,
    p_expected_origin: self,
  });
  if (error) return deny(res, 401);

  noStore(res);
  // SameSite=Lax, deliberately: the 303's follow-up GET is still attributed
  // to the cross-site initiator, so a Strict cookie would not ride it and the
  // flow would dead-end. The relaxation costs nothing because LEG 2 IS A
  // POST, and Lax cookies are not sent on cross-site POSTs - so the only
  // request that can actually complete a sign-in still needs same-site
  // context. HttpOnly: no script on any origin can read or write it.
  res.setHeader(
    "Set-Cookie",
    `${TXN_COOKIE}=${rawTxn}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TXN_TTL_SECONDS}`,
  );
  // 303 to a BARE path: no secret in the redirect target, no history entry
  // carrying one, and a reload cannot replay (the code is already consumed).
  res.setHeader("Location", "/auth/complete");
  res.status(303).json({ ok: true });
}

// ---------------------------------------------------------------------------
// txn - the confirmation copy. Reads, never consumes.
// ---------------------------------------------------------------------------

async function handleTxn(
  req: BrokerRequest,
  res: BrokerResponse,
  realms: readonly string[],
  self: string,
): Promise<void> {
  if (req.method !== "POST") return deny(res, 405);
  const origin = headerValue(req.headers.origin);
  if (!origin || !constantTimeEquals(origin, self)) return deny(res, 403);

  const rawTxn = req.cookies?.[TXN_COOKIE];
  if (!rawTxn) return deny(res, 401);

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny(res, 500);
  }

  const { data, error } = await supabase.rpc("auth_handoff_txn_info", {
    p_txn_hash: toPgBytea(sha256Hex(rawTxn)),
    p_expected_realm: realms,
    p_expected_origin: self,
  });
  if (error || !data || (Array.isArray(data) && data.length === 0)) return deny(res, 401);
  const row = (Array.isArray(data) ? data[0] : data) as {
    realm: string;
    display_name: string;
    display_context: string | null;
  };

  noStore(res);
  // Pre-masked display copy only - no email, no id, no token, no code.
  res.status(200).json({
    ok: true,
    realm: row.realm,
    displayName: row.display_name,
    displayContext: row.display_context,
  });
}

// ---------------------------------------------------------------------------
// complete - LEG 2 (and cancel). The ONLY path that mints a session.
// ---------------------------------------------------------------------------

function landingFor(realm: string): string {
  if (realm === "worker") return "/election-day";
  if (realm === "election_owner") return "/election-day/owner";
  if (realm === "platform_owner") return "/platform";
  return "/multi-entity";
}

async function handleComplete(
  req: BrokerRequest,
  res: BrokerResponse,
  realms: readonly string[],
  self: string,
): Promise<void> {
  if (req.method !== "POST") return deny(res, 405);
  // Same-origin only. A Lax cookie is not sent on a cross-site POST anyway;
  // this makes the refusal explicit rather than incidental.
  const origin = headerValue(req.headers.origin);
  if (!origin || !constantTimeEquals(origin, self)) return deny(res, 403);

  const body = bodyOf(req);
  if (!keysAllowed(body, ["action"])) return deny(res, 400);
  const action = str(body.action) === "cancel" ? "cancel" : "continue";

  const rawTxn = req.cookies?.[TXN_COOKIE];
  if (!rawTxn) return deny(res, 401);

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny(res, 500);
  }

  // Consumes the transaction in BOTH branches. Cancel therefore terminates
  // the pending transaction permanently - it can never be resumed later.
  const { data, error } = await supabase.rpc("auth_handoff_complete", {
    p_txn_hash: toPgBytea(sha256Hex(rawTxn)),
    p_expected_realm: realms,
    p_expected_origin: self,
  });

  const clearTxn = `${TXN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

  if (error || !data || (Array.isArray(data) && data.length === 0)) {
    noStore(res);
    res.setHeader("Set-Cookie", clearTxn);
    res.status(401).json(GENERIC_FAILURE);
    return;
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    realm: string;
    auth_user_id: string | null;
    actor_id: string | null;
  };

  if (action === "cancel") {
    noStore(res);
    res.setHeader("Set-Cookie", clearTxn);
    res.status(200).json({ ok: true, cancelled: true });
    return;
  }

  if (row.realm === "worker") {
    if (!row.actor_id) return deny(res, 401);
    // Raw token generated HERE, in Node, on the origin that will use it -
    // never received from the auth origin, so session fixation is structurally
    // impossible. Only its sha256 reaches Postgres.
    const rawSession = randomBytes(32).toString("hex");
    const { data: sessionData, error: sessionError } = await supabase.rpc(
      "election_day_create_session_for_actor",
      { p_actor_id: row.actor_id, p_session_hash: toPgBytea(sha256Hex(rawSession)) },
    );
    if (sessionError || !sessionData) {
      noStore(res);
      res.setHeader("Set-Cookie", clearTxn);
      res.status(401).json(GENERIC_FAILURE);
      return;
    }
    let modules: string[] | undefined;
    try {
      const m = await supabase.rpc("workspace_session_modules", {
        p_session_hash: toPgBytea(sha256Hex(rawSession)),
      });
      modules =
        !m.error && Array.isArray(m.data)
          ? (m.data as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
    } catch {
      modules = undefined;
    }
    const budgetOnly =
      modules !== undefined &&
      !modules.includes("election_day") &&
      modules.includes("budget");
    noStore(res);
    // ONE Set-Cookie per response, so this stays within the shared
    // MinimalResponse contract. The txn cookie is deliberately NOT cleared
    // here: it is already provably inert (its row carries txn_consumed_at, so
    // auth_handoff_complete refuses it) and it self-expires within 120 s.
    // Every path that does NOT set a session cookie clears it explicitly.
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${rawSession}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
    // The raw session token leaves ONLY as the HttpOnly cookie above - never
    // in this body.
    res
      .status(200)
      .json({ ok: true, redirect: budgetOnly ? "/budget" : "/election-day" });
    return;
  }

  // OWNER REALMS. A Supabase one-time token is minted here and handed to this
  // origin's own page, which calls verifyOtp() on its ISOLATED client. That
  // produces an aal1 session in THIS origin's storage, after which the
  // existing guard runs the existing MFA flow completely unchanged.
  if (!row.auth_user_id) return deny(res, 401);
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
    row.auth_user_id,
  );
  if (userError || !userData?.user?.email) {
    noStore(res);
    res.setHeader("Set-Cookie", clearTxn);
    res.status(401).json(GENERIC_FAILURE);
    return;
  }
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  // Only the hashed_token property is read. The `action_link` / `email_otp`
  // URL form is deliberately NOT used - it embeds a token in a query string,
  // which is exactly what this design forbids. No link is constructed,
  // rendered, redirected to or logged.
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    noStore(res);
    res.setHeader("Set-Cookie", clearTxn);
    res.status(401).json(GENERIC_FAILURE);
    return;
  }
  noStore(res);
  res.setHeader("Set-Cookie", clearTxn);
  res.status(200).json({ ok: true, tokenHash, redirect: landingFor(row.realm) });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function handleAuthBrokerRequest(
  req: BrokerRequest,
  res: BrokerResponse,
): Promise<void> {
  const query = queryOf(req.url);
  const ops = query.getAll(PARTITION_KEY);
  // Ambiguity is refused outright, and `op` may never be mixed in - the
  // Platform Owner verifier must never share a decision with this one.
  if (
    ops.length !== 1 ||
    query.has("op") ||
    query.has("me_op") ||
    !AUTH_OPS.has(ops[0])
  ) {
    return deny(res, 400);
  }
  const op = ops[0];
  const host = req.headers.host;

  if (op === "login") {
    // 404, not 403: a wrong-surface caller learns nothing about whether the
    // op exists here.
    if (!isAuthDeployment(host)) return deny(res, 404);
    return handleLogin(req, res);
  }

  const realms = targetDeploymentRealms(host);
  const self = (process.env.KOLBOX_SELF_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!realms || self === "") return deny(res, 404);

  if (op === "continue") return handleContinue(req, res, realms, self);
  if (op === "txn") return handleTxn(req, res, realms, self);
  return handleComplete(req, res, realms, self);
}
