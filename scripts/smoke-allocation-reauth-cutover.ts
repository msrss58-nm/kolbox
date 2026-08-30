// Security Phase 2 (original) / Coordinator-Allocation V3 Frontend Cutover
// (current) - focused regression guard for the coordinator-allocation reauth
// path: the 4 allocation mutations (manage coordinators, initial allocation,
// rebalance, end coordinator activity) must route through a proof-based
// reauth gate before ever reaching the server, with no raw actorId/
// actorPassword anywhere in the call path and no local per-component
// password dialog left over from the pre-Phase-2 design.
//
// Rewritten 2026-08-30 for the Phase 3 Contract's tooling-closure step: the
// original version (written for Security Phase 2's `reauth.gate(copy, () =>
// xRaw(...))` + `supabaseElectionDayApi.ts` + legacy `_v2` RPC architecture)
// went stale when the separate, earlier Coordinator/Allocation V3 Frontend
// Cutover moved this hook onto a dedicated trusted v3 HTTP client and its own
// feature-scoped reauth gate/proof store - and went stale a second time when
// the Phase 3 Contract retired the 4 legacy `_v2` RPCs it used to check the
// literal presence of. Same regression intent as the original, retargeted at
// the current architecture: prove the gate is real (not bypassed), prove no
// raw credential ever reaches a mutation call, prove the legacy `_v2` RPC
// names are gone from every file in the live call path, and prove the UI
// consolidation (one shared dialog, no local duplicates) still holds.
//
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
const trustedClient = read(
  "src/features/election-day/electionDayTrustedCoordinatorAllocationClient.ts",
);
const supabaseApi = read("src/services/api/supabaseElectionDayApi.ts");
const apiTypes = read("src/services/api/types.ts");
const rosterEditor = read("src/features/election-day/CoordinatorRosterEditor.tsx");
const endDialog = read("src/features/election-day/EndCoordinatorDialog.tsx");
const setupFlow = read("src/features/election-day/CoordinatorAllocationSetup.tsx");
const rebalanceDialog = read("src/features/election-day/RebalanceDialog.tsx");
const allocationView = read("src/features/election-day/CoordinatorAllocationView.tsx");

// 1. useCoordinatorAllocation.ts routes all 4 mutations through the
// feature-scoped v3 reauth gate (useCoordinatorAllocationReauth - a
// SEPARATE hook/proof-store from the legacy shared useElectionDayReauth),
// and no longer accepts/forwards a raw actorPassword/actorId.
assert(
  useCoordinatorAllocation.includes(
    'import { useCoordinatorAllocationReauth } from "./useCoordinatorAllocationReauth"',
  ),
  "useCoordinatorAllocation.ts: imports the feature-scoped useCoordinatorAllocationReauth",
);
assert(
  useCoordinatorAllocation.includes("useCoordinatorAllocationReauth()"),
  "useCoordinatorAllocation.ts: calls useCoordinatorAllocationReauth()",
);
assert(
  !useCoordinatorAllocation.includes('from "./useElectionDayReauth"'),
  "useCoordinatorAllocation.ts: does not import the legacy shared useElectionDayReauth",
);
for (const rawFnCall of [
  "manageCoordinatorsRaw(actions)",
  "applyInitialAllocationRaw(assignments)",
  "rebalanceAssignmentsRaw(sources, destinations)",
  "endCoordinatorActivityRaw(coordinatorId, mode, targetCoordinatorId)",
]) {
  assert(
    useCoordinatorAllocation.includes(`reauth.gate(copy, () => ${rawFnCall})`) ||
      useCoordinatorAllocation.includes(`reauth.gate(copy, () =>\n      ${rawFnCall}`) ||
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
// The dedicated 5-minute proof store, not the legacy 15-minute cache - each
// *Raw wrapper reads/clears its own proof directly from this store.
assert(
  useCoordinatorAllocation.includes(
    'import { useCoordinatorAllocationReauthProof } from "./coordinatorAllocationReauthProof"',
  ),
  "useCoordinatorAllocation.ts: imports the dedicated coordinatorAllocationReauthProof store",
);
assert(
  (useCoordinatorAllocation.match(
    /useCoordinatorAllocationReauthProof\.getState\(\)\.proof/g,
  ) ?? []).length === 4,
  "useCoordinatorAllocation.ts: all 4 mutations read the proof from the dedicated store (exactly 4 occurrences)",
);
assert(
  (useCoordinatorAllocation.match(
    /useCoordinatorAllocationReauthProof\.getState\(\)\.clearProof\(\)/g,
  ) ?? []).length === 4,
  "useCoordinatorAllocation.ts: all 4 mutations clear the dedicated store's proof on UNAUTHORIZED (exactly 4 occurrences)",
);

// 2. The trusted v3 client is the sole call path for all 4 mutations - POSTs
// to the v3 HTTP endpoint with the correct op, never a direct Supabase RPC
// call, and never sends a raw password anywhere in a mutation request body
// (only reauthForCoordinatorAllocation's own dedicated call to
// /api/election-day/reauth takes a password, to mint the proof).
assert(
  trustedClient.includes(
    'const COORDINATOR_ALLOCATION_ENDPOINT = "/api/election-day/coordinator-allocation"',
  ),
  "electionDayTrustedCoordinatorAllocationClient.ts: targets the trusted v3 HTTP endpoint",
);
for (const [fn, op] of [
  ["manageCoordinatorsTrusted", "manage_coordinators"],
  ["applyInitialAllocationTrusted", "apply_initial_allocation"],
  ["rebalanceAssignmentsTrusted", "rebalance_assignments"],
  ["endCoordinatorActivityTrusted", "end_coordinator_activity"],
] as const) {
  assert(
    trustedClient.includes(`export async function ${fn}(`),
    `electionDayTrustedCoordinatorAllocationClient.ts: exports ${fn}`,
  );
  assert(
    trustedClient.includes(`"${op}"`),
    `electionDayTrustedCoordinatorAllocationClient.ts: ${fn} sends op "${op}"`,
  );
}
// password legitimately appears once in this file - inside
// reauthForCoordinatorAllocation itself, the reauth endpoint that genuinely
// takes a real password. It must NOT appear inside any of the 4 mutation
// functions' own bodies.
for (const fn of [
  "manageCoordinatorsTrusted",
  "applyInitialAllocationTrusted",
  "rebalanceAssignmentsTrusted",
  "endCoordinatorActivityTrusted",
]) {
  const start = trustedClient.indexOf(`export async function ${fn}(`);
  const nextExportStart = trustedClient.indexOf("\nexport ", start + 1);
  const body =
    start === -1
      ? ""
      : trustedClient.slice(start, nextExportStart === -1 ? undefined : nextExportStart);
  assert(
    start !== -1 && !/password/i.test(body),
    `electionDayTrustedCoordinatorAllocationClient.ts: ${fn}'s own body sends no password`,
  );
}
assert(
  !trustedClient.includes("supabase.rpc("),
  "electionDayTrustedCoordinatorAllocationClient.ts: never calls supabase.rpc(...) directly - HTTP only",
);

// 3. The 4 legacy _v2 RPCs (retired entirely by the Phase 3 Contract - see
// migration 20260830000000_election_day_phase3_contract_v2_rpc_removal.sql)
// are absent from every file in the live coordinator-allocation call path.
for (const legacyRpc of [
  "election_day_manage_coordinators_v2",
  "election_day_apply_initial_allocation_v2",
  "election_day_rebalance_assignments_v2",
  "election_day_end_coordinator_activity_v2",
]) {
  assert(
    !useCoordinatorAllocation.includes(legacyRpc),
    `useCoordinatorAllocation.ts: no reference to the retired ${legacyRpc}`,
  );
  assert(
    !trustedClient.includes(legacyRpc),
    `electionDayTrustedCoordinatorAllocationClient.ts: no reference to the retired ${legacyRpc}`,
  );
  assert(
    !supabaseApi.includes(legacyRpc),
    `supabaseElectionDayApi.ts: no reference to the retired ${legacyRpc} (method removed in the Contract)`,
  );
}
// The 4 legacy ApiClient interface methods themselves were removed in the
// Contract - confirm they never reappear.
for (const legacyMethod of [
  "manageCoordinators(proof: string, actions: CoordinatorAction[])",
  "applyInitialAllocation(",
  "rebalanceAssignments(",
  "endCoordinatorActivity(",
]) {
  assert(
    !apiTypes.includes(legacyMethod),
    `types.ts: ApiClient no longer declares ${legacyMethod.split("(")[0]}(...) (removed in the Contract)`,
  );
}

// 4. The trusted client's own exported function signatures take `proof`
// first - this is the current home of the "proof-first, not actorId/
// actorPassword" contract, now that the ApiClient interface no longer
// declares these methods at all.
assert(
  /export async function manageCoordinatorsTrusted\(\s*proof: string,/.test(trustedClient),
  "electionDayTrustedCoordinatorAllocationClient.ts: manageCoordinatorsTrusted(proof, ...) signature",
);
assert(
  /export async function applyInitialAllocationTrusted\(\s*proof: string,/.test(trustedClient),
  "electionDayTrustedCoordinatorAllocationClient.ts: applyInitialAllocationTrusted(proof, ...) signature",
);
assert(
  /export async function rebalanceAssignmentsTrusted\(\s*proof: string,/.test(trustedClient),
  "electionDayTrustedCoordinatorAllocationClient.ts: rebalanceAssignmentsTrusted(proof, ...) signature",
);
assert(
  /export async function endCoordinatorActivityTrusted\(\s*proof: string,/.test(trustedClient),
  "electionDayTrustedCoordinatorAllocationClient.ts: endCoordinatorActivityTrusted(proof, ...) signature",
);

// 5. No component under src/features/election-day/ still renders its own
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
