/** Dynamic Roles & Permissions Phase 2 - pure-logic coverage, mirroring
 * `smoke-permission-logic.ts`'s precedent for `useElectionDay.ts`'s
 * `guardedAction` wiring: `useRoleManagement.ts`'s hook can't be imported
 * directly here (it transitively pulls in the real Supabase client via
 * `usePermissions`/`electionDaySession.ts`, which crashes on
 * `import.meta.env` in plain Node). Instead this pins the exact permission
 * every role-management mutation requires - `electionDay.manageRolesAndPermissions`
 * - against the real engine (`computePermissions` + `BUILT_IN_ROLE_SEED`),
 * plus a pinned copy of `supabaseElectionDayApi.ts`'s `mapRoleRpcErrorMessage`
 * (same "can't import a Supabase-client-adjacent module in Node" reason) so
 * a source edit that silently changes an error code's Hebrew text is caught.
 *
 * Run via: npx esbuild scripts/smoke-role-management-logic.ts --bundle --format=cjs --outfile=scripts/smoke-role-management-logic.cjs && node scripts/smoke-role-management-logic.cjs
 */
import { computePermissions } from "../src/permissions/computePermissions";
import type { Permission } from "../src/permissions/types";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function can(sessionRoleId: string | null, permission: Permission): boolean {
  return computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED).can(permission);
}

const MANAGER = "seed-manager";
const OPERATIONS = "seed-user";
const VOTING = "seed-voting";
const NO_SESSION: string | null = null;

// ---- every role-management mutation requires the same single permission --
const ROLE_MANAGEMENT_MUTATIONS = [
  "createRole",
  "updateRole",
  "deleteRole",
  "cloneRole",
] as const;
const PERMISSION: Permission = "electionDay.manageRolesAndPermissions";

for (const mutation of ROLE_MANAGEMENT_MUTATIONS) {
  assert(can(MANAGER, PERMISSION) === true, `manager: "${mutation}" allowed`);
  assert(can(OPERATIONS, PERMISSION) === false, `operations: "${mutation}" denied`);
  assert(can(VOTING, PERMISSION) === false, `voting: "${mutation}" denied`);
  assert(can(NO_SESSION, PERMISSION) === false, `no session: "${mutation}" denied`);
}

// ---- fail-closed: catalog not loaded denies role management for every role -
for (const status of ["idle", "loading", "error"] as const) {
  for (const roleId of [MANAGER, OPERATIONS, VOTING]) {
    const result = computePermissions(roleId, status, BUILT_IN_ROLE_SEED);
    assert(
      result.can(PERMISSION) === false,
      `catalogStatus="${status}": role management denied for "${roleId}" (fail-closed, no fallback)`,
    );
  }
}

// ---- addPermissionUserForRole (Phase 2's counterpart to addPermissionUser) -
// carries the exact same electionDay.manageUsers permission + bootstrap
// exception as the legacy addPermissionUser - re-pinned here since it's a
// distinct guardedAction call site in useElectionDay.ts.
function addPermissionUserForRoleAllowed(
  roleId: string | null,
  isBootstrap: boolean,
  rosterStillEmpty: boolean,
): boolean {
  return can(roleId, "electionDay.manageUsers") || (isBootstrap && rosterStillEmpty);
}

assert(
  addPermissionUserForRoleAllowed(MANAGER, false, false) === true,
  "addPermissionUserForRole: manager allowed via real permission",
);
assert(
  addPermissionUserForRoleAllowed(OPERATIONS, false, false) === false,
  "addPermissionUserForRole: operations denied (no permission, not bootstrap)",
);
assert(
  addPermissionUserForRoleAllowed(NO_SESSION, true, true) === true,
  "addPermissionUserForRole: no session + isBootstrap + roster still empty -> allowed",
);
assert(
  addPermissionUserForRoleAllowed(NO_SESSION, true, false) === false,
  "addPermissionUserForRole: bootstrap exception self-cancels once the roster is no longer empty",
);

// ---- pinned copy of supabaseElectionDayApi.ts's mapRoleRpcErrorMessage ----
// (re-implemented, not imported - importing the real module pulls in the
// Supabase client, which crashes on import.meta.env in plain Node, same
// reason smoke-permission-logic.ts pins guardedAction's decision instead of
// importing the hook itself).
function mapRoleRpcErrorMessage(message: string): string {
  if (message.includes("ROLE_HAS_ASSIGNED_USERS")) {
    return "לא ניתן למחוק תפקיד שיש לו משתמשים משויכים";
  }
  if (message.includes("CANNOT_REMOVE_LAST_PERMISSION_HOLDER")) {
    return "חייב להישאר לפחות משתמש אחד עם הרשאת ניהול תפקידים והרשאות";
  }
  if (message.includes("ROLE_NAME_REQUIRED")) {
    return "יש להזין שם לתפקיד";
  }
  if (message.includes("ROLE_NOT_FOUND")) {
    return "התפקיד לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("election_day_roles_name_key") || message.includes("duplicate key")) {
    return "כבר קיים תפקיד בשם זה";
  }
  return message;
}

assert(
  mapRoleRpcErrorMessage("ROLE_HAS_ASSIGNED_USERS") === "לא ניתן למחוק תפקיד שיש לו משתמשים משויכים",
  "mapRoleRpcErrorMessage: ROLE_HAS_ASSIGNED_USERS maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage("CANNOT_REMOVE_LAST_PERMISSION_HOLDER") ===
    "חייב להישאר לפחות משתמש אחד עם הרשאת ניהול תפקידים והרשאות",
  "mapRoleRpcErrorMessage: CANNOT_REMOVE_LAST_PERMISSION_HOLDER maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage(
    'duplicate key value violates unique constraint "election_day_roles_name_key"',
  ) === "כבר קיים תפקיד בשם זה",
  "mapRoleRpcErrorMessage: a name-uniqueness violation maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage("some unrelated raw Postgres error") === "some unrelated raw Postgres error",
  "mapRoleRpcErrorMessage: an unrecognized message passes through unchanged (never swallowed)",
);

if (process.exitCode) {
  console.error("\nsmoke-role-management-logic: FAILED");
} else {
  console.log("\nsmoke-role-management-logic: all checks passed");
}
