// READ-ONLY Production verification for the unified-identity rollout.
//
// CREDENTIAL SAFETY: the keys are read from .env.local INSIDE this process and
// are never printed, logged, echoed, or included in any output. Only outcomes
// leave this script.
//
// Proves on PRODUCTION itself (the Permanent Engineering Guardrail requires a
// direct check there, never trusting a local/scratch result):
//   * every new function is UNREACHABLE with the anon key;
//   * every new function IS reachable with service_role;
//   * the new tables are unreadable with the anon key;
//   * the business baseline is unchanged by the migration.
//
// Run: node scripts/auth/prod-verify-identity.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

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
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
// Deployed Vercel projects call it SUPABASE_SECRET_KEY; the local file uses
// SUPABASE_SERVICE_ROLE_KEY. Accept either, read internally, never printed.
const SVC = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SVC) {
  console.error("MISSING CONFIG: need VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, and a service-role key");
  process.exit(1);
}
if (!/nbymfgphnsounqncfjgl/.test(URL_)) {
  console.error("REFUSING: this is not the approved Production project");
  process.exit(1);
}

/** The single real Platform Owner preserved by the 2026-09-20 cleanup. */
const OWNER_AUTH_USER_ID = "54ee240e-8c08-456b-88e8-3c54ec292b00";
const OWNER_USERNAME = "נחום משה";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  -> ${String(detail).slice(0, 200)}` : ""}`); }
};
const section = (t) => console.log(`\n== ${t} ==`);

async function rpc(key, fn, body) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function table(key, name, query = "select=*&limit=1") {
  const res = await fetch(`${URL_}/rest/v1/${name}?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

const NEW_FUNCTIONS = [
  ["auth_identity_resolve", { p_realm: "worker", p_username: "no such user" }],
  ["auth_identity_assign", { p_realm: "worker", p_username: "probe probe", p_auth_user_id: null, p_actor_id: null, p_workspace_id: null }],
  ["auth_identity_release", { p_auth_user_id: null, p_actor_id: null }],
  ["auth_identity_for_subject", { p_auth_user_id: "00000000-0000-0000-0000-000000000000" }],
  ["auth_identity_suggest_username", { p_realm: "worker", p_base: "probe" }],
  ["election_day_verify_credentials_by_actor_v1", { p_actor_id: "00000000-0000-0000-0000-000000000000", p_password: "x" }],
  ["election_day_create_permission_user_owner_v4", { p_auth_user_id: "00000000-0000-0000-0000-000000000000", p_reauth_proof_hash: "\\x00", p_name: "x", p_password: "x", p_role_id: "00000000-0000-0000-0000-000000000000", p_username: "x" }],
];

section("A. THE ANON KEY CANNOT REACH ANY NEW FUNCTION (Production pg ACL)");
for (const [fn, body] of NEW_FUNCTIONS) {
  const r = await rpc(ANON, fn, body);
  // PostgREST answers 404 PGRST202 when the function is not exposed to the
  // caller's role, or 401/403 when permission is denied outright. Anything
  // that actually EXECUTED (200) would be a leak.
  check(`A-${fn}: anon refused`, r.status === 404 || r.status === 401 || r.status === 403,
    `status=${r.status} ${JSON.stringify(r.body)}`);
}

section("B. THE NEW TABLE IS UNREADABLE WITH THE ANON KEY");
const tAnon = await table(ANON, "auth_identities");
check("B1 anon cannot read auth_identities", tAnon.status !== 200 || (Array.isArray(tAnon.body) && tAnon.body.length === 0),
  `status=${tAnon.status} ${JSON.stringify(tAnon.body)}`);

section("C. SERVICE ROLE CAN REACH THE FUNCTIONS (they really exist)");
const rs = await rpc(SVC, "auth_identity_resolve", { p_realm: "worker", p_username: "definitely not a user" });
check("C1 auth_identity_resolve executes and resolves nobody", rs.status === 200 && Array.isArray(rs.body) && rs.body.length === 0,
  `status=${rs.status} ${JSON.stringify(rs.body)}`);
const sg = await rpc(SVC, "auth_identity_suggest_username", { p_realm: "platform_owner", p_base: "נחום משה" });
check("C2 auth_identity_suggest_username executes", sg.status === 200, `status=${sg.status} ${JSON.stringify(sg.body)}`);

section("D. THE PRESERVED PRODUCTION BASELINE");
const counts = {};
for (const [label, rel] of [
  ["workspaces", "election_workspaces"],
  ["permission_users", "election_day_permission_users"],
  ["roles", "election_day_roles"],
  ["election_owners", "election_owners"],
  ["platform_owners", "platform_owners"],
  ["voters", "election_day_voters"],
  ["auth_identities", "auth_identities"],
]) {
  const res = await fetch(`${URL_}/rest/v1/${rel}?select=id`, {
    headers: { apikey: SVC, authorization: `Bearer ${SVC}`, prefer: "count=exact", range: "0-0" },
  });
  const cr = res.headers.get("content-range") ?? "";
  counts[label] = cr.includes("/") ? cr.split("/")[1] : "?";
}
console.log("   counts:", JSON.stringify(counts));
// Baseline retargeted after the approved Production cleanup (2026-09-20),
// which reduced Production to exactly ONE real principal. The old counts
// (2 workspaces / 3 permission users / 2 election owners / 1422 voters)
// described the pre-cleanup state and can never hold again.
check("D1 exactly one Platform Owner", counts.platform_owners === "1", counts.platform_owners);
check("D2 exactly one identity-directory row (the Platform Owner's username)",
  counts.auth_identities === "1", counts.auth_identities);
check("D3 no workspaces", counts.workspaces === "0", counts.workspaces);
check("D4 no permission users and no roles",
  counts.permission_users === "0" && counts.roles === "0",
  `${counts.permission_users}/${counts.roles}`);
check("D5 no election owners and no voters",
  counts.election_owners === "0" && counts.voters === "0",
  `${counts.election_owners}/${counts.voters}`);

section("E. PLATFORM OWNER SIGNS IN WITH PASSWORD ONLY");
// Mandatory Platform Owner MFA was removed from the active login flow, and the
// Owner's leftover TOTP factor was unenrolled so GoTrue stops refusing an
// in-app password change with `insufficient_aal`. Both facts are checkable
// without any credential: the factor simply must not exist.
const factors = await fetch(`${URL_}/auth/v1/admin/users/${OWNER_AUTH_USER_ID}/factors`, {
  headers: { apikey: SVC, authorization: `Bearer ${SVC}` },
});
let factorList = null;
try { factorList = await factors.json(); } catch { factorList = null; }
const factorArray = Array.isArray(factorList) ? factorList : (factorList?.factors ?? null);
check("E1 the Platform Owner has NO enrolled MFA factor",
  factors.status === 200 && Array.isArray(factorArray) && factorArray.length === 0,
  `status=${factors.status} ${JSON.stringify(factorList)}`);
const resolved = await rpc(SVC, "auth_identity_resolve", {
  p_realm: "platform_owner", p_username: OWNER_USERNAME,
});
check(`E2 the username "${OWNER_USERNAME}" still resolves on the Platform Owner realm`,
  resolved.status === 200 && Array.isArray(resolved.body) && resolved.body.length === 1,
  JSON.stringify(resolved.body));

console.log(`\nPRODUCTION IDENTITY VERIFY: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;
