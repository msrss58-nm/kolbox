import { MockApi } from "./mockApi";
import { SupabaseElectionDayApi } from "./supabaseElectionDayApi";
import type { ApiClient } from "./types";

/**
 * The app-wide ApiClient singleton, composed of two backends:
 * - `mockApi` - everything except Election Day (voters/activists/dashboard/
 *   import) - still MockApi/localStorage, unchanged.
 * - `electionDayApi` - Election Day's ride-coordination data, now backed by
 *   the shared Supabase project (`supabase/migrations/*_election_day_*.sql`)
 *   instead of per-browser localStorage, so it works across devices.
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

  // election day - ride-coordination dataset (Supabase-backed)
  importElectionDayVoters: (...args) => electionDayApi.importElectionDayVoters(...args),
  listElectionDayVoters: (...args) => electionDayApi.listElectionDayVoters(...args),
  clearElectionDayVoters: (...args) => electionDayApi.clearElectionDayVoters(...args),
  setRideRequested: (...args) => electionDayApi.setRideRequested(...args),
  setRideArranged: (...args) => electionDayApi.setRideArranged(...args),
  setRideCompleted: (...args) => electionDayApi.setRideCompleted(...args),
  listRideStatusEvents: (...args) => electionDayApi.listRideStatusEvents(...args),
  getElectionDayDeadline: (...args) => electionDayApi.getElectionDayDeadline(...args),
  setElectionDayDeadline: (...args) => electionDayApi.setElectionDayDeadline(...args),
  setReminder: (...args) => electionDayApi.setReminder(...args),
  setVoted: (...args) => electionDayApi.setVoted(...args),
  setElectionDayNotes: (...args) => electionDayApi.setElectionDayNotes(...args),
  setPhone: (...args) => electionDayApi.setPhone(...args),

  // election day - ride-coordinators roster (Supabase-backed)
  listRideCoordinators: (...args) => electionDayApi.listRideCoordinators(...args),
  addRideCoordinator: (...args) => electionDayApi.addRideCoordinator(...args),
  deleteRideCoordinator: (...args) => electionDayApi.deleteRideCoordinator(...args),

  // election day - permission users roster (Supabase-backed, RPC-only)
  listPermissionUsers: (...args) => electionDayApi.listPermissionUsers(...args),
  addPermissionUser: (...args) => electionDayApi.addPermissionUser(...args),
  deletePermissionUser: (...args) => electionDayApi.deletePermissionUser(...args),
  verifyPermissionUserLogin: (...args) =>
    electionDayApi.verifyPermissionUserLogin(...args),

  // election day - dynamic role catalog (Phase 1, Supabase-backed, RPC-only)
  listElectionDayRoles: (...args) => electionDayApi.listElectionDayRoles(...args),

  // election day - live cross-device sync (Supabase Realtime)
  subscribeToElectionDayChanges: (...args) =>
    electionDayApi.subscribeToElectionDayChanges(...args),
};

export type * from "./types";
