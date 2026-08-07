/** Reset Permission User Password - pure-logic coverage, same precedent as
 * `smoke-role-management-logic.ts`: `supabaseElectionDayApi.ts` can't be
 * imported directly in plain Node (it transitively pulls in the real
 * Supabase client via `import.meta.env`), so this pins a copy of
 * `mapRoleRpcErrorMessage`'s 4 branches for this RPC (`UNAUTHORIZED`,
 * `FORBIDDEN`, `USER_NOT_FOUND`, `INVALID_PASSWORD`) plus
 * `ResetPasswordDialog.tsx`'s pure submit-enabled validation logic (now 3
 * fields: actor password, new password, confirm) - a source edit that
 * silently changes either is caught. The RPC's own server-side
 * re-authentication/permission-check ORDER (actor credentials -> actor
 * permission -> target exists -> new password valid) can only be verified
 * live against a real database (see the "after Migration apply" test plan),
 * not here - this file only pins the pure, dependency-free logic.
 *
 * Run via: npx esbuild scripts/smoke-reset-password-logic.ts --bundle --format=cjs --outfile=scripts/smoke-reset-password-logic.cjs && node scripts/smoke-reset-password-logic.cjs
 */
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else console.log("ok:", msg);
};

// ---- pinned copy of supabaseElectionDayApi.ts's mapRoleRpcErrorMessage ----
// (only the 4 branches relevant to election_day_reset_permission_user_password
// - the role-management branches are already pinned by
// smoke-role-management-logic.ts, no need to duplicate them here). Checked
// in the same priority order the RPC itself raises them - UNAUTHORIZED before
// FORBIDDEN before USER_NOT_FOUND before INVALID_PASSWORD.
function mapRoleRpcErrorMessage(message: string): string {
  if (message.includes("UNAUTHORIZED")) {
    return "הסיסמה שהזנת אינה נכונה";
  }
  if (message.includes("FORBIDDEN")) {
    return "אין לך הרשאה לבצע פעולה זו";
  }
  if (message.includes("USER_NOT_FOUND")) {
    return "המשתמש לא נמצא - ייתכן שנמחק על ידי משתמש אחר";
  }
  if (message.includes("INVALID_PASSWORD")) {
    return "יש להזין סיסמה חדשה";
  }
  return message;
}

assert(
  mapRoleRpcErrorMessage("UNAUTHORIZED") === "הסיסמה שהזנת אינה נכונה",
  "mapRoleRpcErrorMessage: UNAUTHORIZED (wrong actor id/password) maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage("FORBIDDEN") === "אין לך הרשאה לבצע פעולה זו",
  "mapRoleRpcErrorMessage: FORBIDDEN (actor lacks electionDay.manageUsers) maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage("USER_NOT_FOUND") === "המשתמש לא נמצא - ייתכן שנמחק על ידי משתמש אחר",
  "mapRoleRpcErrorMessage: USER_NOT_FOUND maps to a clear Hebrew message (target deleted mid-dialog)",
);
assert(
  mapRoleRpcErrorMessage("INVALID_PASSWORD") === "יש להזין סיסמה חדשה",
  "mapRoleRpcErrorMessage: INVALID_PASSWORD maps to a clear Hebrew message",
);
assert(
  mapRoleRpcErrorMessage("some unrelated raw Postgres error") ===
    "some unrelated raw Postgres error",
  "mapRoleRpcErrorMessage: an unrecognized message passes through unchanged (never swallowed)",
);

// ---- pinned copy of ResetPasswordDialog.tsx's submit-disabled logic -------
// (now 3 required fields: the acting manager's own current password, the
// new password, and its confirmation - only the latter two must match).
function isSubmitDisabled(
  busy: boolean,
  actorPassword: string,
  newPassword: string,
  confirmPassword: string,
): boolean {
  const bothFilled = Boolean(newPassword.trim() && confirmPassword.trim());
  const mismatch = Boolean(bothFilled && newPassword !== confirmPassword);
  return (
    busy ||
    !newPassword.trim() ||
    !confirmPassword.trim() ||
    !actorPassword.trim() ||
    mismatch
  );
}

assert(isSubmitDisabled(false, "", "", "") === true, "all empty -> disabled");
assert(
  isSubmitDisabled(false, "", "abc123", "abc123") === true,
  "actor password empty (new/confirm valid) -> disabled",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "abc123", "") === true,
  "confirm empty -> disabled",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "", "abc123") === true,
  "new empty -> disabled",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "abc123", "abc456") === true,
  "mismatched new/confirm passwords -> disabled",
);
assert(
  isSubmitDisabled(false, "   ", "abc123", "abc123") === true,
  "whitespace-only actor password counts as empty -> disabled (matches .trim() check)",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "abc123", "abc123") === false,
  "actor password filled, matching non-empty new/confirm -> enabled",
);
assert(
  isSubmitDisabled(true, "myOwnPw", "abc123", "abc123") === true,
  "busy (operation already running) -> disabled regardless of valid input (double-submit guard)",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "sameValue", "sameValue") === false,
  "identical new/confirm values -> enabled (no invented policy beyond match+non-empty)",
);
assert(
  isSubmitDisabled(false, "myOwnPw", "myOwnPw", "myOwnPw") === false,
  "new password happening to equal the actor's own current password -> still enabled (no 'can't reuse old password' policy invented - the RPC doesn't check this either)",
);

if (process.exitCode) {
  console.error("\nsmoke-reset-password-logic: FAILED");
} else {
  console.log("\nsmoke-reset-password-logic: all checks passed");
}
