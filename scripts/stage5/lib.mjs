// Platform Stage 5 - shared helpers for the Stage 5 test suites.
//
// SAFETY: every suite talks ONLY to the isolated scratch stack built by
// scripts/stage5/mkScratchStack.mjs (project_id kolboxs5, API 127.0.0.1:54721).
// `loadStack()` refuses any other API URL, and `installLocalnetGuard()` makes
// every outbound fetch to a non-local host THROW - so even a mis-set variable
// can never reach Production. Secrets (local demo keys, passwords, TOTP
// secrets, tokens, one-time links) are consumed in memory only and never
// printed; `check()` details must never include them.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// S5_PORT_OFFSET: same opt-in shift as mkScratchStack.mjs (default 0 -> 54721).
const PORT_OFFSET = Number(process.env.S5_PORT_OFFSET ?? 0) || 0;
export const SCRATCH_API_URL = `http://127.0.0.1:${54721 + PORT_OFFSET}`;
export const SCRATCH_DB_CONTAINER = "supabase_db_kolboxs5";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function stackDir() {
  const dir = process.env.S5_STACK_DIR;
  if (!dir) throw new Error("S5_STACK_DIR must point at the mkScratchStack.mjs output dir");
  return path.resolve(dir);
}

/** Reads `supabase status -o env` output saved as <stack>/.stackenv (written by
 * the runner, never printed) and maps it onto the env the handlers read. */
export function loadStack() {
  const raw = fs.readFileSync(path.join(stackDir(), ".stackenv"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1).replace(/^"|"$/g, "");
  }
  if (env.API_URL !== SCRATCH_API_URL) {
    throw new Error(`REFUSING: stack API_URL is not the isolated scratch stack (${SCRATCH_API_URL})`);
  }
  process.env.VITE_SUPABASE_URL = env.API_URL;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = env.ANON_KEY;
  process.env.SUPABASE_SECRET_KEY = env.SERVICE_ROLE_KEY;
  delete process.env.VERCEL_ENV;
  delete process.env.KOLBOX_MULTI_ENTITY_APP_BASE_URL;
  return env;
}

export function installLocalnetGuard() {
  const orig = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`LOCALNET-GUARD: blocked request to non-local host "${url.host}"`);
    }
    return orig(input, init);
  };
}

export function admin() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function anon() {
  return createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** psql as postgres inside the SCRATCH container only. Returns trimmed stdout
 * (-At: unaligned, tuples only). For fixtures and state assertions. */
export function psql(sql) {
  return execFileSync(
    "docker",
    ["exec", "-i", SCRATCH_DB_CONTAINER, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"],
    { input: sql, encoding: "utf8" },
  ).trim();
}

// ---- TOTP (RFC 6238, SHA1, 6 digits, 30 s) --------------------------------
function b32decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = A.indexOf(ch);
    if (idx < 0) throw new Error("bad base32 char");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret, forTime = Date.now()) {
  const key = b32decode(secret);
  const counter = Math.floor(forTime / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin =
    ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, "0");
}

export function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

export function jwtHeader(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  } catch {
    return {};
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomPassword() {
  return `S5-Pw-${crypto.randomBytes(9).toString("base64url")}aA1!`;
}

/** Sign in with a fresh, non-persisting client. */
export async function signIn(email, password) {
  const client = anon();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn failed for a synthetic user: ${error?.message}`);
  return { client, token: data.session.access_token };
}

/**
 * Puts a REAL Election Owner session into a page's own storage, so a suite
 * does not need a login FORM to drive Owner screens.
 *
 * The per-origin Owner login was retired: an Owner signs in with a username,
 * and only the shared login on the auth deployment can resolve one - which a
 * single-surface suite does not run. The session written here is genuine (a
 * real signInWithPassword against the scratch stack), so every guard, token
 * refresh and server call behaves exactly as it does for a human; only the
 * typing is skipped.
 *
 * Writes DIRECTLY to the page's storage rather than through addInitScript, so
 * it can be called again after a sign-out to re-establish a session. An init
 * script would stack up and silently resurrect a session the test had just
 * signed out of, which is the opposite of what these suites assert.
 *
 * `base` is the election origin under test; the page is parked on a cheap
 * always-served route of that origin so storage for it can be written, and
 * the caller navigates wherever it needs afterwards.
 */
/**
 * The Multi-Entity Owner twin of `seedOwnerSession`.
 *
 * That realm's per-origin login was retired in the same batch that removed its
 * second factor: an owner signs in with a USERNAME on the shared login, which
 * only the auth deployment can resolve and a single-surface suite does not
 * run. The session written here is genuine - a real signInWithPassword against
 * the scratch stack - so every guard, refresh and server call behaves exactly
 * as it does for a human; only the typing is skipped.
 *
 * Writes storage directly rather than through addInitScript, for the same
 * reason: it can be called again after a sign-out instead of silently
 * resurrecting a session a test has just ended.
 */
export async function seedMultiEntitySession(page, base, email, password) {
  const { client } = await signIn(email, password);
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("seedMultiEntitySession: no session to seed");
  // A cheap same-origin page: the login route now bounces cross-origin, and a
  // suite must never leave the stack.
  await page.goto(`${base}/api/health`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["kb-multi-entity-owner-auth-token", JSON.stringify(data.session)],
  );
}

export async function seedOwnerSession(page, base, email, password) {
  const { client } = await signIn(email, password);
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("seedOwnerSession: no session to seed");
  await page.goto(`${base}/election-day/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["kb-owner-auth-token", JSON.stringify(data.session)],
  );
}

/** Enroll + verify a TOTP factor on an aal1 client; returns the aal2 token and
 * the secret (kept in memory only). Retries across a 30 s window boundary. */
export async function enrollTotp(client, friendlyName) {
  const en = await client.auth.mfa.enroll({ factorType: "totp", friendlyName });
  if (en.error) throw new Error(`mfa.enroll: ${en.error.message}`);
  const secret = en.data.totp.secret;
  const token = await verifyTotp(client, en.data.id, secret);
  return { factorId: en.data.id, secret, token };
}

export async function verifyTotp(client, factorId, secret) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const v = await client.auth.mfa.challengeAndVerify({
      factorId,
      code: totp(secret, Date.now() + attempt * 30000),
    });
    if (!v.error) return v.data.access_token;
    last = v.error;
    await sleep(1200);
  }
  throw new Error(`mfa verify: ${last?.message}`);
}

/** Minimal Vercel-shaped req/res harness around a bundled handler. */
export function callHandler(handler, { method = "GET", url, headers = {}, body, cookies } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(b) {
        this.body = b;
        resolve(this);
      },
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
        return this;
      },
      end() {
        resolve(this);
      },
    };
    Promise.resolve(handler({ method, url, headers, body, cookies: cookies ?? {} }, res)).then(
      () => resolve(res),
      (err) => resolve({ statusCode: "THREW", headers: {}, body: { threw: String(err) } }),
    );
  });
}

let pass = 0;
let fail = 0;
const failures = [];
export function check(id, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${id}${detail ? ` :: ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(id);
    console.log(`  [**FAIL**] ${id}${detail ? ` :: ${detail}` : ""}`);
  }
}
export function section(title) {
  console.log(`\n=== ${title} ===`);
}
export function tally(label) {
  console.log(`\n${label} SUMMARY: ${pass} PASS / ${fail} FAIL`);
  if (failures.length) console.log(`FAILED: ${failures.join(" | ")}`);
  return fail;
}
