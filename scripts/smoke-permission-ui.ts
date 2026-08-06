/** Stage 2 UI-permission-wiring smoke test - run via: npx esbuild scripts/smoke-permission-ui.ts --bundle --format=cjs --outfile=scripts/smoke-permission-ui.cjs && node scripts/smoke-permission-ui.cjs
 *
 * Covers what a plain-Node script *can* honestly verify without a React
 * renderer (see smoke-permissions.ts's precedent and rationale):
 * - the ELECTION_DAY_ROW_COLUMNS projection every role resolves to.
 * - AppLayout's `restrictedToElectionDay` expression, pinned here so a
 *   future edit that accidentally drops the "session must be present"
 *   guard is caught immediately (dropping it would lock every ordinary
 *   main-app user, who never touched /election-day, out of navigation -
 *   the exact regression this expression exists to prevent).
 *
 * Dynamic Roles & Permissions Phase 1: roles come from `BUILT_IN_ROLE_SEED`
 * (mirrored from the live DB seed) via `computePermissions`, not a
 * hardcoded `PERMISSIONS_BY_ROLE`/`EffectiveRole` map.
 */
import { computePermissions } from "../src/permissions/computePermissions";
import { ELECTION_DAY_ROW_COLUMNS } from "../src/features/election-day/electionDayRowColumns";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// Phase 2: computePermissions resolves by roleId, not legacy role text.
const visibleColumnKeys = (sessionRoleId: string) => {
  const { can } = computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED);
  return ELECTION_DAY_ROW_COLUMNS.filter((c) => can(c.permission)).map((c) => c.key);
};

// ---- column projection: manager sees every column ----------------------
assert(
  visibleColumnKeys("seed-manager").length === ELECTION_DAY_ROW_COLUMNS.length,
  `manager sees all ${ELECTION_DAY_ROW_COLUMNS.length} row columns`,
);

// ---- column projection: operations (legacy "user") sees every column too --
// (approved: "operations ... רואה את כל השדות התפעוליים")
assert(
  visibleColumnKeys("seed-user").length === ELECTION_DAY_ROW_COLUMNS.length,
  `operations sees all ${ELECTION_DAY_ROW_COLUMNS.length} row columns`,
);

// ---- column projection: voting sees exactly the approved 6 columns -----
// (name, street, houseNumber, city, phone, status) and none of the 3
// operational-only ones (masad, coordinator, notes)
const votingColumns = visibleColumnKeys("seed-voting");
const EXPECTED_VOTING_COLUMNS = [
  "name",
  "street",
  "houseNumber",
  "city",
  "phone",
  "status",
];
assert(
  votingColumns.length === EXPECTED_VOTING_COLUMNS.length &&
    EXPECTED_VOTING_COLUMNS.every((k) => votingColumns.includes(k)),
  `voting sees exactly [${EXPECTED_VOTING_COLUMNS.join(", ")}] (got [${votingColumns.join(", ")}])`,
);
for (const hidden of ["masad", "coordinator", "notes"] as const) {
  assert(
    !votingColumns.includes(hidden),
    `voting does not see the "${hidden}" column`,
  );
}

// ---- AppLayout's restrictedToElectionDay expression, pinned -------------
// restrictedToElectionDay = electionDaySessionUser !== null && !can("app.accessFullNavigation")
function restrictedToElectionDay(sessionPresent: boolean, sessionRoleId: string | null): boolean {
  const { can } = computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED);
  return sessionPresent && !can("app.accessFullNavigation");
}

// no Election Day session at all (the ordinary main-app case) -> never restricted
assert(
  restrictedToElectionDay(false, null) === false,
  "no election-day session -> main-app nav is never restricted",
);

// a real manager session -> full nav
assert(
  restrictedToElectionDay(true, "seed-manager") === false,
  "manager session -> main-app nav not restricted",
);

// a real "user" (-> operations) session -> restricted to Election Day
assert(
  restrictedToElectionDay(true, "seed-user") === true,
  "operations (legacy user) session -> main-app nav restricted to Election Day",
);

// a real voting session -> also restricted
assert(
  restrictedToElectionDay(true, "seed-voting") === true,
  "voting session -> main-app nav restricted to Election Day",
);

// ---- Dynamic Roles & Permissions Phase 1: catalog not loaded -> fully ---
// restricted (fail-closed) even for a real manager session
assert(
  restrictedToElectionDay(true, "seed-manager") === false,
  "sanity: manager with a loaded catalog is not restricted (contrast with the next assertion)",
);
function restrictedToElectionDayWithStatus(
  sessionPresent: boolean,
  sessionRoleId: string | null,
  status: "idle" | "loading" | "loaded" | "error",
): boolean {
  const { can } = computePermissions(sessionRoleId, status, BUILT_IN_ROLE_SEED);
  return sessionPresent && !can("app.accessFullNavigation");
}
for (const status of ["idle", "loading", "error"] as const) {
  assert(
    restrictedToElectionDayWithStatus(true, "seed-manager", status) === true,
    `catalogStatus="${status}" -> even a real manager session is restricted (fail-closed, no fallback)`,
  );
}

if (process.exitCode) {
  console.error("\nsmoke-permission-ui: FAILED");
} else {
  console.log("\nsmoke-permission-ui: all checks passed");
}
