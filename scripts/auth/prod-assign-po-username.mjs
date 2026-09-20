// Gate 6: assign the real Platform Owner's application username in Production.
//
// CREDENTIAL SAFETY: the service-role key is read from the env file INSIDE
// this process and is never printed, logged, echoed or returned.
//
// SAFETY PROPERTIES
//   * refuses to run against anything but the approved Production project;
//   * refuses if there is not EXACTLY ONE platform_owners row;
//   * idempotent: if a username is already claimed it reports and changes
//     nothing (a username is permanent - there is no rename flow);
//   * touches nothing else. No cleanup, no deletion, no entitlement change.
//
// Run: node scripts/auth/prod-assign-po-username.mjs "<username>"
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const USERNAME = process.argv[2];
if (!USERNAME || USERNAME.trim() === "") {
  console.error("USAGE: node scripts/auth/prod-assign-po-username.mjs \"<username>\"");
  process.exit(1);
}

function readEnv() {
  const out = {};
  for (const file of [".env.local", ".env"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

const env = readEnv();
const URL_ = env.VITE_SUPABASE_URL;
const SVC = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SVC) {
  console.error("MISSING CONFIG");
  process.exit(1);
}
if (!/nbymfgphnsounqncfjgl/.test(URL_)) {
  console.error("REFUSING: not the approved Production project");
  process.exit(1);
}

const H = { apikey: SVC, authorization: `Bearer ${SVC}`, "content-type": "application/json" };

async function rest(pathname, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${pathname}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}
const rpc = (fn, args) =>
  rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// --- 1. Resolve the ONE Platform Owner -------------------------------------
const owners = await rest("platform_owners?select=id,auth_user_id,name");
if (owners.status !== 200 || !Array.isArray(owners.body)) {
  console.error("FAILED to read platform_owners:", owners.status);
  process.exit(1);
}
if (owners.body.length !== 1) {
  console.error(`REFUSING: expected exactly 1 platform_owners row, found ${owners.body.length}`);
  process.exit(1);
}
const po = owners.body[0];
console.log(`Platform Owner resolved: name="${po.name}" (exactly one row)`);

// --- 2. Idempotency: already claimed? --------------------------------------
const existing = await rpc("auth_identity_for_subject", { p_auth_user_id: po.auth_user_id });
if (existing.status === 200 && typeof existing.body === "string" && existing.body !== "") {
  console.log(`ALREADY ASSIGNED: "${existing.body}" - nothing changed (usernames are permanent).`);
  process.exit(0);
}

// --- 3. Availability -------------------------------------------------------
const taken = await rpc("auth_identity_resolve", { p_realm: "platform_owner", p_username: USERNAME });
if (taken.status === 200 && Array.isArray(taken.body) && taken.body.length > 0) {
  const sug = await rpc("auth_identity_suggest_username", { p_realm: "platform_owner", p_base: USERNAME });
  console.error(`REFUSING: "${USERNAME}" is already taken. Next free: ${JSON.stringify(sug.body)}`);
  process.exit(1);
}

// --- 4. Assign -------------------------------------------------------------
const assigned = await rpc("auth_identity_assign", {
  p_realm: "platform_owner",
  p_username: USERNAME,
  p_auth_user_id: po.auth_user_id,
  p_actor_id: null,
  p_workspace_id: null,
});
if (assigned.status !== 200) {
  console.error("ASSIGN FAILED:", assigned.status, JSON.stringify(assigned.body));
  process.exit(1);
}

// --- 5. Read back ----------------------------------------------------------
const back = await rpc("auth_identity_for_subject", { p_auth_user_id: po.auth_user_id });
const resolved = await rpc("auth_identity_resolve", { p_realm: "platform_owner", p_username: USERNAME });
const wrongRealm = await rpc("auth_identity_resolve", { p_realm: "worker", p_username: USERNAME });

console.log(`ASSIGNED: "${back.body}"`);
console.log(`resolves on the Platform Owner surface: ${Array.isArray(resolved.body) && resolved.body.length === 1}`);
console.log(`does NOT resolve on the Users surface:  ${Array.isArray(wrongRealm.body) && wrongRealm.body.length === 0}`);

const ok =
  back.body === USERNAME &&
  Array.isArray(resolved.body) && resolved.body.length === 1 &&
  Array.isArray(wrongRealm.body) && wrongRealm.body.length === 0;
console.log(ok ? "GATE 6: PASS" : "GATE 6: FAIL");
process.exitCode = ok ? 0 : 1;
