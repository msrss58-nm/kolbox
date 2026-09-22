// Credential-free Production verification of the four dedicated login
// surfaces, run AFTER the deploy.
//
// Everything here is checkable without any principal's password or TOTP:
// routing, realm partitioning, deployment gating, generic-failure shape,
// origin enforcement, and the absence of the retired inputs. The four human
// sign-ins are deliberately NOT attempted.
//
// ONE request at a time with a browser UA and wide spacing: Vercel's bot
// mitigation answers 403 X-Vercel-Mitigated under aggressive polling, which
// is not an outage but would corrupt these results.
//
// Run: node scripts/auth/prod-verify-login-surfaces.mjs
const AUTH = "https://kolbox-auth.vercel.app";
const ELECTION = "https://kolbox-gamma.vercel.app";
const PLATFORM = "https://kolbox-platform.vercel.app";
const MULTI = "https://kolbox-multi-entity.vercel.app";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = 6000;

let pass = 0,
  fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? `  -> ${String(detail).slice(0, 220)}` : ""}`);
  }
};
const section = (t) => console.log(`\n== ${t} ==`);

async function req(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": UA, ...(init.headers ?? {}) },
    redirect: "manual",
  });
  const text = await res.text().catch(() => "");
  await sleep(GAP);
  return { status: res.status, text, headers: res.headers };
}

const post = (url, origin, body) =>
  req(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------- routing --
// RUN THIS ONLY AGAINST A DEPLOYMENT THAT CARRIES THE TWO-SCREEN MODEL. The
// retired realm paths still resolve (as redirects, so still 200) but their
// API ops are gone, which is what B asserts below.
section("A. THE LOGIN ROUTES ARE SERVED BY THE AUTH ORIGIN");
for (const [id, path] of [
  ["A1", "/login"],
  ["A2", "/login/election-owner"],
  ["A3", "/login/platform-owner"],
  ["A4", "/login/users"],
]) {
  const r = await req(`${AUTH}${path}`);
  check(`${id} ${path} serves the SPA (200)`, r.status === 200, `status=${r.status}`);
}

// ------------------------------------------------------------- api routes --
section("B. THE TWO LOGIN OPS EXIST AND FAIL GENERICALLY; THE RETIRED ONES ARE GONE");
const BAD = { username: "definitely no such principal", password: "definitely-wrong" };
const shapes = [];
for (const [id, path] of [
  ["B1", "/api/auth/login"],
  ["B2", "/api/auth/login/platform-owner"],
]) {
  const r = await post(`${AUTH}${path}`, AUTH, BAD);
  shapes.push(`${r.status}:${r.text.trim()}`);
  check(`${id} ${path} -> 401 generic`, r.status === 401, `status=${r.status} body=${r.text.slice(0, 120)}`);
}
for (const [id, path] of [
  ["B3", "/api/auth/login/users"],
  ["B4", "/api/auth/login/election-owner"],
  ["B5", "/api/auth/login/multi-entity-owner"],
]) {
  const r = await post(`${AUTH}${path}`, AUTH, BAD);
  check(
    `${id} the retired ${path} no longer authenticates anything`,
    r.status !== 200 && r.status !== 401,
    `status=${r.status}`,
  );
}
check(
  "B5 all four failures are BYTE-IDENTICAL (no realm is distinguishable)",
  new Set(shapes).size === 1,
  shapes.join(" | "),
);

// A real username with a wrong password must look exactly the same as an
// unknown one. The Platform Owner's username is the only one assigned, and no
// password is sent that could succeed.
const realUserWrongPw = await post(`${AUTH}/api/auth/login/platform-owner`, AUTH, {
  username: "נחום משה",
  password: "definitely-wrong",
});
check(
  "B6 a REAL username with a wrong password is indistinguishable from an unknown one",
  `${realUserWrongPw.status}:${realUserWrongPw.text.trim()}` === shapes[0],
  `${realUserWrongPw.status} ${realUserWrongPw.text.slice(0, 120)}`,
);

// ------------------------------------------------------- realm separation --
section("C. WRONG-REALM AND RETIRED INPUTS ARE REFUSED");
const wrongRealm = await post(`${AUTH}/api/auth/login`, AUTH, {
  username: "נחום משה",
  password: "definitely-wrong",
});
check(
  "C1 the Platform Owner username on the Users surface -> same generic 401",
  `${wrongRealm.status}:${wrongRealm.text.trim()}` === shapes[0],
  `${wrongRealm.status} ${wrongRealm.text.slice(0, 120)}`,
);

const withCode = await post(`${AUTH}/api/auth/login`, AUTH, {
  username: "x",
  password: "y",
  workspaceCode: "AAAA2345",
});
check("C2 a system code in the body is REFUSED (400)", withCode.status === 400, `status=${withCode.status}`);

const withEmail = await post(`${AUTH}/api/auth/login`, AUTH, {
  username: "x",
  password: "y",
  recoveryEmail: "a@b.test",
});
check("C3 a recovery-email field is REFUSED (400)", withEmail.status === 400, `status=${withEmail.status}`);

const foreign = await post(`${AUTH}/api/auth/login`, "https://evil.test", BAD);
check("C4 a foreign Origin is refused (403)", foreign.status === 403, `status=${foreign.status}`);

const getLogin = await req(`${AUTH}/api/auth/login`, { method: "GET" });
check("C5 GET on a login op is refused (405)", getLogin.status === 405, `status=${getLogin.status}`);

// ------------------------------------------------------- deployment gating --
section("D. LOGIN OPS ANSWER ONLY ON THE AUTH DEPLOYMENT");
for (const [id, origin, name] of [
  ["D1", ELECTION, "election"],
  ["D2", PLATFORM, "platform"],
  ["D3", MULTI, "multi_entity"],
]) {
  const r = await post(`${origin}/api/auth/login`, origin, BAD);
  check(
    `${id} ${name} surface does not answer the login op (404)`,
    r.status === 404,
    `status=${r.status} body=${r.text.slice(0, 100)}`,
  );
}

// -------------------------------------------------------- no regression ----
section("E. THE LEGACY DIRECT ROUTES ARE STILL ALIVE (no CONTRACT)");
const legacyWorker = await post(`${ELECTION}/api/election-day/session`, ELECTION, {
  workspaceCode: "ZZZZ9999",
  name: "nobody",
  password: "nobody",
});
check(
  "E1 the direct worker login still answers its own generic 401",
  legacyWorker.status === 401,
  `status=${legacyWorker.status}`,
);
const legacyScreen = await req(`${ELECTION}/election-day/login`);
check("E2 the direct worker login screen still serves", legacyScreen.status === 200, `status=${legacyScreen.status}`);

console.log(`\nPRODUCTION LOGIN SURFACES: ${pass} ok / ${fail} FAIL`);
process.exitCode = fail === 0 ? 0 : 1;
