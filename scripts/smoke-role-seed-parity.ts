/** Dynamic Roles & Permissions - fixture-vs-migration-seed parity check.
 * Run via: npx esbuild scripts/smoke-role-seed-parity.ts --bundle --format=cjs --outfile=scripts/smoke-role-seed-parity.cjs && node scripts/smoke-role-seed-parity.cjs
 *
 * `BUILT_IN_ROLE_SEED` (`src/permissions/builtInRoleSeed.ts`) is supposed to
 * mirror the FINAL state of the 3 built-in roles after every tracked
 * migration that touches them has replayed, in order. For `מנהל`/`נציג קלפי`
 * that final state is still exactly Phase 0's original
 * (`20260805181806_election_day_dynamic_roles_phase0.sql`) `insert into
 * public.election_day_roles` seed, byte-for-byte (same name/permissions/
 * scope_type) - matched by `name`, which is a stable, still-present anchor
 * on both sides for those two (Phase 3 dropped the migration's own
 * `legacy_role_key` column this used to match on, but the historical
 * migration file's SQL text is unaffected and still parseable).
 *
 * `seed-user` is the one exception (2026-08-23 display-name rename,
 * "משתמש" -> "טלפן/ית"): Phase 0's already-applied seed migration stays
 * fully immutable (still literally seeds "משתמש" - never edited in place),
 * and a later, standalone forward migration
 * (`20260823000000_election_day_role_rename_caller.sql`) renames the
 * already-persisted row instead. So for this one role, `name` can no longer
 * be used as the cross-file anchor (it's different in each file, by design)
 * - matched by `id: "seed-user"` in the fixture instead, and the chain is
 * verified end-to-end: Phase 0's seed still has permissions/scope_type
 * matching the fixture exactly (unaffected by the rename), AND the forward
 * migration's own `UPDATE` text is parsed and asserted to rename FROM
 * exactly Phase 0's original name TO exactly the fixture's current name -
 * so a future edit to either migration's name value without updating the
 * other, or without updating the fixture, fails this test loudly.
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

const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const PHASE_0_PATH = join(
  MIGRATIONS_DIR,
  "20260805181806_election_day_dynamic_roles_phase0.sql",
);
const RENAME_MIGRATION_PATH = join(
  MIGRATIONS_DIR,
  "20260823000000_election_day_role_rename_caller.sql",
);
const phase0Sql = readFileSync(PHASE_0_PATH, "utf8");

// Extract the `insert into public.election_day_roles (...) values (...), (...), (...);`
// block and split it into its 3 per-role tuples. Deliberately a targeted,
// readable parse (not a general SQL parser) - this migration's literal
// shape is fixed and already shipped, so a hand-rolled extraction that
// fails loudly on a shape mismatch is more trustworthy here than a generic
// parser that might silently misparse.
const insertMatch = phase0Sql.match(
  /insert into public\.election_day_roles[\s\S]*?values\s*([\s\S]*?);/,
);
assert(
  insertMatch !== null,
  "Phase 0 migration SQL contains the expected `insert into ... values (...)` block",
);
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
assert(
  tupleChunks.length === 3,
  `Phase 0 migration SQL splits into exactly 3 role tuples (got ${tupleChunks.length})`,
);

function extractRoleFromSql(name: string) {
  const chunk = tupleChunks.find((c) => new RegExp(`^\\s*'${name}'`).test(c));
  assert(
    chunk !== undefined,
    `Phase 0 migration SQL has an isolated tuple starting with name='${name}'`,
  );
  const match = chunk?.match(/array\[([\s\S]*?)\]\s*,\s*'(all|assigned_to_me)'\s*,/);
  assert(
    match !== null && match !== undefined,
    `tuple for name='${name}' has a parseable array[...] + scope_type`,
  );
  const permissionsRaw = match?.[1] ?? "";
  const scopeType = match?.[2] ?? "";
  const permissions = [...permissionsRaw.matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1]);
  return { permissions, scopeType };
}

/** Asserts a fixture's permissions/scopeType exactly match what was parsed
 * out of a Phase 0 SQL tuple (same-length, same-membership sets, no missing
 * or extra permission on either side) - the one comparison every built-in
 * role needs, whether or not its `name` also matches (seed-user's doesn't). */
function assertPermissionsAndScopeMatch(
  label: string,
  fromSql: { permissions: string[]; scopeType: string },
  fixture: { permissions: readonly string[]; scopeType: string | null },
) {
  assert(
    fixture.scopeType === fromSql.scopeType,
    `${label}: fixture scopeType ("${fixture.scopeType}") matches migration SQL ("${fromSql.scopeType}")`,
  );

  const fixtureSet = new Set(fixture.permissions);
  const sqlSet = new Set(fromSql.permissions);
  const missingFromFixture = fromSql.permissions.filter((p) => !fixtureSet.has(p as never));
  const extraInFixture = fixture.permissions.filter((p) => !sqlSet.has(p));
  assert(
    missingFromFixture.length === 0,
    `${label}: fixture is missing permission(s) present in the migration seed: [${missingFromFixture.join(", ")}]`,
  );
  assert(
    extraInFixture.length === 0,
    `${label}: fixture has extra permission(s) not present in the migration seed: [${extraInFixture.join(", ")}]`,
  );
}

// ---- Unchanged roles: מנהל / נציג קלפי - name is still a valid anchor -----
for (const name of ["מנהל", "נציג קלפי"] as const) {
  const fromSql = extractRoleFromSql(name);
  const fixture = BUILT_IN_ROLE_SEED.find((r) => r.name === name);
  assert(fixture !== undefined, `BUILT_IN_ROLE_SEED has an entry for name="${name}"`);
  if (!fixture) continue;
  assertPermissionsAndScopeMatch(name, fromSql, fixture);
}

// ---- Renamed role: seed-user ("משתמש" in Phase 0's seed -> "טלפן/ית" in --
// the fixture, via the forward migration) - matched by id, not name. -------
const seedUserFixture = BUILT_IN_ROLE_SEED.find((r) => r.id === "seed-user");
assert(seedUserFixture !== undefined, 'BUILT_IN_ROLE_SEED has an entry with id="seed-user"');

if (seedUserFixture) {
  const fromSql = extractRoleFromSql("משתמש");
  assertPermissionsAndScopeMatch("seed-user (משתמש -> טלפן/ית)", fromSql, seedUserFixture);

  assert(
    seedUserFixture.name === "טלפן/ית",
    `seed-user: fixture name is the final post-rename value ("${seedUserFixture.name}" === "טלפן/ית")`,
  );
}

// ---- Forward migration: confirms the SQL itself really renames FROM ------
// Phase 0's original seed name TO the fixture's final name - not just that
// the two happen to independently agree.
const renameSql = readFileSync(RENAME_MIGRATION_PATH, "utf8");
const renameMatch = renameSql.match(
  /update public\.election_day_roles\s*\n\s*set name = '([^']+)'\s*\n\s*where name = '([^']+)'/,
);
assert(
  renameMatch !== null,
  "forward migration (20260823000000) contains the expected `update ... set name = ... where name = ...` statement",
);

if (renameMatch) {
  const [, setName, whereName] = renameMatch;
  assert(
    whereName === "משתמש",
    `forward migration renames FROM Phase 0's original seed name ("${whereName}" === "משתמש")`,
  );
  assert(
    setName === "טלפן/ית",
    `forward migration renames TO the fixture's final name ("${setName}" === "טלפן/ית")`,
  );
  // Exactly one such UPDATE in the file's executable SQL - guards against
  // the migration later growing a second, unrelated rename smuggled into
  // the same file. Comment-only lines (including the file's own manual
  // ROLLBACK block, which necessarily shows the same statement in reverse)
  // are stripped first so they can't inflate this count.
  const codeOnly = renameSql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const allUpdates = [...codeOnly.matchAll(/update public\.election_day_roles\b/g)];
  assert(
    allUpdates.length === 1,
    `forward migration contains exactly one UPDATE against election_day_roles in its executable SQL (got ${allUpdates.length})`,
  );
}

if (process.exitCode) {
  console.error("\nsmoke-role-seed-parity: FAILED");
} else {
  console.log("\nsmoke-role-seed-parity: all checks passed");
}
