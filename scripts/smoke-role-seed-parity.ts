/** Dynamic Roles & Permissions - fixture-vs-migration-seed parity check.
 * Run via: npx esbuild scripts/smoke-role-seed-parity.ts --bundle --format=cjs --outfile=scripts/smoke-role-seed-parity.cjs && node scripts/smoke-role-seed-parity.cjs
 *
 * `BUILT_IN_ROLE_SEED` (`src/permissions/builtInRoleSeed.ts`) is supposed to
 * mirror the Phase 0 migration's `insert into public.election_day_roles`
 * seed byte-for-byte (same name/permissions/scope_type/legacy_role_key per
 * role). Every other Phase 1 smoke test trusts that mirror - this is the
 * one script that actually parses the migration SQL itself and diffs it
 * against the TS fixture, so the two can never silently drift apart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_ROLE_SEED } from "../src/permissions/builtInRoleSeed";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const MIGRATION_PATH = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260805181806_election_day_dynamic_roles_phase0.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

// Extract the `insert into public.election_day_roles (...) values (...), (...), (...);`
// block and split it into its 3 per-role tuples. Deliberately a targeted,
// readable parse (not a general SQL parser) - this migration's literal
// shape is fixed and already shipped, so a hand-rolled extraction that
// fails loudly on a shape mismatch is more trustworthy here than a generic
// parser that might silently misparse.
const insertMatch = sql.match(
  /insert into public\.election_day_roles[\s\S]*?values\s*([\s\S]*?);/,
);
assert(insertMatch !== null, "migration SQL contains the expected `insert into ... values (...)` block");
const valuesBlock = insertMatch![1];

// Split into isolated per-tuple chunks FIRST (on the `),` / `(` boundary
// between tuples), so each tuple is parsed against its own, physically
// separate string - a single combined regex over the whole block risks a
// lazy quantifier leaking across tuple boundaries (e.g. matching from one
// role's `array[` all the way to a LATER role's closing `]` if the nearer
// one doesn't satisfy the rest of the pattern), silently mixing two roles'
// permissions together instead of failing loudly.
const tupleChunks = valuesBlock
  .trim()
  .replace(/^\(/, "")
  .replace(/\)\s*$/, "")
  .split(/\)\s*,\s*\(/);
assert(tupleChunks.length === 3, `migration SQL splits into exactly 3 role tuples (got ${tupleChunks.length})`);

function extractRoleFromSql(legacyRoleKey: "manager" | "user" | "voting") {
  const chunk = tupleChunks.find((c) => new RegExp(`'${legacyRoleKey}'\\s*$`).test(c.trim()));
  assert(chunk !== undefined, `migration SQL has an isolated tuple ending in legacy_role_key='${legacyRoleKey}'`);
  const match = chunk?.match(/array\[([\s\S]*?)\]\s*,\s*'(all|assigned_to_me)'\s*,/);
  assert(match !== null && match !== undefined, `tuple for legacy_role_key='${legacyRoleKey}' has a parseable array[...] + scope_type`);
  const permissionsRaw = match?.[1] ?? "";
  const scopeType = match?.[2] ?? "";
  const permissions = [...permissionsRaw.matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1]);
  return { permissions, scopeType };
}

for (const legacyRoleKey of ["manager", "user", "voting"] as const) {
  const fromSql = extractRoleFromSql(legacyRoleKey);
  const fixture = BUILT_IN_ROLE_SEED.find((r) => r.legacyRoleKey === legacyRoleKey);
  assert(fixture !== undefined, `BUILT_IN_ROLE_SEED has an entry for legacyRoleKey="${legacyRoleKey}"`);
  if (!fixture) continue;

  assert(
    fixture.scopeType === fromSql.scopeType,
    `${legacyRoleKey}: fixture scopeType ("${fixture.scopeType}") matches migration SQL ("${fromSql.scopeType}")`,
  );

  const fixtureSet = new Set(fixture.permissions);
  const sqlSet = new Set(fromSql.permissions);
  const missingFromFixture = fromSql.permissions.filter((p) => !fixtureSet.has(p as never));
  const extraInFixture = fixture.permissions.filter((p) => !sqlSet.has(p));
  assert(
    missingFromFixture.length === 0,
    `${legacyRoleKey}: fixture is missing permission(s) present in the migration seed: [${missingFromFixture.join(", ")}]`,
  );
  assert(
    extraInFixture.length === 0,
    `${legacyRoleKey}: fixture has extra permission(s) not present in the migration seed: [${extraInFixture.join(", ")}]`,
  );
}

if (process.exitCode) {
  console.error("\nsmoke-role-seed-parity: FAILED");
} else {
  console.log("\nsmoke-role-seed-parity: all checks passed");
}
