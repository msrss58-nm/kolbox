/** Stage 2 UI-permission-wiring smoke test - run via: npx esbuild scripts/smoke-permission-ui.ts --bundle --format=cjs --outfile=scripts/smoke-permission-ui.cjs && node scripts/smoke-permission-ui.cjs
 *
 * Covers what a plain-Node script *can* honestly verify without a React
 * renderer (see smoke-permissions.ts's precedent and rationale):
 * - the ELECTION_DAY_ROW_COLUMNS projection every role resolves to, most
 *   importantly the "voting" role - which cannot log in for real yet (no
 *   DatabaseRole maps to it), so this is voting's only exercisable check
 *   until the Stage 4 migration.
 * - AppLayout's `restrictedToElectionDay` expression, pinned here so a
 *   future edit that accidentally drops the "session must be present"
 *   guard is caught immediately (dropping it would lock every ordinary
 *   main-app user, who never touched /election-day, out of navigation -
 *   the exact regression this expression exists to prevent).
 */
import { PERMISSIONS_BY_ROLE } from "../src/permissions/permissionsMap";
import { computePermissions } from "../src/permissions/computePermissions";
import { ELECTION_DAY_ROW_COLUMNS } from "../src/features/election-day/electionDayRowColumns";
import type { EffectiveRole } from "../src/permissions/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const visibleColumnKeys = (role: EffectiveRole) =>
  ELECTION_DAY_ROW_COLUMNS.filter((c) => PERMISSIONS_BY_ROLE[role].has(c.permission)).map(
    (c) => c.key,
  );

// ---- column projection: manager sees every column ----------------------
assert(
  visibleColumnKeys("manager").length === ELECTION_DAY_ROW_COLUMNS.length,
  `manager sees all ${ELECTION_DAY_ROW_COLUMNS.length} row columns`,
);

// ---- column projection: operations sees every column too (approved: -----
// "operations ... רואה את כל השדות התפעוליים")
assert(
  visibleColumnKeys("operations").length === ELECTION_DAY_ROW_COLUMNS.length,
  `operations sees all ${ELECTION_DAY_ROW_COLUMNS.length} row columns`,
);

// ---- column projection: voting sees exactly the approved 6 columns -----
// (name, street, houseNumber, city, phone, status) and none of the 3
// operational-only ones (masad, coordinator, notes)
const votingColumns = visibleColumnKeys("voting");
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
function restrictedToElectionDay(
  sessionPresent: boolean,
  role: EffectiveRole | null,
): boolean {
  return sessionPresent && !(role !== null && PERMISSIONS_BY_ROLE[role].has("app.accessFullNavigation"));
}

// no Election Day session at all (the ordinary main-app case) -> never restricted
assert(
  restrictedToElectionDay(false, null) === false,
  "no election-day session -> main-app nav is never restricted",
);

// a real manager session -> full nav
assert(
  restrictedToElectionDay(true, computePermissions("manager").role) === false,
  "manager session -> main-app nav not restricted",
);

// a real "user" (-> operations) session -> restricted to Election Day
assert(
  restrictedToElectionDay(true, computePermissions("user").role) === true,
  "operations (legacy user) session -> main-app nav restricted to Election Day",
);

// a hypothetical voting session (not reachable via real login until Stage 4)
// -> also restricted, pinning the intended future behavior
assert(
  restrictedToElectionDay(true, "voting") === true,
  "voting session (mock role, not yet real) -> main-app nav restricted to Election Day",
);

if (process.exitCode) {
  console.error("\nsmoke-permission-ui: FAILED");
} else {
  console.log("\nsmoke-permission-ui: all checks passed");
}
