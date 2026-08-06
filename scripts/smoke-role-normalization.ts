/** Dynamic Roles & Permissions - API-boundary validation smoke test.
 * Run via: npx esbuild scripts/smoke-role-normalization.ts --bundle --format=cjs --outfile=scripts/smoke-role-normalization.cjs && node scripts/smoke-role-normalization.cjs
 *
 * `normalizeRoleRecord` (`src/permissions/roleRecordMapper.ts`) is the only
 * place a raw `election_day_list_roles()` row becomes a trusted `RoleRecord`
 * - never a blind cast. This suite proves every untrusted field fails
 * closed independently: an unrecognized `scope_type` becomes `null` (never
 * guessed at or defaulted to something permissive), and a permission string
 * not in the live `ALL_PERMISSIONS` catalog is dropped (never silently cast
 * into a `Permission`).
 */
import { ALL_PERMISSIONS } from "../src/permissions/permissionsMap";
import { normalizeRoleRecord } from "../src/permissions/roleRecordMapper";
import { BUILT_IN_ROLE_SEED, MALFORMED_ROLE_ROWS } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- a well-formed row round-trips exactly ------------------------------
const manager = BUILT_IN_ROLE_SEED.find((r) => r.id === "seed-manager")!;
const wellFormedRow = {
  id: manager.id,
  name: manager.name,
  description: manager.description,
  permissions: [...manager.permissions],
  scope_type: manager.scopeType,
  scope_value: manager.scopeValue,
};
const roundTripped = normalizeRoleRecord(wellFormedRow);
assert(
  roundTripped.permissions.length === manager.permissions.length &&
    manager.permissions.every((p) => roundTripped.permissions.includes(p)),
  "a well-formed row's permissions round-trip exactly, none dropped",
);
assert(roundTripped.scopeType === "all", "a well-formed row's scope_type round-trips exactly");

// ---- unknown scope_type -> null (fail closed), not "all" or a guess -----
const unknownScope = normalizeRoleRecord(MALFORMED_ROLE_ROWS.unknownScopeType);
assert(
  unknownScope.scopeType === null,
  'an unrecognized scope_type ("everything") normalizes to null, never passed through',
);

// ---- missing scope_type -> null --------------------------------------
const missingScope = normalizeRoleRecord(MALFORMED_ROLE_ROWS.missingScopeType);
assert(missingScope.scopeType === null, "a null scope_type normalizes to null");

// ---- garbage/unknown permission strings never survive normalization -----
const garbageRow = MALFORMED_ROLE_ROWS.garbagePermissionStrings;
const normalizedGarbage = normalizeRoleRecord(garbageRow);
assert(
  normalizedGarbage.permissions.includes("voter.markVoted"),
  "a genuine permission string in a mixed/garbage array is still kept",
);
assert(
  !(normalizedGarbage.permissions as string[]).includes("sudo.deleteEverything"),
  "an unknown permission string from the RPC does not survive normalization",
);
assert(
  normalizedGarbage.permissions.every((p) => ALL_PERMISSIONS.includes(p)),
  "every surviving permission is a real member of ALL_PERMISSIONS - nothing else could grant a capability",
);
assert(
  normalizedGarbage.permissions.length === 1,
  `non-string junk (number/null/undefined) in the permissions array is silently dropped, not cast (got ${normalizedGarbage.permissions.length})`,
);

// ---- id/name/description are safely coerced, never thrown on -----------
const weirdShapeRow = {
  id: 12345, // not a string - should never happen per the RPC's uuid column, but never trusted blindly
  name: null,
  description: undefined,
  permissions: [],
  scope_type: "all",
  scope_value: { note: "reserved for a future scope dimension" },
};
const normalizedWeird = normalizeRoleRecord(weirdShapeRow as never);
assert(typeof normalizedWeird.id === "string", "a non-string id is coerced to a string, never thrown on");
assert(normalizedWeird.name === "", "a non-string name safely normalizes to an empty string");
assert(
  normalizedWeird.description === "",
  "a non-string description safely normalizes to an empty string",
);
assert(
  JSON.stringify(normalizedWeird.scopeValue) === JSON.stringify({ note: "reserved for a future scope dimension" }),
  "scope_value passes through as-is (Json | null) - Phase 1 never validates its shape, only its presence",
);

if (process.exitCode) {
  console.error("\nsmoke-role-normalization: FAILED");
} else {
  console.log("\nsmoke-role-normalization: all checks passed");
}
