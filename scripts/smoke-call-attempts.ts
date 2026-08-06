/** Call Attempts Counter - smoke test. Run via: npx esbuild scripts/smoke-call-attempts.ts --bundle --format=cjs --outfile=scripts/smoke-call-attempts.cjs && node scripts/smoke-call-attempts.cjs
 *
 * Covers the two things that live outside the DB/RPC round trip and are
 * therefore worth pinning here: the counter's text formatting/dialog copy
 * (`ELECTION_DAY_TEXT.callAttempts`), and the permission-gated
 * `canCloseAsNoAnswer` derivation (`showVotedToggle` in
 * `ElectionDayContactModal.tsx`, i.e. `can("voter.markVoted")`) across the 3
 * built-in roles - "operations" must NOT see "close as לא עונה" (it can call
 * but not mark voted/set a reason), "manager"/"voting" must see it.
 * `voter.viewPhone` (gates the call button + counter, and both new RPCs'
 * `guardedAction`) is asserted the same way via smoke-permission-logic.ts's
 * MUTATION_PERMISSIONS map (incrementCallAttempts/extendCallAttemptsThreshold)
 * - not duplicated here.
 */
import {
  computePermissions,
} from "../src/permissions/computePermissions";
import { ELECTION_DAY_TEXT } from "../src/features/election-day/election-day.constants";
import { BUILT_IN_ROLE_SEED } from "./fixtures/electionDayRoles";

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

const text = ELECTION_DAY_TEXT.callAttempts;

// ---- counter formatting ----------------------------------------------------
assert(text.count(0, 3) === "0/3", 'count(0, 3) === "0/3" (initial state)');
assert(text.count(1, 3) === "1/3", 'count(1, 3) === "1/3"');
assert(text.count(3, 3) === "3/3", 'count(3, 3) === "3/3" (checkpoint - dialog opens)');
assert(
  text.count(3, 6) === "3/6",
  'count(3, 6) === "3/6" (threshold just extended by "continue", no new click yet - matches the product spec\'s worked example)',
);
assert(text.count(6, 6) === "6/6", 'count(6, 6) === "6/6" (second checkpoint)');
assert(text.count(6, 9) === "6/9", 'count(6, 9) === "6/9" (second extension)');

// ---- the reason-name key this feature closes a voter with must match the --
// real seeded catalog row's name exactly, or "close as לא עונה" would silently
// no-op (the .find() in ElectionDayContactModal.tsx would never match).
assert(
  text.noAnswerReasonName === "לא עונה",
  'noAnswerReasonName === "לא עונה" (must match the seeded election_day_not_voting_reasons row exactly)',
);

// ---- dialog copy is static/non-parameterized by the actual threshold ------
// (every checkpoint represents exactly 3 NEW attempts since the last one,
// so "שלושה"/"3" stays literally correct at 3/3, 6/6, 9/9, ...)
assert(
  text.dialogTitle === "בוצעו 3 ניסיונות חיוג",
  "dialogTitle is the fixed, non-parameterized product-spec string",
);
assert(
  text.dialogBody("רחל אברמוביץ").includes("רחל אברמוביץ") &&
    text.dialogBody("רחל אברמוביץ").includes("שלושה") &&
    text.dialogBody("דני כהן").includes("דני כהן") &&
    !text.dialogBody("דני כהן").includes("רחל"),
  "dialogBody interpolates the given voter name fresh each call, body text otherwise fixed",
);

// ---- canCloseAsNoAnswer (== can("voter.markVoted")) across the 3 built-in --
// roles - must match ElectionDayContactModal.tsx's `showVotedToggle`, which
// is what CallAttemptsDialog's `canCloseAsNoAnswer` prop is wired to.
function canMarkVoted(sessionRoleId: string | null): boolean {
  return computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED).can("voter.markVoted");
}

assert(canMarkVoted("seed-manager") === true, 'manager: canCloseAsNoAnswer === true');
assert(
  canMarkVoted("seed-user") === false,
  'operations ("משתמש"): canCloseAsNoAnswer === false (can call, cannot mark voted/set a reason - dialog must hide the button, "continue" stays the only option)',
);
assert(canMarkVoted("seed-voting") === true, 'voting ("נציג קלפי"): canCloseAsNoAnswer === true');
assert(canMarkVoted(null) === false, "no session: canCloseAsNoAnswer === false");

if (process.exitCode) {
  console.error("\nsmoke-call-attempts: FAILED");
} else {
  console.log("\nsmoke-call-attempts: all checks passed");
}
