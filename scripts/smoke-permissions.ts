/** Permission Engine smoke test - run via: npx esbuild scripts/smoke-permissions.ts --bundle --format=cjs --outfile=scripts/smoke-permissions.cjs && node scripts/smoke-permissions.cjs
 *
 * Dynamic Roles & Permissions: the engine has no hardcoded
 * `PERMISSIONS_BY_ROLE`/`EffectiveRole` map - roles are data
 * (`election_day_roles`, fetched via `election_day_list_roles()`), not code.
 * This suite exercises the exact same 3 built-in roles via
 * `BUILT_IN_ROLE_SEED` (mirrored verbatim from the Phase 0 migration's seed -
 * see `scripts/smoke-role-seed-parity.ts` for the drift check) so the truth
 * table below is a faithful regression of the historical pre-dynamic-roles
 * behavior, not a weaker approximation of it.
 */
import { ALL_PERMISSIONS } from "../src/permissions/permissionsMap";
import { hasPermission } from "../src/permissions/hasPermission";
import { resolveSessionRole } from "../src/permissions/resolveSessionRole";
import { computePermissions } from "../src/permissions/computePermissions";
import type { Permission, RoleRecord } from "../src/permissions/types";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// Phase 3: the seed's placeholder ids ("seed-manager"/"seed-user"/
// "seed-voting") are the only stable anchor left - legacyRoleKey is gone.
const roleFor = (id: "seed-manager" | "seed-user" | "seed-voting"): RoleRecord => {
  const role = BUILT_IN_ROLE_SEED.find((r) => r.id === id);
  if (!role) throw new Error(`no seed role for id "${id}"`);
  return role;
};

const MANAGER = roleFor("seed-manager");
const OPERATIONS = roleFor("seed-user"); // "משתמש"/operations role
const VOTING = roleFor("seed-voting");

/** `BUILT_IN_ROLE_SEED` is a frozen mirror of the Phase 0 migration's
 * one-time seed insert (see that file's own doc comment) - `smoke-role-
 * seed-parity.ts` enforces it never drifts from that historical SQL, so it
 * can never be edited to retroactively include a permission introduced
 * after Phase 0 shipped. Permissions are code, roles are data (Dynamic
 * Roles & Permissions Phase 1+) - adding a new permission to `ALL_
 * PERMISSIONS` does NOT itself grant it to any existing role, live or
 * seeded; an admin opts a role into it explicitly via "ניהול תפקידים
 * והרשאות". "manager = every permission" below is therefore checked against
 * every permission that existed AS OF Phase 0, not every permission that
 * will ever exist - this list is exactly the deliberate exceptions. */
const PERMISSIONS_ADDED_AFTER_PHASE_0: readonly Permission[] = [
  "electionDay.manageNonVotingReasons",
];
const PHASE_0_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => !PERMISSIONS_ADDED_AFTER_PHASE_0.includes(p),
);

// ---- resolveSessionRole (matches by roleId, not legacy text) ------------
assert(
  resolveSessionRole("seed-manager", BUILT_IN_ROLE_SEED)?.id === "seed-manager",
  "resolveSessionRole(seed-manager) resolves to the manager row",
);
assert(
  resolveSessionRole("seed-user", BUILT_IN_ROLE_SEED)?.id === "seed-user",
  "resolveSessionRole(seed-user) resolves to the operations ('משתמש') row",
);
assert(
  resolveSessionRole("seed-voting", BUILT_IN_ROLE_SEED)?.id === "seed-voting",
  "resolveSessionRole(seed-voting) resolves to the voting row",
);
assert(
  resolveSessionRole("seed-manager", []) === null,
  "resolveSessionRole against an empty catalog resolves to null (fail-closed, not a guess)",
);
assert(
  resolveSessionRole("some-other-role-id", BUILT_IN_ROLE_SEED) === null,
  "resolveSessionRole against an unmatched roleId resolves to null, never a coincidental match",
);

// ---- no missing/extra permissions per role -----------------------------
const ROLES = [MANAGER, OPERATIONS, VOTING];
for (const role of ROLES) {
  for (const p of role.permissions) {
    assert(
      ALL_PERMISSIONS.includes(p),
      `${role.name}'s "${p}" is a real Permission (not a stale/typo'd string)`,
    );
  }
}

// ---- manager: every permission that existed as of Phase 0 ---------------
assert(
  MANAGER.permissions.length === PHASE_0_PERMISSIONS.length,
  `manager has all ${PHASE_0_PERMISSIONS.length} Phase-0 permissions (has ${MANAGER.permissions.length})`,
);
for (const p of PHASE_0_PERMISSIONS) {
  assert(hasPermission(MANAGER, p), `manager has "${p}"`);
}
// ---- a permission added after Phase 0 is deliberately NOT retrofitted ---
// into the frozen seed (see PERMISSIONS_ADDED_AFTER_PHASE_0's comment) -
// confirms this is an intentional, checked exception, not an oversight.
for (const p of PERMISSIONS_ADDED_AFTER_PHASE_0) {
  assert(
    ALL_PERMISSIONS.includes(p),
    `"${p}" is a real Permission in the catalog`,
  );
  assert(
    !hasPermission(MANAGER, p),
    `seed manager deliberately does NOT have "${p}" (post-Phase-0 addition - opt-in via ניהול תפקידים)`,
  );
}

// ---- full expected table, independently re-derived from the approved ----
// product decisions (not just re-reading the seed back at itself) - every
// permission x every role is checked, so a missing OR an extraneous grant
// both fail loudly.
const EXPECTED: Record<
  "manager" | "operations" | "voting",
  Partial<Record<Permission, boolean>>
> = {
  manager: {}, // covered exhaustively above - "everything true"
  operations: {
    "voter.markVoted": false,
    "voter.manageReminder": true,
    "voter.manageRide": true,
    "voter.editPhone": true,
    "voter.editNotes": true,
    "electionDay.import": false,
    "electionDay.clearData": false,
    "electionDay.export": false,
    "electionDay.manageSettings": false,
    "electionDay.manageUsers": false,
    "electionDay.manageRideCoordinators": false,
    "electionDay.manageRolesAndPermissions": false,
    "app.accessFullNavigation": false,
    "voter.viewName": true,
    "voter.viewAddress": true,
    "voter.viewPhone": true,
    "voter.viewMasad": true,
    "voter.viewCoordinator": true,
    "voter.viewNotes": true,
    "voter.viewReminderStatus": true,
    "voter.viewRideStatus": true,
    "voter.viewVotedStatus": true,
  },
  voting: {
    "voter.markVoted": true,
    "voter.manageReminder": false,
    "voter.manageRide": false,
    "voter.editPhone": false,
    "voter.editNotes": false,
    "electionDay.import": false,
    "electionDay.clearData": false,
    "electionDay.export": false,
    "electionDay.manageSettings": false,
    "electionDay.manageUsers": false,
    "electionDay.manageRideCoordinators": false,
    "electionDay.manageRolesAndPermissions": false,
    "app.accessFullNavigation": false,
    "voter.viewName": true,
    "voter.viewAddress": true,
    "voter.viewPhone": true,
    "voter.viewMasad": false,
    "voter.viewCoordinator": false,
    "voter.viewNotes": false,
    "voter.viewReminderStatus": false,
    "voter.viewRideStatus": false,
    "voter.viewVotedStatus": true,
  },
};

const ROLE_BY_LABEL: Record<"manager" | "operations" | "voting", RoleRecord> = {
  manager: MANAGER,
  operations: OPERATIONS,
  voting: VOTING,
};
for (const label of ["manager", "operations", "voting"] as const) {
  const role = ROLE_BY_LABEL[label];
  const expectedForRole = EXPECTED[label];
  for (const permission of ALL_PERMISSIONS) {
    if (!(permission in expectedForRole)) continue; // manager: asserted exhaustively above
    const expected = expectedForRole[permission];
    assert(
      hasPermission(role, permission) === expected,
      `${label}.${permission} === ${expected}`,
    );
  }
}

// ---- voting never gets a permission operations/manager-only don't also ----
// grant, and never more than the approved 5 permissions
assert(
  VOTING.permissions.length === 5,
  `voting has exactly 5 permissions (has ${VOTING.permissions.length})`,
);
assert(
  hasPermission(VOTING, "voter.viewVotedStatus"),
  "voting has voter.viewVotedStatus (needed to know whether to mark or unmark)",
);

// ---- computePermissions composes resolveSessionRole + hasPermission -----
// correctly for a real, loaded session (keyed by roleId)
assert(
  computePermissions("seed-manager", "loaded", BUILT_IN_ROLE_SEED).role?.id ===
    "seed-manager",
  'computePermissions("seed-manager", "loaded", seed).role.id is "seed-manager"',
);
assert(
  computePermissions("seed-user", "loaded", BUILT_IN_ROLE_SEED).role?.id === "seed-user",
  'computePermissions("seed-user", "loaded", seed).role.id is "seed-user"',
);
assert(
  computePermissions("seed-manager", "loaded", BUILT_IN_ROLE_SEED).can(
    "electionDay.manageUsers",
  ),
  'computePermissions("seed-manager", "loaded", seed).can("electionDay.manageUsers") is true',
);
assert(
  !computePermissions("seed-user", "loaded", BUILT_IN_ROLE_SEED).can(
    "electionDay.manageUsers",
  ),
  'computePermissions("seed-user", "loaded", seed).can("electionDay.manageUsers") is false (operations)',
);
assert(
  computePermissions("seed-voting", "loaded", BUILT_IN_ROLE_SEED).can("voter.markVoted"),
  'computePermissions("seed-voting", "loaded", seed).can("voter.markVoted") is true',
);
assert(
  !computePermissions("seed-voting", "loaded", BUILT_IN_ROLE_SEED).can("voter.editPhone"),
  'computePermissions("seed-voting", "loaded", seed).can("voter.editPhone") is false',
);

// ---- no session: no effective role, no permissions --------------------
const noSession = computePermissions(null, "loaded", BUILT_IN_ROLE_SEED);
assert(noSession.role === null, "no session -> role is null (no manager fallback)");
for (const p of ALL_PERMISSIONS) {
  assert(!noSession.can(p), `no session -> can("${p}") is false`);
}

// ---- Dynamic Roles & Permissions fail-closed contract (Phase 1) ---------
// catalog not "loaded" (idle/loading/error) -> role null, every permission
// denied, regardless of an otherwise-valid session role.
for (const status of ["idle", "loading", "error"] as const) {
  const result = computePermissions("seed-manager", status, BUILT_IN_ROLE_SEED);
  assert(
    result.role === null,
    `catalogStatus="${status}" -> role is null even for a real "manager" session (fail-closed)`,
  );
  for (const p of ALL_PERMISSIONS) {
    assert(
      !result.can(p),
      `catalogStatus="${status}" -> can("${p}") is false for "manager" (no fallback)`,
    );
  }
}

// unmatched roleId against a loaded-but-unrelated catalog -> null
assert(
  computePermissions("seed-manager", "loaded", []).role === null,
  "loaded but empty catalog -> unmatched roleId resolves to null (fail-closed, not a guess)",
);
for (const p of ALL_PERMISSIONS) {
  assert(
    !computePermissions("seed-manager", "loaded", []).can(p),
    `loaded-but-empty catalog -> can("${p}") is false for "manager"`,
  );
}

// ---- manager still gets every Phase-0 permission (unaffected by the -----
// fail-closed contract when the catalog IS loaded correctly)
assert(
  MANAGER.permissions.length === PHASE_0_PERMISSIONS.length,
  `manager still has all ${PHASE_0_PERMISSIONS.length} Phase-0 permissions`,
);

// ---- Dynamic Roles & Permissions, Phase 0/1: manageRolesAndPermissions --
assert(
  ALL_PERMISSIONS.includes("electionDay.manageRolesAndPermissions"),
  "electionDay.manageRolesAndPermissions is a real Permission in the catalog",
);
assert(
  hasPermission(MANAGER, "electionDay.manageRolesAndPermissions"),
  "manager has electionDay.manageRolesAndPermissions (manager = every permission)",
);
assert(
  !hasPermission(OPERATIONS, "electionDay.manageRolesAndPermissions"),
  "operations does not have electionDay.manageRolesAndPermissions",
);
assert(
  !hasPermission(VOTING, "electionDay.manageRolesAndPermissions"),
  "voting does not have electionDay.manageRolesAndPermissions",
);

if (process.exitCode) {
  console.error("\nsmoke-permissions: FAILED");
} else {
  console.log("\nsmoke-permissions: all checks passed");
}
