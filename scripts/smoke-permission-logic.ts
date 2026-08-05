/** Stage 3 business-logic-enforcement smoke test - run via: npx esbuild scripts/smoke-permission-logic.ts --bundle --format=cjs --outfile=scripts/smoke-permission-logic.cjs && node scripts/smoke-permission-logic.cjs
 *
 * Pure-logic coverage for `useElectionDay.ts`'s `guardedAction` wiring.
 * `guardedAction` itself can't be imported directly here (it's a closure
 * defined inside the hook, and the hook transitively imports the real
 * Supabase client via `electionDaySession.ts` -> crashes on
 * `import.meta.env` in plain Node - same reason `computePermissions.ts` was
 * split out in Stage 1). Instead this pins the *decision* every guarded
 * mutation makes - `can(permission)`, exactly what `guardedAction` checks -
 * against the real `PERMISSIONS_BY_ROLE` engine, keyed by the exact
 * mutation -> permission mapping as coded in `useElectionDay.ts`. A
 * mismatch here means either the source's permission choice or this pin is
 * wrong - either way worth catching.
 */
import { PERMISSIONS_BY_ROLE } from "../src/permissions/permissionsMap";
import { computePermissions } from "../src/permissions/computePermissions";
import type { EffectiveRole, Permission } from "../src/permissions/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function can(role: EffectiveRole | null, permission: Permission): boolean {
  return role !== null && PERMISSIONS_BY_ROLE[role].has(permission);
}

const MANAGER = computePermissions("manager").role;
const OPERATIONS = computePermissions("user").role; // legacy "user" -> operations
const VOTING: EffectiveRole = "voting"; // not reachable via real login until Stage 4
const NO_SESSION: EffectiveRole | null = null;

// ---- the exact mutation -> permission map as wired in useElectionDay.ts ----
const MUTATION_PERMISSIONS: Record<string, Permission> = {
  setVoted: "voter.markVoted",
  setReminder: "voter.manageReminder",
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
  addRideCoordinator: "electionDay.manageRideCoordinators",
  deleteRideCoordinator: "electionDay.manageRideCoordinators",
};

// ---- manager: every mutation allowed, no exceptions ----------------------
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  assert(can(MANAGER, permission) === true, `manager: "${mutation}" (${permission}) allowed`);
}

// ---- operations: setVoted denied; reminder/ride/phone/notes allowed; -----
// admin mutations (import/clear/export/settings/manageUsers/manageRideCoordinators) denied
const OPERATIONS_ALLOWED = new Set([
  "setReminder",
  "setRideArranged",
  "toggleRideRequested",
  "sendRideRequestToDriver",
  "cancelRideCoordination",
  "setRideCompleted",
  "setPhone",
  "setNotes",
]);
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  const expected = OPERATIONS_ALLOWED.has(mutation);
  assert(
    can(OPERATIONS, permission) === expected,
    `operations: "${mutation}" (${permission}) ${expected ? "allowed" : "denied"}`,
  );
}

// ---- voting: only setVoted allowed, every other mutation denied ----------
for (const [mutation, permission] of Object.entries(MUTATION_PERMISSIONS)) {
  const expected = mutation === "setVoted";
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

// ---- addPermissionUser: bespoke bootstrap-aware guard ---------------------
// allowed = can("electionDay.manageUsers") || (isBootstrap && rosterStillEmpty)
function addPermissionUserAllowed(
  role: EffectiveRole | null,
  isBootstrap: boolean,
  rosterStillEmpty: boolean,
): boolean {
  return can(role, "electionDay.manageUsers") || (isBootstrap && rosterStillEmpty);
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
// (uses the plain MUTATION_PERMISSIONS map, already asserted above for all
// four role states - re-asserted here explicitly against the "what if
// someone tried to bootstrap-exempt a delete" question, since forbidding
// this specifically was an explicit product decision.)
assert(
  can(NO_SESSION, MUTATION_PERMISSIONS.deletePermissionUser) === false,
  "deletePermissionUser: no session denied - bootstrap exception applies ONLY to addPermissionUser, never delete",
);

// ---- reminder-due effect gate: voter.viewReminderStatus -------------------
assert(can(MANAGER, "voter.viewReminderStatus") === true, "reminder-due effect: manager can run");
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

// ---- read-only actions are never blocked in this stage --------------------
// (nothing to assert against the engine - this is a design statement: no
// guardedAction wraps a fetch/list/search/filter function anywhere in
// useElectionDay.ts. Documented here, not mechanically checkable from a
// permission map alone.)

if (process.exitCode) {
  console.error("\nsmoke-permission-logic: FAILED");
} else {
  console.log("\nsmoke-permission-logic: all checks passed");
}
