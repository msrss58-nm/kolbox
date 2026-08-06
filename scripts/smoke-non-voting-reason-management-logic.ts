/** Dynamic Non-Voting Reasons - pure-logic coverage, mirroring
 * `smoke-role-management-logic.ts`'s precedent: pins the exact permission
 * every catalog-management mutation requires - `electionDay.
 * manageNonVotingReasons` - against the real engine (`computePermissions` +
 * `BUILT_IN_ROLE_SEED`), and confirms `setNonVotingReason` (a voter-level
 * mutation, distinct from catalog management) rides on `voter.markVoted`
 * instead - the product decision that there is no separate view/edit
 * permission for the reason itself. Also a pinned copy of
 * `supabaseElectionDayApi.ts`'s `mapNonVotingReasonRpcErrorMessage` (can't
 * import the real module directly - it pulls in the Supabase client, which
 * crashes on `import.meta.env` in plain Node).
 *
 * Run via: npx esbuild scripts/smoke-non-voting-reason-management-logic.ts --bundle --format=cjs --outfile=scripts/smoke-non-voting-reason-management-logic.cjs && node scripts/smoke-non-voting-reason-management-logic.cjs
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

// ---- every catalog-management mutation requires the same single ---------
// permission - and (product decision) the seed manager fixture deliberately
// does NOT have it yet (see smoke-permissions.ts's PERMISSIONS_ADDED_AFTER_
// PHASE_0) - a brand-new permission is never auto-granted to any existing
// role, including the historical seed; an admin opts in via "ניהול תפקידים".
const CATALOG_MUTATIONS = [
  "createNonVotingReason",
  "updateNonVotingReason",
  "setNonVotingReasonActive",
  "deleteNonVotingReason",
  "reorderNonVotingReasons",
] as const;
const CATALOG_PERMISSION: Permission = "electionDay.manageNonVotingReasons";

for (const mutation of CATALOG_MUTATIONS) {
  assert(
    can(MANAGER, CATALOG_PERMISSION) === false,
    `${mutation}: seed manager fixture denied (permission not yet opted into the frozen Phase-0 seed - real live roles opt in via ניהול תפקידים)`,
  );
  assert(can(OPERATIONS, CATALOG_PERMISSION) === false, `${mutation}: operations denied`);
  assert(can(VOTING, CATALOG_PERMISSION) === false, `${mutation}: voting denied`);
  assert(can(NO_SESSION, CATALOG_PERMISSION) === false, `${mutation}: no session denied`);
}

// ---- fail-closed: catalog not loaded denies catalog management for every -
// role, same fail-closed contract as every other permission
for (const status of ["idle", "loading", "error"] as const) {
  for (const roleId of [MANAGER, OPERATIONS, VOTING]) {
    const result = computePermissions(roleId, status, BUILT_IN_ROLE_SEED);
    assert(
      result.can(CATALOG_PERMISSION) === false,
      `catalogStatus="${status}": non-voting-reason management denied for "${roleId}" (fail-closed, no fallback)`,
    );
  }
}

// ---- setNonVotingReason rides on voter.markVoted, NOT a separate --------
// permission (product decision: "anyone who sees a voter can also see the
// reason" - and editing rides on the same control that already requires
// voter.markVoted, the mark/unmark-voted toggle itself).
const SET_REASON_PERMISSION: Permission = "voter.markVoted";
assert(
  can(MANAGER, SET_REASON_PERMISSION) === true,
  "setNonVotingReason: manager allowed (has voter.markVoted)",
);
assert(
  can(VOTING, SET_REASON_PERMISSION) === true,
  "setNonVotingReason: voting allowed (has voter.markVoted)",
);
assert(
  can(OPERATIONS, SET_REASON_PERMISSION) === false,
  "setNonVotingReason: operations denied (no voter.markVoted - matches it can't mark voted either)",
);
assert(
  can(NO_SESSION, SET_REASON_PERMISSION) === false,
  "setNonVotingReason: no session denied",
);

// ---- pinned copy of supabaseElectionDayApi.ts's -------------------------
// mapNonVotingReasonRpcErrorMessage (re-implemented, not imported - same
// Supabase-client-import reason as smoke-role-management-logic.ts).
function mapNonVotingReasonRpcErrorMessage(message: string): string {
  if (message.includes("REASON_IN_USE")) {
    return "לא ניתן למחוק סיבה המשויכת לבוחרים";
  }
  if (message.includes("REASON_NOT_FOUND")) {
    return "הסיבה לא נמצאה - ייתכן שנמחקה על ידי משתמש אחר";
  }
  if (message.includes("REASON_NAME_REQUIRED")) {
    return "יש להזין שם לסיבה";
  }
  if (message.includes("REORDER_ID_MISMATCH")) {
    return "רשימת הסידור אינה תואמת את רשימת הסיבות הקיימת - רעננו ונסו שוב";
  }
  if (
    message.includes("election_day_not_voting_reasons_name_key") ||
    message.includes("duplicate key")
  ) {
    return "כבר קיימת סיבה בשם זה";
  }
  return message;
}

assert(
  mapNonVotingReasonRpcErrorMessage("REASON_IN_USE") ===
    "לא ניתן למחוק סיבה המשויכת לבוחרים",
  "mapNonVotingReasonRpcErrorMessage: REASON_IN_USE maps to a clear Hebrew message",
);
assert(
  mapNonVotingReasonRpcErrorMessage("REASON_NOT_FOUND") ===
    "הסיבה לא נמצאה - ייתכן שנמחקה על ידי משתמש אחר",
  "mapNonVotingReasonRpcErrorMessage: REASON_NOT_FOUND maps to a clear Hebrew message",
);
assert(
  mapNonVotingReasonRpcErrorMessage("REASON_NAME_REQUIRED") === "יש להזין שם לסיבה",
  "mapNonVotingReasonRpcErrorMessage: REASON_NAME_REQUIRED maps to a clear Hebrew message",
);
assert(
  mapNonVotingReasonRpcErrorMessage("REORDER_ID_MISMATCH") ===
    "רשימת הסידור אינה תואמת את רשימת הסיבות הקיימת - רעננו ונסו שוב",
  "mapNonVotingReasonRpcErrorMessage: REORDER_ID_MISMATCH maps to a clear Hebrew message",
);
assert(
  mapNonVotingReasonRpcErrorMessage(
    'duplicate key value violates unique constraint "election_day_not_voting_reasons_name_key"',
  ) === "כבר קיימת סיבה בשם זה",
  "mapNonVotingReasonRpcErrorMessage: a name-uniqueness violation maps to a clear Hebrew message",
);
assert(
  mapNonVotingReasonRpcErrorMessage("some unrelated raw Postgres error") ===
    "some unrelated raw Postgres error",
  "mapNonVotingReasonRpcErrorMessage: an unrecognized message passes through unchanged (never swallowed)",
);

if (process.exitCode) {
  console.error("\nsmoke-non-voting-reason-management-logic: FAILED");
} else {
  console.log("\nsmoke-non-voting-reason-management-logic: all checks passed");
}
