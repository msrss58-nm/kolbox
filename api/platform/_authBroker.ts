/**
 * KOLBOX Auth origin - the broker and the two-leg cross-origin handoff.
 *
 * Reached through the `auth_op` partition at the very top of
 * api/platform/session.ts, before any Platform Owner code runs - the same
 * structural trick `me_op` already uses, so the two verifiers never share a
 * decision. Lives in an underscore-prefixed module so it is NOT a Vercel
 * Function: the project stays at exactly 12/12 Hobby Functions.
 *
 * FIVE OPS, each gated to the deployment that may answer it (see _surfaceGate).
 * The two login ops are the two login screens; the other three are the
 * handoff, and are identical for every principal:
 *   login | login_platform_owner
 *             auth deployment only    authenticate once, resolve realm, issue
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

type Realm = "worker" | "election_owner" | "platform_owner" | "multi_entity_owner";

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
  /** `string[]` is what Node's own ServerResponse.setHeader accepts, and it
   * is how a response emits TWO `Set-Cookie` headers - which a sign-in that
   * must also END the previous principal's session genuinely needs. Matches
   * api/election-day/session.ts's MinimalResponse, which already declares it. */
  setHeader: (name: string, value: string | string[]) => unknown;
}

const PARTITION_KEY = "auth_op";

/**
 * TWO LOGIN OPS - one per login screen, and there are exactly two screens.
 *
 * `login_platform_owner` keeps its own dedicated op and screen. `login` is
 * the SHARED screen every other principal uses: the caller states no realm at
 * all, and the server resolves it from the directory after the fact.
 *
 * What this removes, and what it does NOT: the user no longer states a realm,
 * a workspace or a system code - nothing about WHO they are is taken from the
 * request. What still never happens is guessing: the directory answers with
 * at most one principal (see `resolveIdentity`), and only then is a single
 * credential-bearing call made, to that principal's own store.
 */
const LOGIN_OPS: Record<string, Realm | "shared"> = {
  login: "shared",
  login_platform_owner: "platform_owner",
};

/** The realms the shared screen may resolve, in a fixed order. The Platform
 * Owner is deliberately absent - it has its own screen, so its username never
 * competes with anyone else's and its credential is never posted here. */
const SHARED_REALMS: readonly Realm[] = ["worker", "election_owner", "multi_entity_owner"];

const AUTH_OPS = new Set<string>([
  ...Object.keys(LOGIN_OPS),
  "continue",
  "txn",
  "complete",
]);

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

interface IdentityRow {
  auth_user_id: string | null;
  actor_id: string | null;
}

/**
 * Turns a username into AT MOST ONE principal.
 *
 * For the dedicated Platform Owner op this is the single lookup it always
 * was. For the shared screen it asks each shared realm in turn - these are
 * DIRECTORY reads that verify no credential, so asking three costs nothing a
 * caller could exploit and cannot lock anyone out.
 *
 * A username held in two shared realms is AMBIGUOUS and is refused outright.
 * The alternatives are both wrong: picking a realm by precedence would let
 * whoever registered first decide whose password is checked, and trying each
 * realm's password in turn would make one submit into several credential
 * attempts. Refusing is the only answer that keeps "exactly one
 * credential-bearing call per submit" true. The refusal is indistinguishable
 * from "no such user", so this is never an enumeration oracle either.
 */
async function resolveIdentity(
  supabase: ReturnType<typeof getServiceClient>,
  requestedRealm: Realm | "shared",
  username: string,
): Promise<{ realm: Realm; idRow: IdentityRow } | null | "error"> {
  const realms = requestedRealm === "shared" ? SHARED_REALMS : [requestedRealm];
  const matches: { realm: Realm; idRow: IdentityRow }[] = [];
  for (const realm of realms) {
    const { data, error } = await supabase.rpc("auth_identity_resolve", {
      p_realm: realm,
      p_username: username,
    });
    if (error) return "error";
    const idRow = (Array.isArray(data) ? data[0] : data) as IdentityRow | undefined;
    if (idRow) matches.push({ realm, idRow });
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Authenticates against exactly one realm's own credential store. Exactly one
 * credential-bearing call per submit; a failure is never retried against
 * another realm, because by this point the directory has already named a
 * single principal.
 */
async function handleLogin(
  req: BrokerRequest,
  res: BrokerResponse,
  requestedRealm: Realm | "shared",
): Promise<void> {
  const startedAt = Date.now();

  if (req.method !== "POST") return deny(res, 405);

  // Same-origin only: the entry form lives on this very origin.
  const origin = headerValue(req.headers.origin);
  const auth = authOrigin();
  if (!origin || !auth || !constantTimeEquals(origin, auth)) return deny(res, 403);

  const body = bodyOf(req);
  // Username and password only. No workspace code, no e-mail identifier and
  // no realm field - on EITHER screen. The shared screen resolves the realm
  // server-side from the directory; a realm sent in the body would be
  // rejected here as an unexpected key before it could reach anything.
  if (!keysAllowed(body, ["username", "password"])) {
    return deny(res, 400);
  }
  const username = str(body.username).trim();
  const password = str(body.password);
  if (username === "" || password === "") {
    await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
    return deny(res, 401);
  }

  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient();
  } catch {
    return deny(res, 500);
  }

  // Rate limit BEFORE any credential work - and before the directory is even
  // consulted, so the limit cannot be probed for whether a username exists.
  // The bucket is scoped to the SCREEN (shared vs platform owner) rather than
  // to a resolved realm, which is what stops the two screens' attempts from
  // being counted as one bucket while still giving each identifier its own.
  const idBucket = `auth:${requestedRealm}:${sha256Hex(username.toLowerCase())}`;
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

  // THE REALM IS DECIDED HERE, SERVER-SIDE, AND NOWHERE ELSE. An unknown
  // username, one that is ambiguous across the shared realms, and one that
  // belongs to the Platform Owner but was typed on the shared screen all
  // resolve to nothing - each answering exactly like a wrong password.
  const resolved = await resolveIdentity(supabase, requestedRealm, username);
  if (resolved === "error") return deny(res, 500);
  if (!resolved) {
    await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
    return deny(res, 401);
  }
  const { realm, idRow } = resolved;

  let authUserId: string | null = null;
  let actorId: string | null = null;
  let workspaceId: string | null = null;
  let displayName = "";
  let displayContext: string | null = null;

  if (realm === "worker") {
    if (!idRow.actor_id) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    // The workspace is derived inside this RPC from the actor's own row -
    // never from the directory and never from anything the client sent. That
    // is what keeps tenant isolation intact now the system code is gone.
    const { data, error } = await supabase.rpc(
      "election_day_verify_credentials_by_actor_v1",
      { p_actor_id: idRow.actor_id, p_password: password },
    );
    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    const row = (Array.isArray(data) ? data[0] : data) as {
      actor_name: string;
      workspace_id: string;
      workspace_name: string;
    };
    actorId = idRow.actor_id;
    workspaceId = row.workspace_id;
    displayName = row.actor_name;
    displayContext = row.workspace_name;
  } else {
    // OWNER REALMS. The e-mail is fetched server-side from the Auth account
    // the directory named; it is never typed, never returned, and never a
    // credential the user supplies.
    if (!idRow.auth_user_id) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
      idRow.auth_user_id,
    );
    if (userError || !userData?.user?.email) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    const email = userData.user.email;

    let anonClient: ReturnType<typeof getAnonAuthClient>;
    try {
      anonClient = getAnonAuthClient();
    } catch {
      return deny(res, 500);
    }
    const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword(
      { email, password },
    );
    if (signInError || !signIn?.user || signIn.user.id !== idRow.auth_user_id) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }
    // LOCAL scope: all owner realms share auth.users, so a global sign-out
    // here would revoke the principal's real sessions on their own origin.
    await anonClient.auth.signOut({ scope: "local" });

    // The directory said which realm this is; the realm's own resolver must
    // agree before anything is issued. Defence in depth: a stale directory
    // row can never by itself admit someone to a console.
    const resolverFor: Record<string, string> = {
      platform_owner: "platform_resolve_owner_context",
      election_owner: "election_day_resolve_owner_context",
      multi_entity_owner: "multi_entity_resolve_owner_context",
    };
    const { data: ctx, error: ctxError } = await supabase.rpc(resolverFor[realm], {
      p_auth_user_id: idRow.auth_user_id,
    });
    let confirmed = !ctxError && !!ctx && (!Array.isArray(ctx) || ctx.length > 0);
    // An approved-but-unprovisioned Election Owner has no election_owners row
    // yet. They must still be able to sign in - that first sign-in is how they
    // reach the setup screen and create their workspace.
    if (!confirmed && realm === "election_owner") {
      const { data: pending, error: pendingError } = await supabase.rpc(
        "election_day_resolve_owner_provisioning_state",
        { p_auth_user_id: idRow.auth_user_id },
      );
      confirmed =
        !pendingError && !!pending && (!Array.isArray(pending) || pending.length > 0);
    }
    if (!confirmed) {
      await sleepUntil(startedAt, MIN_LOGIN_RESPONSE_MS);
      return deny(res, 401);
    }

    authUserId = idRow.auth_user_id;
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
  // The Election Owner lands in the SAME full shell a worker does. That route
  // resolves to the module dashboard when the workspace is entitled to
  // Election Day, and to the Owner's administration sections otherwise - so
  // there is one landing destination, not a separate Owner one.
  if (realm === "election_owner") return "/election-day";
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
  // Attributes other than Max-Age must match the cookie as it was SET, or the
  // browser treats this as a different cookie and the original survives.
  const clearSession = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

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
  // THE PREVIOUS PRINCIPAL ENDS HERE.
  //
  // Both credentials live on THIS origin and are entirely independent: the
  // worker's `__Host-kb_ed_session` cookie and the Owner's Supabase session
  // in the page's own isolated storage. A browser that signed in as a worker
  // earlier still carried a valid worker cookie into an Owner sign-in, and
  // the application resolved that cookie first - so the Owner was shown, and
  // acted as, the worker. Authenticating as one principal must therefore
  // TERMINATE the other, not merely sit alongside it.
  //
  // Revoke before clearing, so the token dies rather than merely becoming
  // unreachable from this browser. `election_day_logout_v2` is the same
  // idempotent, service_role-only revocation the logout endpoint calls; an
  // unknown hash is a silent no-op. A revocation FAILURE does not fail the
  // sign-in: the cookie is cleared unconditionally below, which is what
  // decides who this browser can present, and leaving the Owner stranded on
  // a transient database error would be the worse outcome.
  //
  // ONLY ON SUCCESS. The failure paths above deliberately leave an existing
  // worker session alone: nothing was established, so no identity confusion
  // can arise - and tearing one down on every failed Owner attempt would let
  // anyone reaching leg 2 sign a working worker out.
  const staleSession = req.cookies?.[SESSION_COOKIE];
  if (staleSession) {
    await supabase.rpc("election_day_logout_v2", {
      p_session_hash: toPgBytea(sha256Hex(staleSession)),
    });
  }
  noStore(res);
  // Unconditional, so "an Owner sign-in ends with no worker cookie" holds
  // even if the cookie could not be read back to be revoked.
  res.setHeader("Set-Cookie", [clearTxn, clearSession]);
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

  // Both login ops live on the AUTH deployment only. 404, not 403: a
  // wrong-surface caller learns nothing about whether the op exists here.
  const loginRealm = LOGIN_OPS[op];
  if (loginRealm) {
    if (!isAuthDeployment(host)) return deny(res, 404);
    return handleLogin(req, res, loginRealm);
  }

  const realms = targetDeploymentRealms(host);
  const self = (process.env.KOLBOX_SELF_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!realms || self === "") return deny(res, 404);

  if (op === "continue") return handleContinue(req, res, realms, self);
  if (op === "txn") return handleTxn(req, res, realms, self);
  return handleComplete(req, res, realms, self);
}
