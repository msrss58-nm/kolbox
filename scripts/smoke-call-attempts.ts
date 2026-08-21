/** Call Outcome Tracking - smoke test. Run via: npx esbuild scripts/smoke-call-attempts.ts --bundle --format=cjs --outfile=scripts/smoke-call-attempts.cjs && node scripts/smoke-call-attempts.cjs
 *
 * Covers the things that live outside the DB/RPC round trip and are
 * therefore worth pinning here: the streak's text formatting/dialog copy
 * (`ELECTION_DAY_TEXT.callAttempts`, now parameterized by `isFinal` at the
 * capped 6th checkpoint), and the permission-gated `canCloseAsNoAnswer`
 * derivation (`ElectionDayContactModal.tsx`'s `showCall`, i.e.
 * `can("voter.viewPhone")` - the 6/6 Final No-Answer Permission Boundary fix:
 * finishing an exhausted call is call-handling, not voting, so it rides on
 * the same permission as dialing/recording outcomes, not `voter.markVoted`)
 * across the 3 built-in roles - "operations" (can call, cannot mark voted)
 * MUST now see "close as לא עונה" too; only a role with no calling access at
 * all wouldn't. `voter.markVoted` itself is asserted separately below to
 * confirm this fix did NOT broaden it - "operations" must still be `false`.
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

// ---- streak/threshold formatting (noAnswerStreak/noAnswerStreakThreshold, --
// NOT the total dial count - see totalCount below for that) --------------
assert(text.count(0, 3) === "0/3", 'count(0, 3) === "0/3" (initial state)');
assert(text.count(1, 3) === "1/3", 'count(1, 3) === "1/3"');
assert(text.count(3, 3) === "3/3", 'count(3, 3) === "3/3" (checkpoint - dialog opens)');
assert(
  text.count(3, 6) === "3/6",
  'count(3, 6) === "3/6" (threshold just extended by "continue", no new click yet)',
);
assert(text.count(6, 6) === "6/6", 'count(6, 6) === "6/6" (capped checkpoint - no further extend)');

// ---- total dial count (callAttempts) is a SEPARATE, uncapped figure - -----
// never conflated with the noAnswerStreak/threshold badge above.
assert(
  text.totalCount(0) === 'סה"כ חיוגים: 0',
  'totalCount(0) - shown only while no outcome is pending',
);
assert(text.totalCount(11) === 'סה"כ חיוגים: 11', "totalCount(11) - uncapped, unlike the streak");

// ---- outcome button labels --------------------------------------------
assert(text.noAnswerButton === "לא ענה", 'noAnswerButton === "לא ענה"');
assert(text.answeredButton === "ענה", 'answeredButton === "ענה"');

// ---- the reason-name key this feature closes a voter with must match the --
// real seeded catalog row's name exactly, or "close as לא עונה" would silently
// no-op (the .find() in ElectionDayContactModal.tsx would never match).
assert(
  text.noAnswerReasonName === "לא עונה",
  'noAnswerReasonName === "לא עונה" (must match the seeded election_day_not_voting_reasons row exactly)',
);

// ---- dialog copy is parameterized by isFinal (the capped 6th checkpoint) --
// the 3rd checkpoint still offers "keep trying (+3)"; the 6th (capped, no
// further extension) does not, and its copy says so.
assert(
  text.dialogTitle(false) === "בוצעו 3 ניסיונות חיוג ללא מענה",
  "dialogTitle(false) - the first (3rd-attempt) checkpoint",
);
assert(
  text.dialogTitle(true) === "בוצעו 6 ניסיונות חיוג ללא מענה",
  "dialogTitle(true) - the capped (6th-attempt) checkpoint",
);
assert(
  text.dialogBody("רחל אברמוביץ", false).includes("רחל אברמוביץ") &&
    text.dialogBody("רחל אברמוביץ", false).includes("שלושה") &&
    text.dialogBody("דני כהן", false).includes("דני כהן") &&
    !text.dialogBody("דני כהן", false).includes("רחל"),
  "dialogBody(name, false) interpolates the given voter name fresh each call, body text otherwise fixed",
);
assert(
  text.dialogBody("רחל אברמוביץ", true).includes("שישה") &&
    text.dialogBody("רחל אברמוביץ", true).includes("לא ניתן להאריך"),
  "dialogBody(name, true) says six attempts and that no further extension is offered",
);
assert(
  text.dialogBodyNoPermission("רחל אברמוביץ").includes("רחל אברמוביץ"),
  "dialogBodyNoPermission interpolates the voter name (the no-action-button fallback case)",
);

// ---- canCloseAsNoAnswer (== can("voter.viewPhone")) across the 3 built-in --
// roles - must match ElectionDayContactModal.tsx's `showCall`, which is what
// CallAttemptsDialog's `canCloseAsNoAnswer` prop is now wired to (the 6/6
// Final No-Answer Permission Boundary fix - previously wired to
// `voter.markVoted`, which wrongly blocked "operations" from ever finishing
// an exhausted call).
function canCloseAsNoAnswer(sessionRoleId: string | null): boolean {
  return computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED).can("voter.viewPhone");
}

assert(canCloseAsNoAnswer("seed-manager") === true, "manager: canCloseAsNoAnswer === true");
assert(
  canCloseAsNoAnswer("seed-user") === true,
  'operations ("משתמש"): canCloseAsNoAnswer === true (can call -> can finish the call it produced, even without voter.markVoted)',
);
assert(
  canCloseAsNoAnswer("seed-voting") === true,
  'voting ("נציג קלפי"): canCloseAsNoAnswer === true',
);
assert(canCloseAsNoAnswer(null) === false, "no session: canCloseAsNoAnswer === false");

// ---- voter.markVoted itself must be unaffected by the fix above - proves --
// the fix decoupled the close action from this permission rather than
// broadening the permission itself. "operations" still cannot mark voted.
function canMarkVoted(sessionRoleId: string | null): boolean {
  return computePermissions(sessionRoleId, "loaded", BUILT_IN_ROLE_SEED).can("voter.markVoted");
}

assert(canMarkVoted("seed-manager") === true, "manager: voter.markVoted unchanged, still true");
assert(
  canMarkVoted("seed-user") === false,
  'operations ("משתמש"): voter.markVoted still false - NOT broadened by this fix',
);
assert(canMarkVoted("seed-voting") === true, "voting: voter.markVoted unchanged, still true");

// ---- CallAttemptsDialog's action-availability derivation (isFinal/noEscape) -
// mirrored here in pure logic (no React render) - see that component's own
// doc comment for the full reasoning. `noEscape` (capped checkpoint + no
// close access) is now structurally unreachable for all 3 built-in roles
// (every one of them has `voter.viewPhone`, so `hasCloseAccess` is always
// true whenever this dialog can even be triggered) - still exercised here
// as a pure-logic edge case, not tied to any real role, since the component
// keeps it as a defensive fallback rather than assuming it can never happen.
function deriveDialogState(noAnswerStreakThreshold: number, hasCloseAccess: boolean) {
  const canExtend = noAnswerStreakThreshold === 3;
  const isFinal = !canExtend;
  const noEscape = isFinal && !hasCloseAccess;
  return { canExtend, isFinal, noEscape };
}

assert(
  deriveDialogState(3, true).canExtend === true && deriveDialogState(3, true).noEscape === false,
  "3rd checkpoint, has close access: extend offered, no dead-end",
);
assert(
  deriveDialogState(3, false).canExtend === true &&
    deriveDialogState(3, false).noEscape === false,
  '3rd checkpoint, no close access: extend still offered even without "close" - no dead-end',
);
assert(
  deriveDialogState(6, true).canExtend === false && deriveDialogState(6, true).noEscape === false,
  "6th (capped) checkpoint, has close access (every built-in role, post-fix): no extend offered, but close as לא ענה is available",
);
assert(
  deriveDialogState(6, false).canExtend === false &&
    deriveDialogState(6, false).noEscape === true,
  "6th (capped) checkpoint, no close access (defensive edge case, not a real built-in role today): no extend, no close -> falls back to the dismissible no-permission message",
);

if (process.exitCode) {
  console.error("\nsmoke-call-attempts: FAILED");
} else {
  console.log("\nsmoke-call-attempts: all checks passed");
}
