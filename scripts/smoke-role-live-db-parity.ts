/** ONE-OFF, post-migration-apply live verification - NOT part of the regular
 * smoke suite (not listed in CURRENT_STATUS.md's standard set), deletable
 * after use. Calls the real, now-applied `election_day_list_roles()` RPC
 * against the linked Supabase project and diffs the response against
 * `BUILT_IN_ROLE_SEED` - proves the live DB seed (Phase 0) matches what the
 * Phase 1 engine assumes, not just what the migration SQL file says on disk
 * (that's `smoke-role-seed-parity.ts`'s job).
 * Run via: npx esbuild scripts/smoke-role-live-db-parity.ts --bundle --format=cjs --platform=node --outfile=scripts/smoke-role-live-db-parity.cjs && node -r dotenv/config scripts/smoke-role-live-db-parity.cjs dotenv_config_path=.env
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeRoleRecord, type RawRoleRow } from "../src/permissions/roleRecordMapper";
import { BUILT_IN_ROLE_SEED } from "../src/permissions/builtInRoleSeed";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

async function run() {
  const url = process.env.VITE_SUPABASE_URL!;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY!;
  assert(!!url && !!key, "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are set");

  const supabase = createClient(url, key);
  const { data, error } = await supabase.rpc("election_day_list_roles");
  assert(error === null, `election_day_list_roles() call succeeds (error: ${error?.message})`);
  const rows = data as RawRoleRow[];
  assert(rows.length === 3, `live DB returns exactly 3 roles (got ${rows.length})`);

  const returnedKeys = Object.keys(rows[0] ?? {}).sort();
  const expectedKeys = [
    "id",
    "name",
    "description",
    "permissions",
    "scope_type",
    "scope_value",
    "legacy_role_key",
  ].sort();
  assert(
    JSON.stringify(returnedKeys) === JSON.stringify(expectedKeys),
    `live RPC returns exactly the planned fields, no more/less (got [${returnedKeys.join(", ")}])`,
  );

  const normalized = rows.map(normalizeRoleRecord);
  for (const legacyRoleKey of ["manager", "user", "voting"] as const) {
    const live = normalized.find((r) => r.legacyRoleKey === legacyRoleKey);
    const fixture = BUILT_IN_ROLE_SEED.find((r) => r.legacyRoleKey === legacyRoleKey);
    assert(live !== undefined, `live DB has a row for legacyRoleKey="${legacyRoleKey}"`);
    if (!live || !fixture) continue;
    assert(
      live.scopeType === fixture.scopeType,
      `${legacyRoleKey}: live scopeType ("${live.scopeType}") matches fixture ("${fixture.scopeType}")`,
    );
    const liveSet = new Set(live.permissions);
    const fixtureSet = new Set(fixture.permissions);
    assert(
      live.permissions.length === fixture.permissions.length &&
        fixture.permissions.every((p) => liveSet.has(p)) &&
        live.permissions.every((p) => fixtureSet.has(p)),
      `${legacyRoleKey}: live permissions set is identical to the fixture (${live.permissions.length} permissions)`,
    );
  }

  if (process.exitCode) {
    console.error("\nsmoke-role-live-db-parity: FAILED");
  } else {
    console.log("\nsmoke-role-live-db-parity: all checks passed (live DB matches engine assumptions)");
  }
}

void run();
