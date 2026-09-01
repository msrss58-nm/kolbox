import { MockApi } from "./mockApi";
import { SupabaseElectionDayApi } from "./supabaseElectionDayApi";
import { trustedElectionDayActionsApi } from "./electionDayTrustedActionsApi";
import type { ApiClient } from "./types";

/**
 * The app-wide ApiClient singleton, composed of three backends:
 * - `mockApi` - everything except Election Day (voters/activists/dashboard/
 *   import) - still MockApi/localStorage, unchanged.
 * - `electionDayApi` - the remaining legacy-path Election Day methods: every
 *   Election Day method not yet cut over to a trusted v3 path
 *   (permission-users/roles/coordinators/reauth/realtime - a separate
 *   concern from the Phase 4B voter/settings/ride-coordinator/non-voting-
 *   reason domain below).
 * - `trustedElectionDayActionsApi` - Multi-Tenant Phase 4B Frontend Cutover:
 *   all 28 `ApiClient` Election Day voter/settings/ride-coordinator/
 *   non-voting-reason methods now backed by the trusted, session-derived
 *   `/api/election-day/actions` endpoint instead of a direct Supabase call -
 *   the last 12 (the null-coordinator-blocked voter mutations plus
 *   `createNonVotingReason`/`updateNonVotingReason`) were cut over here
 *   once the Backend Compatibility Fix (migration
 *   `20260831010000_multi_tenant_phase4b_backend_compatibility_fix.sql`)
 *   closed the gaps that had kept them on the legacy path. `closeCallAsNoAnswer`
 *   (not part of `ApiClient`) is exported separately for `useElectionDay.ts`
 *   to call directly.
 *
 * Every method is delegated explicitly (not spread) - class methods live on
 * the prototype, so `{...instance}` would silently drop them all.
 */
const mockApi = new MockApi();
const electionDayApi = new SupabaseElectionDayApi();

export const api: ApiClient = {
  // dashboard
  getStats: (...args) => mockApi.getStats(...args),
  getTrend: (...args) => mockApi.getTrend(...args),
  getCityBreakdown: (...args) => mockApi.getCityBreakdown(...args),

  // voters
  listVoters: (...args) => mockApi.listVoters(...args),
  getVoter: (...args) => mockApi.getVoter(...args),
  addVoter: (...args) => mockApi.addVoter(...args),
  updateVoter: (...args) => mockApi.updateVoter(...args),
  classifyVoter: (...args) => mockApi.classifyVoter(...args),
  bulkClassify: (...args) => mockApi.bulkClassify(...args),
  getVoterHistory: (...args) => mockApi.getVoterHistory(...args),

  // activists
  listActivists: (...args) => mockApi.listActivists(...args),
  getActivist: (...args) => mockApi.getActivist(...args),
  addActivist: (...args) => mockApi.addActivist(...args),
  updateActivist: (...args) => mockApi.updateActivist(...args),
  getActivistEvents: (...args) => mockApi.getActivistEvents(...args),
  ensureActivistProfile: (...args) => mockApi.ensureActivistProfile(...args),

  // stations & meta
  listStations: (...args) => mockApi.listStations(...args),
  listCities: (...args) => mockApi.listCities(...args),

  // data management
  importVoters: (...args) => mockApi.importVoters(...args),
  resetToDemo: (...args) => mockApi.resetToDemo(...args),
  clearAll: (...args) => mockApi.clearAll(...args),

  // election day - ride-coordination dataset. Multi-Tenant Phase 4B Frontend
  // Cutover: all methods now cut over to trusted /api/election-day/actions.
  // setRideArranged/setReminder/setReminderAt/closeReminder/cancelReminder/
  // setVoted/setNonVotingReason/recordNoAnswer/recordCallAnswered/
  // extendNoAnswerStreakThreshold were held back in the first cutover pass:
  // every `election_day_..._core` function that inserts into
  // election_day_reminder_events/election_day_ride_status_events read its
  // `coordinator` snapshot RAW (no `coalesce(coordinator, '')`), unlike
  // their legacy counterparts - `election_day_voters.coordinator` is
  // nullable by design, so any of these ops against a coordinator-less
  // voter hit a live NOT NULL constraint violation (confirmed empirically,
  // not just read in the SQL). Fixed by the Backend Compatibility Fix
  // (migration
  // `20260831010000_multi_tenant_phase4b_backend_compatibility_fix.sql`),
  // which applied the same `coalesce(coordinator, '')` fix (already used by
  // the legacy RPCs since migration
  // `20260812090200_election_day_reminder_lifecycle_null_coordinator_
  // hardening.sql`) to all 9 affected `_core` functions - re-verified via
  // a real coordinator-less-voter round trip against every one of these
  // ops before cutting over.
  listElectionDayVoters: (...args) =>
    trustedElectionDayActionsApi.listElectionDayVoters(...args),
  setRideRequested: (...args) => trustedElectionDayActionsApi.setRideRequested(...args),
  setRideArranged: (...args) => trustedElectionDayActionsApi.setRideArranged(...args),
  setRideCompleted: (...args) => trustedElectionDayActionsApi.setRideCompleted(...args),
  listRideStatusEvents: (...args) =>
    trustedElectionDayActionsApi.listRideStatusEvents(...args),
  getElectionDayDeadline: (...args) =>
    trustedElectionDayActionsApi.getElectionDayDeadline(...args),
  setElectionDayDeadline: (...args) =>
    trustedElectionDayActionsApi.setElectionDayDeadline(...args),
  setReminder: (...args) => trustedElectionDayActionsApi.setReminder(...args),
  setReminderAt: (...args) => trustedElectionDayActionsApi.setReminderAt(...args),
  closeReminder: (...args) => trustedElectionDayActionsApi.closeReminder(...args),
  cancelReminder: (...args) => trustedElectionDayActionsApi.cancelReminder(...args),
  listReminderEvents: (...args) =>
    trustedElectionDayActionsApi.listReminderEvents(...args),
  setVoted: (...args) => trustedElectionDayActionsApi.setVoted(...args),
  setNonVotingReason: (...args) =>
    trustedElectionDayActionsApi.setNonVotingReason(...args),
  incrementCallAttempts: (...args) =>
    trustedElectionDayActionsApi.incrementCallAttempts(...args),
  recordNoAnswer: (...args) => trustedElectionDayActionsApi.recordNoAnswer(...args),
  recordCallAnswered: (...args) =>
    trustedElectionDayActionsApi.recordCallAnswered(...args),
  extendNoAnswerStreakThreshold: (...args) =>
    trustedElectionDayActionsApi.extendNoAnswerStreakThreshold(...args),
  setElectionDayNotes: (...args) =>
    trustedElectionDayActionsApi.setElectionDayNotes(...args),
  setPhone: (...args) => trustedElectionDayActionsApi.setPhone(...args),

  // election day - ride-coordinators roster (Multi-Tenant Phase 4B Frontend
  // Cutover: trusted /api/election-day/actions)
  listRideCoordinators: (...args) =>
    trustedElectionDayActionsApi.listRideCoordinators(...args),
  addRideCoordinator: (...args) =>
    trustedElectionDayActionsApi.addRideCoordinator(...args),
  deleteRideCoordinator: (...args) =>
    trustedElectionDayActionsApi.deleteRideCoordinator(...args),

  // election day - permission users roster (Supabase-backed, RPC-only)
  listPermissionUsers: (...args) => electionDayApi.listPermissionUsers(...args),
  verifyPermissionUserLogin: (...args) =>
    electionDayApi.verifyPermissionUserLogin(...args),

  // election day - security hardening (reauth proof)
  reauth: (...args) => electionDayApi.reauth(...args),
  revokeReauthProof: (...args) => electionDayApi.revokeReauthProof(...args),

  // election day - dynamic role catalog (Phase 1, Supabase-backed, RPC-only)
  listElectionDayRoles: (...args) => electionDayApi.listElectionDayRoles(...args),

  // election day - dynamic non-voting reason catalog (Multi-Tenant Phase 4B
  // Frontend Cutover: trusted /api/election-day/actions). create/update
  // were held back in the first cutover pass - election_day_create_non_
  // voting_reason_v3/update_non_voting_reason_v3 didn't accept a
  // requiresFollowUp parameter at all - fixed by the Backend Compatibility
  // Fix (migration
  // `20260831010000_multi_tenant_phase4b_backend_compatibility_fix.sql`),
  // which added a 4-arg p_requires_follow_up overload to both RPCs (the
  // pre-existing 3-arg overloads are untouched, still present).
  listNonVotingReasons: (...args) =>
    trustedElectionDayActionsApi.listNonVotingReasons(...args),
  createNonVotingReason: (...args) =>
    trustedElectionDayActionsApi.createNonVotingReason(...args),
  updateNonVotingReason: (...args) =>
    trustedElectionDayActionsApi.updateNonVotingReason(...args),
  setNonVotingReasonActive: (...args) =>
    trustedElectionDayActionsApi.setNonVotingReasonActive(...args),
  deleteNonVotingReason: (...args) =>
    trustedElectionDayActionsApi.deleteNonVotingReason(...args),
  reorderNonVotingReasons: (...args) =>
    trustedElectionDayActionsApi.reorderNonVotingReasons(...args),

  // election day - coordinator allocation management (Supabase-backed).
  // listCoordinators: a plain SELECT, kept implemented for ApiClient
  // interface completeness, but has no live caller as of Multi-Tenant Phase
  // 4B Frontend Cutover - both former consumers (CoordinatorReminder
  // SupervisionCard.tsx, useCoordinatorAllocation.ts) now call
  // `fetchCoordinatorsTrusted()` directly instead. The 4 mutation RPCs were
  // retired in the Phase 3 Contract - all 4 mutations go through the
  // trusted v3 HTTP path exclusively (see
  // electionDayTrustedCoordinatorAllocationClient.ts).
  listCoordinators: (...args) => electionDayApi.listCoordinators(...args),

  // election day - live cross-device sync (Supabase Realtime). Two separate
  // methods/channels, deliberately not one shared method - see
  // subscribeToCoordinatorChanges's own doc comment in ./types.ts.
  subscribeToElectionDayChanges: (...args) =>
    electionDayApi.subscribeToElectionDayChanges(...args),
  subscribeToCoordinatorChanges: (...args) =>
    electionDayApi.subscribeToCoordinatorChanges(...args),
};

export type * from "./types";
// Security Hardening (Reauth): a runtime class (not just a type), so it's a
// plain named re-export rather than folded into the `export type *` above -
// `useElectionDayReauth.ts` needs `instanceof` checks against it.
export { ElectionDayReauthError } from "./supabaseElectionDayApi";
