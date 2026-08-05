/** Dynamic Roles & Permissions Phase 1 - scopedContacts fail-closed smoke
 * test. Run via: npx esbuild scripts/smoke-election-day-scope.ts --bundle --format=cjs --outfile=scripts/smoke-election-day-scope.cjs && node scripts/smoke-election-day-scope.cjs
 *
 * `resolveVisibleContacts` (`src/features/election-day/electionDayScope.ts`)
 * is the single choke point `useElectionDay.ts`'s `scopedContacts` reads
 * through. This suite is the direct regression test for the security fix
 * this phase's plan required: a `role=null`/loading/error/unrecognized-scope
 * state must return `[]`, never fall back to the unfiltered contact list.
 */
import { resolveVisibleContacts } from "../src/features/election-day/electionDayScope";
import type { RoleRecord } from "../src/permissions/types";
import type { ElectionDayVoter } from "../src/types";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

function makeContact(id: string, coordinator: string): ElectionDayVoter {
  return {
    id,
    masad: "1",
    firstName: "שם",
    lastName: "משפחה",
    street: "רחוב",
    houseNumber: 1,
    city: "עיר",
    phone: null,
    coordinator,
    notes: "",
    rideRequested: false,
    rideRequestedAt: null,
    rideArranged: false,
    rideArrangedAt: null,
    rideCompleted: false,
    rideCompletedAt: null,
    reminderAt: null,
    voted: false,
    votedAt: null,
  };
}

const CONTACTS = [makeContact("1", "אבי"), makeContact("2", "אבי"), makeContact("3", "אלי")];
const SESSION_AVI = { name: "אבי" };

const ROLE_ALL: RoleRecord = {
  id: "r1",
  name: "מנהל",
  description: "",
  permissions: [],
  scopeType: "all",
  scopeValue: null,
  legacyRoleKey: "manager",
};
const ROLE_ASSIGNED: RoleRecord = {
  id: "r2",
  name: "משתמש",
  description: "",
  permissions: [],
  scopeType: "assigned_to_me",
  scopeValue: null,
  legacyRoleKey: "user",
};
const ROLE_UNKNOWN_SCOPE: RoleRecord = {
  id: "r3",
  name: "תפקיד תקול",
  description: "",
  permissions: [],
  scopeType: null, // as normalizeRoleRecord would produce for an unrecognized/missing scope_type
  scopeValue: null,
  legacyRoleKey: null,
};

// ---- contacts list itself still loading - unrelated to roles -----------
assert(
  resolveVisibleContacts(null, SESSION_AVI, "loaded", ROLE_ALL) === null,
  "contacts still null (list itself loading) -> null, regardless of role",
);

// ---- no Election Day session at all - pre-existing bootstrap window, ----
// unchanged by this phase, NOT part of the fail-open bug being fixed
assert(
  resolveVisibleContacts(CONTACTS, null, "loaded", null)?.length === CONTACTS.length,
  "no session at all -> unfiltered (pre-existing bootstrap behavior, unchanged)",
);
assert(
  resolveVisibleContacts(CONTACTS, null, "idle", null)?.length === CONTACTS.length,
  "no session at all, catalog idle -> still unfiltered (bootstrap window doesn't depend on the catalog)",
);

// ---- THE FIX: catalog not loaded, but a session DOES exist -> [] --------
for (const status of ["idle", "loading", "error"] as const) {
  const result = resolveVisibleContacts(CONTACTS, SESSION_AVI, status, null);
  assert(
    Array.isArray(result) && result.length === 0,
    `catalogStatus="${status}" with a real session -> [] (fail-closed, not the unfiltered list)`,
  );
}

// ---- THE FIX: catalog loaded, but session's role never resolved (null) -- -> []
assert(
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", null)?.length === 0,
  "loaded catalog but unresolved role (unknown legacy_role_key) -> [] (fail-closed)",
);

// ---- THE FIX: resolved role with unrecognized/missing scopeType -> [] ----
assert(
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", ROLE_UNKNOWN_SCOPE)?.length === 0,
  "resolved role with scopeType=null (unrecognized/missing) -> [] (fail-closed)",
);

// ---- correct, positive behavior: scopeType "all" sees everything --------
assert(
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", ROLE_ALL)?.length === CONTACTS.length,
  'manager-equivalent role (scopeType "all"), catalog loaded -> sees every contact',
);

// ---- correct, positive behavior: scopeType "assigned_to_me" scopes down --
const scoped = resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", ROLE_ASSIGNED);
assert(
  scoped?.length === 2 && scoped.every((c) => c.coordinator === "אבי"),
  'operations/voting-equivalent role (scopeType "assigned_to_me") sees only own-coordinator contacts',
);

// ---- never a manager-equivalent fallback in any failure state -----------
// (explicit negative assertion: none of the failure states above ever
// returned the full CONTACTS list - re-confirmed here as one combined check)
const failureResults = [
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "idle", null),
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loading", null),
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "error", null),
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", null),
  resolveVisibleContacts(CONTACTS, SESSION_AVI, "loaded", ROLE_UNKNOWN_SCOPE),
];
assert(
  failureResults.every((r) => Array.isArray(r) && r.length === 0),
  "no failure/unresolved state ever returns the unfiltered contact list - zero manager-equivalent fallback",
);

if (process.exitCode) {
  console.error("\nsmoke-election-day-scope: FAILED");
} else {
  console.log("\nsmoke-election-day-scope: all checks passed");
}
