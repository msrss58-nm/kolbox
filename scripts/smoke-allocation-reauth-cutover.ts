// Security Phase 2 - focused regression guard for the coordinator-allocation
// reauth cutover: the 4 allocation mutations (manage coordinators, initial
// allocation, rebalance, end coordinator activity) must route through the
// same shared short-lived re-auth proof system Security Phase 1 already
// built for the 8 admin/import mutations - no `actorId`/`actorPassword`
// anywhere in the allocation call path anymore, no local per-component
// password dialog left over from the pre-Phase-2 design.
// This project has no component-rendering test framework (no Vitest/Jest/
// RTL - only Playwright, used for live-app smoke scripts), so this checks
// the real, committed source directly, mirroring
// scripts/smoke-bootstrap-hardening.ts's exact pattern.
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

const useCoordinatorAllocation = read(
  "src/features/election-day/useCoordinatorAllocation.ts",
);
const supabaseApi = read("src/services/api/supabaseElectionDayApi.ts");
const apiTypes = read("src/services/api/types.ts");
const rosterEditor = read("src/features/election-day/CoordinatorRosterEditor.tsx");
const endDialog = read("src/features/election-day/EndCoordinatorDialog.tsx");
const setupFlow = read("src/features/election-day/CoordinatorAllocationSetup.tsx");
const rebalanceDialog = read("src/features/election-day/RebalanceDialog.tsx");
const allocationView = read("src/features/election-day/CoordinatorAllocationView.tsx");

// 1. useCoordinatorAllocation.ts routes all 4 mutations through the shared
// reauth gate, and no longer accepts/forwards a raw actorPassword/actorId.
assert(
  useCoordinatorAllocation.includes("useElectionDayReauth()"),
  "useCoordinatorAllocation.ts: calls useElectionDayReauth()",
);
for (const rawFnCall of [
  "manageCoordinatorsRaw(actions)",
  "applyInitialAllocationRaw(assignments)",
  "rebalanceAssignmentsRaw(sources, destinations)",
  "endCoordinatorActivityRaw(coordinatorId, mode, targetCoordinatorId)",
]) {
  assert(
    useCoordinatorAllocation.includes(`reauth.gate(copy, () => ${rawFnCall})`) ||
      useCoordinatorAllocation.includes(`reauth.gate(copy, () =>\n        ${rawFnCall}`),
    `useCoordinatorAllocation.ts: reauth.gate(...) wraps ${rawFnCall}`,
  );
}
assert(
  !/actorPassword: string/.test(useCoordinatorAllocation),
  "useCoordinatorAllocation.ts: no actorPassword parameter declared anywhere",
);
assert(
  !/sessionUser\.id/.test(useCoordinatorAllocation),
  "useCoordinatorAllocation.ts: no direct sessionUser.id forwarding (proof-only actor derivation)",
);
assert(
  useCoordinatorAllocation.includes("reauthDialog: reauth.reauthDialog"),
  "useCoordinatorAllocation.ts: exposes reauthDialog for the caller to render",
);

// 2. supabaseElectionDayApi.ts calls only the _v2 RPC names for allocation,
// never the legacy v1 names, and never sends a raw password/actor id.
for (const rpc of [
  "election_day_manage_coordinators_v2",
  "election_day_apply_initial_allocation_v2",
  "election_day_rebalance_assignments_v2",
  "election_day_end_coordinator_activity_v2",
]) {
  assert(
    supabaseApi.includes(`supabase.rpc("${rpc}"`),
    `supabaseElectionDayApi.ts: calls ${rpc}`,
  );
}
for (const legacyRpc of [
  "election_day_manage_coordinators",
  "election_day_apply_initial_allocation",
  "election_day_rebalance_assignments",
  "election_day_end_coordinator_activity",
]) {
  assert(
    !new RegExp(`supabase\\.rpc\\("${legacyRpc}"[,)]`).test(supabaseApi),
    `supabaseElectionDayApi.ts: no frontend call to the legacy unversioned ${legacyRpc}`,
  );
}
// p_actor_password legitimately still appears once in this file - inside
// reauth() itself, the login/reauth endpoint that genuinely takes a real
// password. It must NOT appear inside any of the 4 allocation methods'
// own bodies.
for (const method of [
  "manageCoordinators",
  "applyInitialAllocation",
  "rebalanceAssignments",
  "endCoordinatorActivity",
]) {
  const start = supabaseApi.indexOf(`async ${method}(`);
  const body = start === -1 ? "" : supabaseApi.slice(start, start + 800);
  assert(
    start !== -1 && !body.includes("p_actor_password"),
    `supabaseElectionDayApi.ts: ${method}'s own body sends no p_actor_password`,
  );
}

// 3. ApiClient interface: the 4 allocation methods take `proof` first, not
// actorId/actorPassword.
assert(
  /manageCoordinators\(proof: string, actions: CoordinatorAction\[\]\)/.test(apiTypes),
  "types.ts: manageCoordinators(proof, actions) signature",
);
assert(
  /applyInitialAllocation\(\s*proof: string,/.test(apiTypes),
  "types.ts: applyInitialAllocation(proof, ...) signature",
);
assert(
  /rebalanceAssignments\(\s*proof: string,/.test(apiTypes),
  "types.ts: rebalanceAssignments(proof, ...) signature",
);
assert(
  /endCoordinatorActivity\(\s*proof: string,/.test(apiTypes),
  "types.ts: endCoordinatorActivity(proof, ...) signature",
);

// 4. No component under src/features/election-day/ still renders its own
// independent AllocationPasswordDialog bound to a per-action local password
// for an allocation mutation - only CoordinatorAllocationView.tsx (the
// single shared instance) and AllocationPasswordDialog.tsx itself (the
// component's own definition) may reference it.
for (const [name, content] of [
  ["CoordinatorRosterEditor.tsx", rosterEditor],
  ["EndCoordinatorDialog.tsx", endDialog],
  ["CoordinatorAllocationSetup.tsx", setupFlow],
  ["RebalanceDialog.tsx", rebalanceDialog],
] as const) {
  assert(
    !content.includes('import { AllocationPasswordDialog }') &&
      !content.includes("<AllocationPasswordDialog"),
    `${name}: no local AllocationPasswordDialog import/JSX instance left (consolidated into the shared one)`,
  );
}
assert(
  allocationView.includes("allocation.reauthDialog") &&
    allocationView.includes("<AllocationPasswordDialog"),
  "CoordinatorAllocationView.tsx: renders the single shared reauth dialog",
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
