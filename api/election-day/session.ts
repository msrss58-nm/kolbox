import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes } from "node:crypto";

// Phase 3A trusted-session endpoint. Browser -> HttpOnly cookie -> this
// function -> hash credential in Node -> service_role-only RPC -> DB
// derives actor/workspace/role. This function is the ONLY place in the
// whole app allowed to hold the service_role key - it never reaches the
// browser bundle (unlike VITE_-prefixed vars, which Vite inlines into
// client JS at build time; this file intentionally reads non-VITE_ names).
//
// No @vercel/node dependency added, matching api/health.ts's existing
// minimal-duck-typed-request/response convention - Vercel's Node runtime
// provides `req.cookies`/`req.body` regardless of whether that package is
// installed; it only supplies types.

const SESSION_COOKIE_NAME = "__Host-kb_ed_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24h, matches election_day_login_v2's fixed absolute expiry
const DEFAULT_PRODUCTION_ORIGIN = "https://kolbox-gamma.vercel.app";
// Two independent thresholds per 15-minute window - same explicit,
// easily-revisable implementation-constant status as documented in
// election_day_register_login_attempt.sql's own comment; no external
// product requirement exists for either value. The DB function only
// counts and returns attempts - enforcing the threshold is deliberately
// this endpoint's job, not the DB's, so it can short-circuit before ever
// calling election_day_login_v2 (see that function's own comment for why
// the threshold check cannot live inside it).
//
// The username bucket stays tight (10) - it is the meaningful protection
// against a targeted credential-guessing attack on one specific account,
// and IS NOT weakened by the IP correction below.
//
// The IP bucket is raised to 100 - a single shared office/election-day
// network address can legitimately represent many different real users
// attempting many different real logins in the same 15-minute window
// (multiple coordinators/callers on the same NAT'd connection); 10 was
// too tight for that case and risked throttling legitimate concurrent
// staff, not just an attacker. IP is still never an identity/workspace
// authority anywhere in this file or in any RPC it calls - raising its
// threshold only changes when the secondary, coarser-grained IP signal
// kicks in, not what it is trusted to prove.
const MAX_USERNAME_ATTEMPTS_PER_WINDOW = 10;
const MAX_IP_ATTEMPTS_PER_WINDOW = 100;

interface MinimalRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  cookies?: Record<string, string>;
}

interface MinimalResponse {
  status: (code: number) => MinimalResponse;
  setHeader: (name: string, value: string | string[]) => MinimalResponse;
  json: (body: unknown) => void;
}

function getServiceClient() {
  const url = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) {
    throw new Error("SERVER_CONFIG_MISSING");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Postgres bytea literal format for a hex digest - the value election_day_
// resolve_session/login_v2/etc. expect for their bytea parameters.
function toPgBytea(hexDigest: string): string {
  return "\\x" + hexDigest;
}

// The `__Host-` cookie prefix itself requires Secure + no Domain + Path=/
// (enforced by the browser, not by this code) - production origin is a
// fixed known-public value (already documented throughout this project),
// never taken from the request. The localhost exception is gated on
// VERCEL_ENV so it is structurally impossible for it to apply to a real
// Production deployment, where Vercel always sets VERCEL_ENV=production.
function allowedOrigins(): Set<string> {
  const origins = new Set<string>([
    process.env.SESSION_ALLOWED_ORIGIN ?? DEFAULT_PRODUCTION_ORIGIN,
  ]);
  if (process.env.VERCEL_ENV !== "production") {
    origins.add("http://localhost:5173");
  }
  return origins;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// IP is accounting-only input to election_day_register_login_attempt's
// rate-limit bucket - never treated as an identity or workspace authority
// anywhere in this file or in any RPC it calls.
function clientIp(req: MinimalRequest): string | null {
  const raw = headerValue(req.headers["x-forwarded-for"]);
  if (!raw) return null;
  return raw.split(",")[0]?.trim() || null;
}

function sendError(res: MinimalResponse, status: number, code: string): void {
  // Generic, fixed error codes only - never a raw Postgres exception/stack,
  // never a message that distinguishes "unknown user" from "wrong password"
  // (both surface as the same UNAUTHORIZED from election_day_login_v2 itself).
  res.status(status).json({ error: code });
}

function clearSessionCookie(res: MinimalResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  );
}

// Only constructs the service client once a request has survived every
// check that doesn't need one (method, Origin, cookie presence, blank
// input) - so a malformed/forged/no-op request fails fast without ever
// touching Supabase, and never spuriously surfaces SERVER_CONFIG_MISSING
// for a request that didn't need the DB anyway.
function requireServiceClient(
  res: MinimalResponse,
): ReturnType<typeof getServiceClient> | null {
  try {
    return getServiceClient();
  } catch {
    sendError(res, 500, "SERVER_CONFIG_MISSING");
    return null;
  }
}

export default async function handler(
  req: MinimalRequest,
  res: MinimalResponse,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method !== "POST" && method !== "GET" && method !== "DELETE") {
    sendError(res, 405, "METHOD_NOT_ALLOWED");
    return;
  }

  if (method === "POST") {
    // Origin validated on every state-changing request. GET is deliberately
    // exempt below - browsers do not reliably send an Origin header on a
    // same-origin simple GET, so enforcing it there would break legitimate
    // same-origin session checks, not just reject forged cross-site ones.
    const origin = headerValue(req.headers.origin);
    if (!origin || !allowedOrigins().has(origin)) {
      sendError(res, 403, "FORBIDDEN_ORIGIN");
      return;
    }

    const body = (req.body ?? {}) as { name?: unknown; password?: unknown };
    const name = typeof body.name === "string" ? body.name : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!name || !password) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const supabase = requireServiceClient(res);
    if (!supabase) return;

    // Rate-limit registration is a SEPARATE call, made and enforced here,
    // BEFORE election_day_login_v2 is ever invoked - see that function's
    // own SQL comment for why a same-transaction increment inside it
    // cannot survive its own later UNAUTHORIZED on a failed attempt (found
    // by local runtime testing: 14 consecutive wrong-password attempts
    // against the original design never triggered a rate limit). Every
    // call counts, successful or not - a legitimate user logging in
    // repeatedly is expected to stay well under the threshold.
    const nameBucket = `name:${name.trim().toLowerCase()}`;
    const ip = clientIp(req);
    const [nameAttemptResult, ipAttemptResult] = await Promise.all([
      supabase.rpc("election_day_register_login_attempt", { p_bucket_key: nameBucket }),
      ip
        ? supabase.rpc("election_day_register_login_attempt", {
            p_bucket_key: `ip:${ip}`,
          })
        : Promise.resolve({ data: 0, error: null }),
    ]);

    if (nameAttemptResult.error || ipAttemptResult.error) {
      sendError(res, 500, "SERVER_ERROR");
      return;
    }

    const nameAttempts = (nameAttemptResult.data ?? 0) as number;
    const ipAttempts = (ipAttemptResult.data ?? 0) as number;
    if (
      nameAttempts > MAX_USERNAME_ATTEMPTS_PER_WINDOW ||
      ipAttempts > MAX_IP_ATTEMPTS_PER_WINDOW
    ) {
      sendError(res, 429, "RATE_LIMITED");
      return;
    }

    // Raw token generated here, in Node - never sent to Postgres. Only its
    // sha256 hash (as a bytea literal) is ever passed to election_day_login_v2.
    const rawToken = randomBytes(32).toString("hex");
    const tokenHashBytea = toPgBytea(sha256Hex(rawToken));

    const { data, error } = await supabase.rpc("election_day_login_v2", {
      p_name: name,
      p_password: password,
      p_session_hash: tokenHashBytea,
    });

    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      actor_id: string;
      actor_name: string;
      role_id: string;
      workspace_id: string;
    };

    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${rawToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
    // Raw token is returned to the browser ONLY via the HttpOnly cookie
    // above - it never appears in this JSON body, matching the hard
    // requirement that the raw token never appears in a response body/log.
    // `id` is a bare identifier, not a secret - included so the frontend
    // can source it from a server-verified response instead of trusting an
    // unverified client-held value (needed for the still-legacy reauth
    // path's actor_id parameter; does not by itself make that legacy path
    // server-trusted - see CURRENT_STATUS.md).
    res.status(200).json({
      id: row.actor_id,
      name: row.actor_name,
      roleId: row.role_id,
      workspaceId: row.workspace_id,
    });
    return;
  }

  if (method === "GET") {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const supabase = requireServiceClient(res);
    if (!supabase) return;

    const { data, error } = await supabase.rpc("election_day_resolve_session", {
      p_session_hash: toPgBytea(sha256Hex(rawToken)),
    });

    if (error || !data || (Array.isArray(data) && data.length === 0)) {
      sendError(res, 401, "UNAUTHORIZED");
      return;
    }

    const row = (Array.isArray(data) ? data[0] : data) as {
      actor_id: string;
      actor_name: string;
      role_id: string;
      workspace_id: string;
    };

    res.status(200).json({
      id: row.actor_id,
      name: row.actor_name,
      roleId: row.role_id,
      workspaceId: row.workspace_id,
    });
    return;
  }

  if (method === "DELETE") {
    const origin = headerValue(req.headers.origin);
    if (!origin || !allowedOrigins().has(origin)) {
      sendError(res, 403, "FORBIDDEN_ORIGIN");
      return;
    }

    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (rawToken) {
      // A DB call is only ever made when there's actually a cookie to
      // resolve/invalidate - a logout with no cookie is a pure no-op and
      // never needs a service client at all.
      const supabase = requireServiceClient(res);
      if (!supabase) return;

      // Idempotent RPC - a missing/unknown hash is a silent no-op, so
      // logout never fails client-side regardless of prior session state.
      await supabase.rpc("election_day_logout_v2", {
        p_session_hash: toPgBytea(sha256Hex(rawToken)),
      });
    }

    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }
}
