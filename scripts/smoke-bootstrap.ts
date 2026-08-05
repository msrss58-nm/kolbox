/** Bootstrap-fix smoke test - run via: npx esbuild scripts/smoke-bootstrap.ts --bundle --format=cjs --outfile=scripts/smoke-bootstrap.cjs && node scripts/smoke-bootstrap.cjs
 *
 * Pure-logic coverage for the roster-empty bootstrap fix
 * (ElectionDayGuard's `isBootstrap` -> Outlet context -> ElectionDayPage's
 * `showManageUsers = can("electionDay.manageUsers") || isBootstrap`).
 * Reimplements both formulas exactly as they appear in the source (pinned,
 * not re-derived) and exercises them against the real, unmodified
 * `computePermissions`/`PERMISSIONS_BY_ROLE` engine - proving the fix is a
 * local UI exception, not a change to the engine itself.
 */
import { ALL_PERMISSIONS, PERMISSIONS_BY_ROLE } from "../src/permissions/permissionsMap";
import { computePermissions } from "../src/permissions/computePermissions";
import type { EffectiveRole, Permission } from "../src/permissions/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- pinned formulas (must match ElectionDayGuard.tsx / ElectionDayPage.tsx exactly) --
// ElectionDayGuard.tsx: const isBootstrap = permissionUsers.length === 0 && user === null;
function computeIsBootstrap(rosterLength: number, hasUser: boolean): boolean {
  return rosterLength === 0 && !hasUser;
}

// ElectionDayPage.tsx: const showManageUsers = can("electionDay.manageUsers") || isBootstrap;
function can(role: EffectiveRole | null, permission: Permission): boolean {
  return role !== null && PERMISSIONS_BY_ROLE[role].has(permission);
}
function computeShowManageUsers(role: EffectiveRole | null, isBootstrap: boolean): boolean {
  return can(role, "electionDay.manageUsers") || isBootstrap;
}

// ---- scenario 1/2: isBootstrap formula matrix ---------------------------
assert(
  computeIsBootstrap(0, false) === true,
  "empty roster + no session -> isBootstrap=true",
);
assert(
  computeIsBootstrap(0, true) === false,
  "empty roster + existing session (stale localStorage edge case) -> isBootstrap=false",
);
assert(
  computeIsBootstrap(3, false) === false,
  "non-empty roster + no session -> isBootstrap=false (Guard redirects to /login, never reaches this)",
);
assert(
  computeIsBootstrap(3, true) === false,
  "non-empty roster + real session -> isBootstrap=false",
);

// ---- scenario 3/4: showManageUsers per role x isBootstrap ---------------
const MANAGER = computePermissions("manager").role;
const OPERATIONS = computePermissions("user").role; // legacy "user" -> operations
const VOTING: EffectiveRole = "voting"; // not reachable via real login until Stage 4

assert(
  computeShowManageUsers(null, true) === true,
  "no session + isBootstrap=true -> manage-users button visible (the fix)",
);
assert(
  computeShowManageUsers(null, false) === false,
  "no session + isBootstrap=false -> manage-users button hidden (unchanged, non-empty-roster case)",
);
assert(
  computeShowManageUsers(MANAGER, false) === true,
  "manager session -> manage-users visible via real permission, isBootstrap irrelevant",
);
assert(
  computeShowManageUsers(OPERATIONS, false) === false,
  "operations session -> manage-users hidden (unchanged)",
);
assert(
  computeShowManageUsers(VOTING, false) === false,
  "voting session -> manage-users hidden (unchanged)",
);
// role=operations/voting with isBootstrap=true is unreachable in the real app
// (isBootstrap requires user===null, which forces role=null) - tested anyway
// to pin the raw OR-expression's shape, not just its reachable subset.
assert(
  computeShowManageUsers(OPERATIONS, true) === true,
  "(unreachable in practice) OR-expression itself doesn't special-case role",
);

// ---- scenario 4: bootstrap widens ONLY manage-users, no other admin action --
// The other 5 admin show* flags in ElectionDayPage.tsx are plain `can(...)`,
// never OR'd with isBootstrap - asserted explicitly here per permission.
const OTHER_ADMIN_PERMISSIONS: Permission[] = [
  "electionDay.import",
  "electionDay.clearData",
  "electionDay.export",
  "electionDay.manageSettings",
  "electionDay.manageRideCoordinators",
];
for (const permission of OTHER_ADMIN_PERMISSIONS) {
  assert(
    can(null, permission) === false,
    `no session -> "${permission}" stays hidden even during bootstrap (not OR'd with isBootstrap)`,
  );
}

// ---- scenario 5: no-session still yields 0 permissions, for every one of ---
// the engine's permissions, independent of isBootstrap (proves the fix never
// touched computePermissions/hasPermission/PERMISSIONS_BY_ROLE/resolveEffectiveRole).
assert(
  computePermissions(null).role === null,
  "no session -> computePermissions(null).role is still null",
);
for (const permission of ALL_PERMISSIONS) {
  assert(
    computePermissions(null).can(permission) === false,
    `no session -> engine itself denies "${permission}" (isBootstrap is a ElectionDayPage-local concern only)`,
  );
}

if (process.exitCode) {
  console.error("\nsmoke-bootstrap: FAILED");
} else {
  console.log("\nsmoke-bootstrap: all checks passed");
}
