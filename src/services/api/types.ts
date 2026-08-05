import type { RoleRecord } from "../../permissions/types";
import type {
  Activist,
  CampaignStats,
  CityBreakdown,
  Classification,
  ClassificationEvent,
  ElectionDayVoter,
  PermissionUser,
  PollingStation,
  RideCoordinator,
  RideStatusEvent,
  TrendPoint,
  Voter,
} from "../../types";

export interface Paged<T> {
  items: T[];
  total: number;
}

export type VoterSortKey = "lastName" | "city" | "classifiedAt" | "birthYear";

export interface VoterQuery {
  search?: string; // matches name / national ID / phone
  cities?: string[]; // matches any of - empty/undefined means all cities
  classifications?: Classification[]; // matches any of - empty/undefined means all
  pollingStationId?: string;
  sortBy?: VoterSortKey;
  sortDir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface NewVoter {
  nationalId: string;
  firstName: string;
  lastName: string;
  city: string;
  street: string;
  houseNumber: number;
  phone: string | null;
  birthYear: number;
  pollingStationId: string;
}

export interface NewActivist {
  firstName: string;
  lastName: string;
  phone: string;
  area: string;
}

export interface ImportRow {
  nationalId: string;
  firstName: string;
  lastName: string;
  city?: string;
  street?: string;
  houseNumber?: number;
  phone?: string;
  birthYear?: number;
}

export interface ImportSummary {
  added: number;
  updated: number;
  skipped: { row: number; reason: string }[];
}

export interface NewElectionDayVoter {
  masad: string;
  firstName: string;
  lastName: string;
  street: string;
  houseNumber: number;
  city: string;
  phone: string | null;
  coordinator: string;
}

export interface NewRideCoordinator {
  name: string;
  phone: string;
}

export interface NewPermissionUser {
  name: string;
  password: string;
  role: "user" | "manager" | "voting";
}

/**
 * The single data-access seam of the app.
 * MVP: implemented by MockApi (in-memory + localStorage).
 * Post-MVP: implemented by SupabaseApi with zero UI changes.
 */
export interface ApiClient {
  // dashboard
  getStats(): Promise<CampaignStats>;
  getTrend(days: number): Promise<TrendPoint[]>;
  getCityBreakdown(): Promise<CityBreakdown[]>;

  // voters
  listVoters(query: VoterQuery): Promise<Paged<Voter>>;
  getVoter(id: string): Promise<Voter | null>;
  addVoter(voter: NewVoter): Promise<Voter>;
  updateVoter(id: string, patch: Partial<Voter>): Promise<Voter>;
  classifyVoter(
    voterId: string,
    classification: Classification,
    activistId: string,
    opts?: { includeFamily?: boolean },
  ): Promise<Voter[]>; // returns all voters changed (family included)
  bulkClassify(
    voterIds: string[],
    classification: Classification,
    activistId: string,
  ): Promise<Voter[]>;
  getVoterHistory(voterId: string): Promise<ClassificationEvent[]>;

  // activists
  listActivists(): Promise<Activist[]>;
  getActivist(id: string): Promise<Activist | null>;
  addActivist(activist: NewActivist): Promise<Activist>;
  updateActivist(id: string, patch: Partial<Activist>): Promise<Activist>;
  getActivistEvents(activistId: string): Promise<ClassificationEvent[]>;
  /**
   * Idempotent: creates an activist record with a caller-supplied id if one
   * doesn't already exist. Used to keep a real (Supabase-authenticated)
   * activist's tag-count/leaderboard entry in sync with their auth identity,
   * since voters/activists themselves still live in this local mock store.
   */
  ensureActivistProfile(id: string, info: NewActivist): Promise<Activist>;

  // stations & meta
  listStations(): Promise<PollingStation[]>;
  listCities(): Promise<string[]>;

  // data management
  importVoters(rows: ImportRow[]): Promise<ImportSummary>;
  resetToDemo(): Promise<void>;
  clearAll(): Promise<void>;

  // election day - independent ride-coordination dataset (see types.ts ElectionDayVoter)
  importElectionDayVoters(rows: NewElectionDayVoter[]): Promise<{ count: number }>;
  listElectionDayVoters(): Promise<ElectionDayVoter[]>;
  /** Clears the ride-list and its activity log (not the deadline). */
  clearElectionDayVoters(): Promise<void>;
  /** The voter needs a ride - a lighter-weight signal than `setRideArranged`,
   * set before any driver has actually been contacted. */
  setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter>;
  setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter>;
  /** Marks whether the ride actually happened - the driver reports this by
   * phone and a war-room activist marks it in the ride-coordination table. */
  setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter>;
  listRideStatusEvents(): Promise<RideStatusEvent[]>;
  getElectionDayDeadline(): Promise<string | null>;
  setElectionDayDeadline(deadline: string | null): Promise<string | null>;
  /** `minutesFromNow: null` cancels an existing reminder. */
  setReminder(id: string, minutesFromNow: number | null): Promise<ElectionDayVoter>;
  setVoted(id: string, voted: boolean): Promise<ElectionDayVoter>;
  setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter>;
  /** Updates only the `phone` field, by internal id - never sends or
   * overwrites the rest of the voter record. */
  setPhone(id: string, phone: string): Promise<ElectionDayVoter>;

  // election day - fixed, pre-registered ride-coordinator roster
  listRideCoordinators(): Promise<RideCoordinator[]>;
  addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator>;
  deleteRideCoordinator(id: string): Promise<void>;

  // election day - local user/manager permissions roster (no real auth)
  listPermissionUsers(): Promise<PermissionUser[]>;
  addPermissionUser(input: NewPermissionUser): Promise<PermissionUser>;
  deletePermissionUser(id: string): Promise<void>;
  /** Verifies name+password and returns the matching user (never a
   * password/hash) on success, or null on no match. */
  verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null>;

  /** Dynamic Roles & Permissions, Phase 1: lists the full `election_day_roles`
   * catalog the permission engine resolves a session's legacy role text
   * against. Every row is validated/normalized (never a blind cast) before
   * being returned - see `permissions/roleRecordMapper.ts`. */
  listElectionDayRoles(): Promise<RoleRecord[]>;

  /**
   * Optional live cross-device sync for Election Day's ride-coordination
   * data - calls `onChange` whenever a contact or ride-status event changes
   * on another device/tab. Implementations that don't support Realtime
   * (e.g. MockApi) simply don't implement this; callers must feature-detect
   * (`api.subscribeToElectionDayChanges?.(...)`) rather than assume it
   * exists. Returns an unsubscribe function.
   */
  subscribeToElectionDayChanges?(onChange: () => void): () => void;
}
