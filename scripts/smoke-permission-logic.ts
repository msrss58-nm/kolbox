/** Stage 3 business-logic-enforcement smoke test - run via: npx esbuild scripts/smoke-permission-logic.ts --bundle --format=cjs --outfile=scripts/smoke-permission-logic.cjs && node scripts/smoke-permission-logic.cjs
 *
 * Pure-logic coverage for `useElectionDay.ts`'s `guardedAction` wiring.
 * `guardedAction` itself can't be imported directly here (it's a closure
 * defined inside the hook, and the hook transitively imports the real
 * Supabase client via `electionDaySession.ts` -> crashes on
 * `import.meta.env` in plain Node - same reason `computePermissions.ts` was
 * split out in Stage 1). Instead this pins the *decision* every guarded
 * mutation makes - `can(permission)`, exactly what `guardedAction` checks -
 * against the real engine (via `computePermissions` + the `BUILT_IN_ROLE_SEED`
 * fixture, Dynamic Roles & Permissions Phase 1), keyed by the exact
 * mutation -> permission mapping as coded in `useElectionDay.ts`. A
 * mismatch here means either the source's permission choice or this pin is
 * wrong - either way worth catching.
 */
import {
  computePermissions,
  type PermissionsResult,
} from "../src/permissions/computePermissions";
import type { Permission } from "../src/permissions/types";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// Phase 2: computePermissions resolves by roleId, not legacy role text.
function can(sessionRoleId: string | null, permission: Permission): boolean {
  return computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED).can(permission);
}

const MANAGER = "seed-manager";
const OPERATIONS = "seed-user"; // legacy "user" -> operations
const VOTING = "seed-voting";
const NO_SESSION: string | null = null;

// ---- the exact mutation -> permission map as wired in useElectionDay.ts ----
const MUTATION_PERMISSIONS: Record<string, Permission> = {
  setVoted: "voter.markVoted",
  setReminder: "voter.manageReminder",
  setReminderAt: "voter.manageReminder",
  setRideArranged: "voter.manageRide",
  toggleRideRequested: "voter.manageRide",
  sendRideRequestToDriver: "voter.manageRide",
  cancelRideCoordination: "voter.manageRide",
  setRideCompleted: "voter.manageRide",
  setPhone: "voter.editPhone",
  setNotes: "voter.editNotes",
  importFile: "electionDay.import",
  clearElectionDayData: "electionDay.clearData",
  exportReport: "electionDay.export",
  sendSnapshotReport: "electionDay.export",
  setElectionDayDeadline: "electionDay.manageSettings",
  deletePermissionUser: "electionDay.manageUsers",
  resetPermissionUserPassword: "electionDay.manageUsers",
  addRideCoordinator: "electionDay.manageRideCoordinators",
  deleteRideCoordinator: "electionDay.manageRideCoordinators",
  incrementCallAttempts: "voter.viewPhone",
  extendCallAttemptsThreshold: "voter.viewPhone",
};

// ---- manager: every mutation allowed, no exceptions ----------------------
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  assert(
    can(MANAGER, permission) === true,
    `manager: "${mutation}" (${permission}) allowed`,
  );
}

// ---- operations: setVoted denied; reminder/ride/phone/notes allowed; -----
// admin mutations (import/clear/export/settings/manageUsers/manageRideCoordinators) denied
const OPERATIONS_ALLOWED = new Set([
  "setReminder",
  "setReminderAt",
  "setRideArranged",
  "toggleRideRequested",
  "sendRideRequestToDriver",
  "cancelRideCoordination",
  "setRideCompleted",
  "setPhone",
  "setNotes",
  "incrementCallAttempts",
  "extendCallAttemptsThreshold",
]);
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  const expected = OPERATIONS_ALLOWED.has(mutation);
  assert(
    can(OPERATIONS, permission) === expected,
    `operations: "${mutation}" (${permission}) ${expected ? "allowed" : "denied"}`,
  );
}

// ---- voting: setVoted allowed (its whole purpose) plus the call-attempts --
// pair, since "voting" also carries voter.viewPhone (sees phone/can call,
// same as every other role) - every other mutation denied.
const VOTING_ALLOWED = new Set([
  "setVoted",
  "incrementCallAttempts",
  "extendCallAttemptsThreshold",
]);
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  const expected = VOTING_ALLOWED.has(mutation);
  assert(
    can(VOTING, permission) === expected,
    `voting: "${mutation}" (${permission}) ${expected ? "allowed" : "denied"}`,
  );
}

// ---- no session: every mutation denied, no exceptions --------------------
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  assert(
    can(NO_SESSION, permission) === false,
    `no session: "${mutation}" (${permission}) denied`,
  );
}

// ---- Dynamic Roles & Permissions Phase 1: catalog not loaded -------------
// denies every mutation for every role, no exceptions - the fail-closed
// contract applies uniformly regardless of which mutation is being guarded.
for (const status of ["idle", "loading", "error"] as const) {
  for (const sessionRole of [MANAGER, OPERATIONS, VOTING]) {
    const result: PermissionsResult = computePermissions(
      sessionRole,
      status,
      BUILT_IN_ROLE_SEED,
    );
    for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
      assert(
        result.can(permission) === false,
        `catalogStatus="${status}": "${mutation}" (${permission}) denied for "${sessionRole}" (fail-closed, no fallback)`,
      );
    }
  }
}

// ---- addPermissionUser: bespoke bootstrap-aware guard ---------------------
// allowed = can("electionDay.manageUsers") || (isBootstrap && rosterStillEmpty)
function addPermissionUserAllowed(
  roleId: string | null,
  isBootstrap: boolean,
  rosterStillEmpty: boolean,
): boolean {
  return can(roleId, "electionDay.manageUsers") || (isBootstrap && rosterStillEmpty);
}

assert(
  addPermissionUserAllowed(MANAGER, false, false) === true,
  "addPermissionUser: manager allowed via real permission, no bootstrap needed",
);
assert(
  addPermissionUserAllowed(OPERATIONS, false, false) === false,
  "addPermissionUser: operations denied (no permission, not bootstrap)",
);
assert(
  addPermissionUserAllowed(VOTING, false, false) === false,
  "addPermissionUser: voting denied (no permission, not bootstrap)",
);
assert(
  addPermissionUserAllowed(NO_SESSION, true, true) === true,
  "addPermissionUser: no session + isBootstrap + roster still empty -> allowed (the one exception)",
);
assert(
  addPermissionUserAllowed(NO_SESSION, true, false) === false,
  "addPermissionUser: no session + isBootstrap but roster NO LONGER empty -> denied (exception self-cancels after first account)",
);
assert(
  addPermissionUserAllowed(NO_SESSION, false, true) === false,
  "addPermissionUser: no session, roster empty, but isBootstrap itself false -> denied",
);
assert(
  addPermissionUserAllowed(NO_SESSION, false, false) === false,
  "addPermissionUser: no session, no bootstrap flag, roster not empty -> denied",
);
// manager already covered by real permission, but confirm bootstrap doesn't
// *also* need to be true for manager - i.e. the OR short-circuits correctly
assert(
  addPermissionUserAllowed(MANAGER, false, true) === true,
  "addPermissionUser: manager allowed regardless of bootstrap state (real permission alone is sufficient)",
);

// ---- deletePermissionUser: NEVER gets a bootstrap exception ---------------
assert(
  can(NO_SESSION, MUTATION_PERMISSIONS.deletePermissionUser) === false,
  "deletePermissionUser: no session denied - bootstrap exception applies ONLY to addPermissionUser, never delete",
);

// ---- resetPermissionUserPassword: plain can() check, NEVER gets a --------
// bootstrap exception either (resetting a password is never needed to stand
// up the very first account - only creating one is).
assert(
  can(MANAGER, MUTATION_PERMISSIONS.resetPermissionUserPassword) === true,
  "resetPermissionUserPassword: manager allowed",
);
assert(
  can(OPERATIONS, MUTATION_PERMISSIONS.resetPermissionUserPassword) === false,
  "resetPermissionUserPassword: operations denied (no manageUsers)",
);
assert(
  can(VOTING, MUTATION_PERMISSIONS.resetPermissionUserPassword) === false,
  "resetPermissionUserPassword: voting denied (no manageUsers)",
);
assert(
  can(NO_SESSION, MUTATION_PERMISSIONS.resetPermissionUserPassword) === false,
  "resetPermissionUserPassword: no session denied - no bootstrap exception, unlike addPermissionUser",
);

// ---- reminder-due effect gate: voter.viewReminderStatus -------------------
assert(
  can(MANAGER, "voter.viewReminderStatus") === true,
  "reminder-due effect: manager can run",
);
assert(
  can(OPERATIONS, "voter.viewReminderStatus") === true,
  "reminder-due effect: operations can run",
);
assert(
  can(VOTING, "voter.viewReminderStatus") === false,
  "reminder-due effect: voting cannot run (would leak name/coordinator via toast)",
);
assert(
  can(NO_SESSION, "voter.viewReminderStatus") === false,
  "reminder-due effect: no session cannot run",
);

if (process.exitCode) {
  console.error("\nsmoke-permission-logic: FAILED");
} else {
  console.log("\nsmoke-permission-logic: all checks passed");
}
