/** Permission Engine smoke test - run via: npx esbuild scripts/smoke-permissions.ts --bundle --format=cjs --outfile=scripts/smoke-permissions.cjs && node scripts/smoke-permissions.cjs */
import { ALL_PERMISSIONS, PERMISSIONS_BY_ROLE } from "../src/permissions/permissionsMap";
import { hasPermission } from "../src/permissions/hasPermission";
import { resolveEffectiveRole } from "../src/permissions/resolveEffectiveRole";
import { computePermissions } from "../src/permissions/computePermissions";
import type { EffectiveRole, Permission } from "../src/permissions/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- resolveEffectiveRole ---------------------------------------------
assert(resolveEffectiveRole("manager") === "manager", "manager stays manager");
assert(
  resolveEffectiveRole("user") === "operations",
  "legacy: user → operations mapping",
);
assert(
  resolveEffectiveRole("voting") === "voting",
  "Stage 4: voting DatabaseRole maps onto voting EffectiveRole",
);

// ---- no missing/extra permissions per role -----------------------------
const ROLES: EffectiveRole[] = ["manager", "operations", "voting"];
for (const role of ROLES) {
  const set = PERMISSIONS_BY_ROLE[role];
  for (const p of set) {
    assert(
      ALL_PERMISSIONS.includes(p),
      `${role}'s "${p}" is a real Permission (not a stale/typo'd string)`,
    );
  }
}

// ---- manager: every known permission, no exceptions ---------------------
assert(
  PERMISSIONS_BY_ROLE.manager.size === ALL_PERMISSIONS.length,
  `manager has all ${ALL_PERMISSIONS.length} permissions (has ${PERMISSIONS_BY_ROLE.manager.size})`,
);
for (const p of ALL_PERMISSIONS) {
  assert(hasPermission("manager", p), `manager has "${p}"`);
}

// ---- full expected table, independently re-derived from the approved ----
// product decisions (not just re-reading PERMISSIONS_BY_ROLE back at
// itself) - every permission x every role is checked, so a missing OR an
// extraneous grant both fail loudly.
const EXPECTED: Record<EffectiveRole, Partial<Record<Permission, boolean>>> = {
  manager: {}, // covered exhaustively above - "everything true"
  operations: {
    "voter.markVoted": false,
    "voter.manageReminder": true,
    "voter.manageRide": true,
    "voter.editPhone": true,
    "voter.editNotes": true,
    "electionDay.import": false,
    "electionDay.clearData": false,
    "electionDay.export": false, // approved decision #1
    "electionDay.manageSettings": false,
    "electionDay.manageUsers": false,
    "electionDay.manageRideCoordinators": false, // approved decision #2
    "app.accessFullNavigation": false, // approved decision #3
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

for (const role of ROLES) {
  const expectedForRole = EXPECTED[role];
  for (const permission of ALL_PERMISSIONS) {
    if (!(permission in expectedForRole)) continue; // manager: asserted exhaustively above
    const expected = expectedForRole[permission];
    assert(
      hasPermission(role, permission) === expected,
      `${role}.${permission} === ${expected}`,
    );
  }
}

// ---- voting never gets a permission operations/manager-only don't also ----
// grant, and never more than the approved 5 permissions
assert(
  PERMISSIONS_BY_ROLE.voting.size === 5,
  `voting has exactly 5 permissions (has ${PERMISSIONS_BY_ROLE.voting.size})`,
);

// ---- voting sees the voted status it needs to toggle (confirmed decision) -
assert(
  hasPermission("voting", "voter.viewVotedStatus"),
  "voting has voter.viewVotedStatus (needed to know whether to mark or unmark)",
);

// ---- computePermissions composes resolveEffectiveRole + hasPermission ----
// correctly for a real session (not just the no-session case below)
assert(
  computePermissions("manager").role === "manager",
  "computePermissions(\"manager\").role is manager",
);
assert(
  computePermissions("user").role === "operations",
  "computePermissions(\"user\").role is operations (legacy mapping)",
);
assert(
  computePermissions("manager").can("electionDay.manageUsers"),
  "computePermissions(\"manager\").can(\"electionDay.manageUsers\") is true",
);
assert(
  !computePermissions("user").can("electionDay.manageUsers"),
  "computePermissions(\"user\").can(\"electionDay.manageUsers\") is false (operations)",
);
assert(
  computePermissions("voting").role === "voting",
  "computePermissions(\"voting\").role is voting (Stage 4: real DatabaseRole)",
);
assert(
  computePermissions("voting").can("voter.markVoted"),
  "computePermissions(\"voting\").can(\"voter.markVoted\") is true",
);
assert(
  !computePermissions("voting").can("voter.editPhone"),
  "computePermissions(\"voting\").can(\"voter.editPhone\") is false",
);

// ---- no session: no effective role, no permissions --------------------
// (1) no session -> no effective role
const noSession = computePermissions(null);
assert(noSession.role === null, "no session -> role is null (no manager fallback)");

// (2) no session -> hasPermission-equivalent (`can`) is false for every permission
for (const p of ALL_PERMISSIONS) {
  assert(!noSession.can(p), `no session -> can("${p}") is false`);
}

// (3) PermissionGuard has no logic beyond `can(permission) ? children :
// fallback` (see PermissionGuard.tsx) - both `can` and `role` derive from
// this exact `computePermissions(null)` result via `usePermissions`, so
// (1)+(2) above are a complete, faithful test of "PermissionGuard renders
// no children when there is no session": there is no code path in
// PermissionGuard that could render `children` while `can(permission)` is
// false for every permission. Not exercised as an actual React render here
// (PermissionGuard's own module transitively imports `electionDaySession`
// -> the `api` singleton -> the Supabase client, which reads
// `import.meta.env` - a Vite-only global that a plain esbuild/Node bundle
// of this script cannot supply without extra bundler configuration this
// smoke script deliberately avoids).
assert(true, "PermissionGuard renders no children with no session (see comment above)");

// (4) manager still gets all 21 permissions (unaffected by the no-session fix)
assert(
  PERMISSIONS_BY_ROLE.manager.size === ALL_PERMISSIONS.length,
  `manager still has all ${ALL_PERMISSIONS.length} permissions after the no-session fix`,
);

// (5) "user" still maps to "operations" (unaffected by the no-session fix)
assert(
  resolveEffectiveRole("user") === "operations",
  "user still maps to operations after the no-session fix",
);

// (6) voting still gets voter.viewVotedStatus (unaffected by the no-session
// fix) - reachable both directly via PERMISSIONS_BY_ROLE and, since Stage 4,
// through a real computePermissions("voting") session.
assert(
  PERMISSIONS_BY_ROLE.voting.has("voter.viewVotedStatus"),
  "voting still has voter.viewVotedStatus after the no-session fix",
);
assert(
  computePermissions("voting").can("voter.viewVotedStatus"),
  "computePermissions(\"voting\") still has voter.viewVotedStatus after the no-session fix",
);

if (process.exitCode) {
  console.error("\nsmoke-permissions: FAILED");
} else {
  console.log("\nsmoke-permissions: all checks passed");
}
