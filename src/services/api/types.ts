import type {
  Activist,
  CampaignStats,
  CityBreakdown,
  Classification,
  ClassificationEvent,
  PollingStation,
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
}
