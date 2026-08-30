// Security Phase 1 - focused regression guard for the bootstrap correction:
// election_day_create_permission_user_v2 has no empty-roster exception
// (server-side, verified separately via the runtime matrix against real
// local Postgres), and the frontend must never call it - or the legacy v1
// RPC - with an empty/synthetic proof during the bootstrap window either.
// This project has no component-rendering test framework (no Vitest/Jest/
// RTL - only Playwright, used for live-app smoke scripts), so this checks
// the real, committed source directly: the exact bypass patterns that were
// removed must stay absent, and the exact safe patterns that replaced them
// must stay present. A silent regression (someone re-adding either bypass
// later) fails this script.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

let failures = 0;
function assert(condition: boolean, message: string) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

const useElectionDay = read("src/features/election-day/useElectionDay.ts");
const permissionsPage = read("src/features/election-day/ElectionDayPermissionsPage.tsx");
const supabaseApi = read("src/services/api/supabaseElectionDayApi.ts");
const shell = read("src/features/election-day/ElectionDayShell.tsx");

// 1. The removed bypass patterns must not be present anywhere in the hook.
assert(
  !useElectionDay.includes("isBootstrap && rosterStillEmpty"),
  "useElectionDay.ts: no isBootstrap && rosterStillEmpty bypass condition",
);
assert(
  !/if \(!sessionUser\) return addPermissionUserRaw/.test(useElectionDay),
  "useElectionDay.ts: no !sessionUser skip-reauth branch in addPermissionUser",
);
assert(
  !useElectionDay.includes("rosterStillEmpty"),
  "useElectionDay.ts: rosterStillEmpty variable fully removed (dead bootstrap state)",
);
assert(
  !/export function useElectionDay\(isBootstrap/.test(useElectionDay),
  "useElectionDay.ts: hook no longer takes an isBootstrap parameter",
);

// 2. addPermissionUser must be uniformly gated via guardedAction, exactly
// like deletePermissionUser (no bespoke bootstrap-widened allowed check).
assert(
  /const addPermissionUser = guardedAction\(\s*"electionDay\.manageUsers"/.test(
    useElectionDay,
  ),
  "useElectionDay.ts: addPermissionUser uses plain guardedAction(\"electionDay.manageUsers\", ...)",
);

// 3. ElectionDayShell no longer threads isBootstrap into useElectionDay().
assert(
  /const electionDay = useElectionDay\(\);/.test(shell),
  "ElectionDayShell.tsx: useElectionDay() called with no isBootstrap argument",
);

// 4. The whole isBootstrap concept (`ElectionDayGuard`'s pre-session
// unauthenticated bypass and this page's corresponding setup-required
// dead-end) was retired entirely in a later phase, before the Phase 3
// Contract this file was updated for - `ElectionDayPermissionsPage.tsx` no
// longer has any isBootstrap branch or reference of any kind, and
// canManageUsers is a plain, unwidened permission check.
assert(
  !permissionsPage.includes("isBootstrap"),
  "ElectionDayPermissionsPage.tsx: no isBootstrap reference of any kind remains",
);
assert(
  /const canManageUsers = can\("electionDay\.manageUsers"\);/.test(permissionsPage),
  "ElectionDayPermissionsPage.tsx: canManageUsers is a plain, unwidened permission check",
);

// 5. Phase 3 Contract: createPermissionUser (and the election_day_create_
// permission_user_v2 RPC it called) was removed entirely from
// supabaseElectionDayApi.ts - creation now goes exclusively through the
// trusted v3 path (useCreatePermissionUserTrusted.ts -> POST
// /api/election-day/permission-users), which carries no bootstrap exception
// either (grepped directly - zero "bootstrap" references in either the hook
// or the API route).
assert(
  !supabaseApi.includes("createPermissionUser"),
  "supabaseElectionDayApi.ts: createPermissionUser (and its _v2 RPC call) fully removed - trusted v3 is the only creation path",
);
assert(
  !/supabase\.rpc\("election_day_create_permission_user"[,)]/.test(supabaseApi),
  "supabaseElectionDayApi.ts: no frontend call to the legacy unauthenticated election_day_create_permission_user",
);
const trustedCreateHook = read(
  "src/features/election-day/useCreatePermissionUserTrusted.ts",
);
const permissionUsersApiRoute = read("api/election-day/permission-users.ts");
assert(
  !trustedCreateHook.toLowerCase().includes("bootstrap") &&
    !permissionUsersApiRoute.toLowerCase().includes("bootstrap"),
  "trusted v3 create-user path (hook + API route): no bootstrap exception of any kind",
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
