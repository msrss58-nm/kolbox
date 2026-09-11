// Platform Stage 5 - bundles the REAL Vercel handlers from api/ into
// self-contained CommonJS files for the local test suites (Node cannot load
// the .ts sources directly, and the project has no ts runner).
//
// Only one substitution is made, and only in these test bundles: every import
// of `_ownerAuth.js` resolves to scripts/stage5/faultableOwnerAuth.mjs, which
// re-exports the real module and wraps its service client so a test can inject
// a single deterministic failure. Handler code itself is bundled byte-for-byte.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const realOwnerAuth = path.join(repoRoot, "api", "election-day", "_ownerAuth.ts");
const shim = path.join(here, "faultableOwnerAuth.mjs");

const ENTRIES = {
  platformSession: "api/platform/session.ts",
  health: "api/health.ts",
  ownerActions: "api/election-day/owner-actions.ts",
  ownerRoles: "api/election-day/owner-roles.ts",
  ownerReauth: "api/election-day/owner-reauth.ts",
  electionSession: "api/election-day/session.ts",
};

const faultPlugin = {
  name: "s5-fault-shim",
  setup(b) {
    b.onResolve({ filter: /^kolbox-real-owner-auth$/ }, () => ({ path: realOwnerAuth }));
    b.onResolve({ filter: /_ownerAuth\.js$/ }, () => ({ path: shim }));
  },
};

export async function buildHandlers(outDir = path.join(os.tmpdir(), "kolbox-stage5-handlers")) {
  const require = createRequire(import.meta.url);
  const handlers = {};
  for (const [key, entry] of Object.entries(ENTRIES)) {
    const outfile = path.join(outDir, `${key}.cjs`);
    await build({
      entryPoints: [path.join(repoRoot, entry)],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      logLevel: "error",
      plugins: [faultPlugin],
    });
    delete require.cache[outfile];
    const mod = require(outfile);
    handlers[key] = mod.default ?? mod;
  }
  return handlers;
}
