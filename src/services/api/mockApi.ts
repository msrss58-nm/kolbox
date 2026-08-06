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
import { APP_CONFIG } from "../../constants/config";
import { generateDataset, type Dataset } from "../../data/generator";
import { isValidIsraeliId } from "../../lib/israeliId";
import { BUILT_IN_ROLE_SEED } from "../../permissions/builtInRoleSeed";
import type { RoleRecord } from "../../permissions/types";
import { loadJson, removeKey, saveJson } from "../storage/localStore";
import type {
  ApiClient,
  ImportRow,
  ImportSummary,
  NewActivist,
  NewElectionDayVoter,
  NewPermissionUser,
  NewPermissionUserForRole,
  NewRideCoordinator,
  NewRole,
  NewVoter,
  Paged,
  RoleUpdate,
  VoterQuery,
} from "./types";

/** MockApi's own on-disk shape for a PermissionUser - keeps the plaintext
 * password internally for its local compare (this class's storage format is
 * unrelated to the real Supabase-backed implementation, which never stores
 * a plaintext password at all). Never returned as-is - always stripped down
 * to the public `PermissionUser` (no password) before leaving this class. */
interface StoredPermissionUser extends PermissionUser {
  password: string;
}

function toPublicPermissionUser(u: StoredPermissionUser): PermissionUser {
  return { id: u.id, name: u.name, role: u.role, roleId: u.roleId };
}

const STORE_KEY = "dataset-v1";
const ELECTION_DAY_VOTERS_KEY = "election-day-voters-v1";
const ELECTION_DAY_DEADLINE_KEY = "election-day-deadline-v1";
const ELECTION_DAY_EVENTS_KEY = "election-day-events-v1";
const RIDE_COORDINATORS_KEY = "election-day-ride-coordinators-v1";
const PERMISSION_USERS_KEY = "election-day-permission-users-v1";
const DAY_MS = 86_400_000;

/** Simulated network latency so loaders/skeletons are visible & realistic. */
const latency = () =>
  new Promise<void>((r) => {
    const { mockApiLatencyMinMs, mockApiLatencyMaxMs } = APP_CONFIG;
    const range = mockApiLatencyMaxMs - mockApiLatencyMinMs;
    setTimeout(r, mockApiLatencyMinMs + Math.random() * range);
  });

export class MockApi implements ApiClient {
  private data: Dataset;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private electionDayVoters: ElectionDayVoter[];
  private electionDayDeadline: string | null;
  private rideStatusEvents: RideStatusEvent[];
  private rideCoordinators: RideCoordinator[];
  private permissionUsers: StoredPermissionUser[];
  /** Interface compliance only (see `listElectionDayRoles`'s comment) - not
   * persisted, reset on every reload. */
  private roles: RoleRecord[];

  constructor() {
    this.data = loadJson<Dataset>(STORE_KEY) ?? generateDataset();
    this.electionDayVoters = loadJson<ElectionDayVoter[]>(ELECTION_DAY_VOTERS_KEY) ?? [];
    this.electionDayDeadline = loadJson<string | null>(ELECTION_DAY_DEADLINE_KEY) ?? null;
    this.rideStatusEvents = loadJson<RideStatusEvent[]>(ELECTION_DAY_EVENTS_KEY) ?? [];
    this.rideCoordinators = loadJson<RideCoordinator[]>(RIDE_COORDINATORS_KEY) ?? [];
    this.permissionUsers = loadJson<StoredPermissionUser[]>(PERMISSION_USERS_KEY) ?? [];
    this.roles = [...BUILT_IN_ROLE_SEED];
  }

  /** Debounced persistence - mutations land in localStorage at most every `persistDebounceMs`. */
  private persist() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(
      () => saveJson(STORE_KEY, this.data),
      APP_CONFIG.persistDebounceMs,
    );
  }

  // ---------------------------------------------------------------- dashboard

  async getStats(): Promise<CampaignStats> {
    await latency();
    const by: Record<Classification, number> = {
      supporter: 0,
      potential: 0,
      opponent: 0,
      unclassified: 0,
    };
    for (const v of this.data.voters) by[v.classification]++;
    const total = this.data.voters.length;
    const classified = total - by.unclassified;
    const activeWindowAgo = Date.now() - APP_CONFIG.activeActivistWindowDays * DAY_MS;
    return {
      totalVoters: total,
      byClassification: by,
      coveragePct: total ? Math.round((classified / total) * 1000) / 10 : 0,
      activeActivists: this.data.activists.filter(
        (a) => new Date(a.lastActiveAt).getTime() > activeWindowAgo,
      ).length,
      goal: Math.max(
        APP_CONFIG.campaignGoalMinimum,
        Math.round((total * APP_CONFIG.campaignGoalRatio) / 100) * 100,
      ),
      classificationsLast7Days: this.data.events.filter(
        (e) => new Date(e.at).getTime() > activeWindowAgo,
      ).length,
    };
  }

  async getTrend(days: number): Promise<TrendPoint[]> {
    await latency();
    const start = Date.now() - (days - 1) * DAY_MS;
    const byDate = new Map<string, TrendPoint>();
    for (let i = 0; i < days; i++) {
      const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
      byDate.set(date, { date, supporter: 0, potential: 0, opponent: 0 });
    }
    for (const e of this.data.events) {
      const point = byDate.get(e.at.slice(0, 10));
      if (point && e.classification !== "unclassified") point[e.classification]++;
    }
    // cumulative - the chart should climb
    let s = 0,
      p = 0,
      o = 0;
    return [...byDate.values()].map((d) => {
      s += d.supporter;
      p += d.potential;
      o += d.opponent;
      return { date: d.date, supporter: s, potential: p, opponent: o };
    });
  }

  async getCityBreakdown(): Promise<CityBreakdown[]> {
    await latency();
    const map = new Map<string, CityBreakdown>();
    for (const v of this.data.voters) {
      let c = map.get(v.city);
      if (!c) map.set(v.city, (c = { city: v.city, total: 0, supporters: 0 }));
      c.total++;
      if (v.classification === "supporter") c.supporters++;
    }
    return [...map.values()].sort((a, b) => b.supporters - a.supporters);
  }

  // ------------------------------------------------------------------- voters

  async listVoters(q: VoterQuery): Promise<Paged<Voter>> {
    await latency();
    let items = this.data.voters;

    if (q.search?.trim()) {
      const s = q.search.trim();
      const sLower = s.toLowerCase();
      items = items.filter(
        (v) =>
          `${v.firstName} ${v.lastName}`.toLowerCase().includes(sLower) ||
          v.nationalId.includes(s) ||
          (v.phone !== null && v.phone.replace("-", "").includes(s.replace("-", ""))),
      );
    }
    if (q.cities?.length) items = items.filter((v) => q.cities!.includes(v.city));
    if (q.classifications?.length)
      items = items.filter((v) => q.classifications!.includes(v.classification));
    if (q.pollingStationId)
      items = items.filter((v) => v.pollingStationId === q.pollingStationId);

    if (q.sortBy) {
      const dir = q.sortDir === "desc" ? -1 : 1;
      const key = q.sortBy;
      items = [...items].sort((a, b) => {
        const av = a[key] ?? "";
        const bv = b[key] ?? "";
        return (
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av).localeCompare(String(bv), "he")) * dir
        );
      });
    }

    const total = items.length;
    const offset = q.offset ?? 0;
    const limit = q.limit ?? total;
    return { items: items.slice(offset, offset + limit), total };
  }

  async getVoter(id: string): Promise<Voter | null> {
    await latency();
    return this.data.voters.find((v) => v.id === id) ?? null;
  }

  async addVoter(nv: NewVoter): Promise<Voter> {
    await latency();
    if (!isValidIsraeliId(nv.nationalId)) throw new Error("מספר תעודת זהות לא תקין");
    if (this.data.voters.some((v) => v.nationalId === nv.nationalId))
      throw new Error('בוחר עם ת"ז זו כבר קיים במערכת');
    const voter: Voter = {
      ...nv,
      id: `v-${crypto.randomUUID().slice(0, 8)}`,
      classification: "unclassified",
      classifiedBy: null,
      classifiedAt: null,
      notes: null,
      familyId: null,
      votedAt: null,
    };
    this.data.voters.push(voter);
    this.persist();
    return voter;
  }

  async updateVoter(id: string, patch: Partial<Voter>): Promise<Voter> {
    await latency();
    const voter = this.data.voters.find((v) => v.id === id);
    if (!voter) throw new Error("בוחר לא נמצא");
    Object.assign(voter, patch, { id: voter.id });
    this.persist();
    return voter;
  }

  async classifyVoter(
    voterId: string,
    classification: Classification,
    activistId: string,
    opts?: { includeFamily?: boolean },
  ): Promise<Voter[]> {
    await latency();
    const voter = this.data.voters.find((v) => v.id === voterId);
    if (!voter) throw new Error("בוחר לא נמצא");
    const targets =
      opts?.includeFamily && voter.familyId
        ? this.data.voters.filter((v) => v.familyId === voter.familyId)
        : [voter];

    const at = new Date().toISOString();
    const activist = this.data.activists.find((a) => a.id === activistId);
    for (const t of targets) {
      const wasClassified = t.classification !== "unclassified";
      t.classification = classification;
      t.classifiedBy = classification === "unclassified" ? null : activistId;
      t.classifiedAt = classification === "unclassified" ? null : at;
      if (classification !== "unclassified") {
        this.data.events.push({
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          voterId: t.id,
          activistId,
          classification,
          at,
        });
        if (activist) {
          if (!wasClassified) activist.tagCount++;
          activist.lastActiveAt = at;
        }
      }
    }
    this.persist();
    return targets;
  }

  async bulkClassify(
    voterIds: string[],
    classification: Classification,
    activistId: string,
  ): Promise<Voter[]> {
    await latency();
    const ids = new Set(voterIds);
    const targets = this.data.voters.filter((v) => ids.has(v.id));
    const at = new Date().toISOString();
    const activist = this.data.activists.find((a) => a.id === activistId);
    for (const t of targets) {
      const wasClassified = t.classification !== "unclassified";
      t.classification = classification;
      t.classifiedBy = classification === "unclassified" ? null : activistId;
      t.classifiedAt = classification === "unclassified" ? null : at;
      if (classification !== "unclassified") {
        this.data.events.push({
          id: `ev-${crypto.randomUUID().slice(0, 8)}`,
          voterId: t.id,
          activistId,
          classification,
          at,
        });
        if (activist && !wasClassified) activist.tagCount++;
      }
    }
    if (activist && targets.length && classification !== "unclassified")
      activist.lastActiveAt = at;
    this.persist();
    return targets;
  }

  async getVoterHistory(voterId: string): Promise<ClassificationEvent[]> {
    await latency();
    return this.data.events.filter((e) => e.voterId === voterId).reverse();
  }

  // ---------------------------------------------------------------- activists

  async listActivists(): Promise<Activist[]> {
    await latency();
    return [...this.data.activists].sort((a, b) => b.tagCount - a.tagCount);
  }

  async getActivist(id: string): Promise<Activist | null> {
    await latency();
    return this.data.activists.find((a) => a.id === id) ?? null;
  }

  async addActivist(na: NewActivist): Promise<Activist> {
    await latency();
    const now = new Date().toISOString();
    const activist: Activist = {
      ...na,
      id: `act-${crypto.randomUUID().slice(0, 8)}`,
      joinedAt: now,
      lastActiveAt: now,
      tagCount: 0,
    };
    this.data.activists.push(activist);
    this.persist();
    return activist;
  }

  async ensureActivistProfile(id: string, info: NewActivist): Promise<Activist> {
    await latency();
    const existing = this.data.activists.find((a) => a.id === id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const activist: Activist = {
      ...info,
      id,
      joinedAt: now,
      lastActiveAt: now,
      tagCount: 0,
    };
    this.data.activists.push(activist);
    this.persist();
    return activist;
  }

  async updateActivist(id: string, patch: Partial<Activist>): Promise<Activist> {
    await latency();
    const activist = this.data.activists.find((a) => a.id === id);
    if (!activist) throw new Error("פעיל לא נמצא");
    Object.assign(activist, patch, { id: activist.id });
    this.persist();
    return activist;
  }

  async getActivistEvents(activistId: string): Promise<ClassificationEvent[]> {
    await latency();
    return this.data.events.filter((e) => e.activistId === activistId);
  }

  // ------------------------------------------------------------ stations/meta

  async listStations(): Promise<PollingStation[]> {
    await latency();
    return [...this.data.stations];
  }

  async listCities(): Promise<string[]> {
    await latency();
    return [...new Set(this.data.voters.map((v) => v.city))].sort((a, b) =>
      a.localeCompare(b, "he"),
    );
  }

  // -------------------------------------------------------------------- data

  async importVoters(rows: ImportRow[]): Promise<ImportSummary> {
    await latency();
    const byNationalId = new Map(this.data.voters.map((v) => [v.nationalId, v]));
    const summary: ImportSummary = { added: 0, updated: 0, skipped: [] };
    const fallbackStation = this.data.stations[0];

    rows.forEach((row, i) => {
      const nationalId = String(row.nationalId ?? "")
        .trim()
        .padStart(9, "0");
      if (!isValidIsraeliId(nationalId)) {
        summary.skipped.push({ row: i + 1, reason: 'ת"ז לא תקינה' });
        return;
      }
      if (!row.firstName || !row.lastName) {
        summary.skipped.push({ row: i + 1, reason: "חסר שם פרטי או משפחה" });
        return;
      }
      const existing = byNationalId.get(nationalId);
      if (existing) {
        Object.assign(existing, {
          firstName: row.firstName,
          lastName: row.lastName,
          city: row.city ?? existing.city,
          street: row.street ?? existing.street,
          houseNumber: row.houseNumber ?? existing.houseNumber,
          phone: row.phone ?? existing.phone,
          birthYear: row.birthYear ?? existing.birthYear,
        });
        summary.updated++;
      } else {
        const station =
          this.data.stations.find((s) => s.city === row.city) ?? fallbackStation;
        const voter: Voter = {
          id: `v-${crypto.randomUUID().slice(0, 8)}`,
          nationalId,
          firstName: row.firstName,
          lastName: row.lastName,
          city: row.city ?? station.city,
          street: row.street ?? "",
          houseNumber: row.houseNumber ?? 0,
          phone: row.phone ?? null,
          birthYear: row.birthYear ?? 1980,
          pollingStationId: station.id,
          classification: "unclassified",
          classifiedBy: null,
          classifiedAt: null,
          notes: null,
          familyId: null,
          votedAt: null,
        };
        this.data.voters.push(voter);
        byNationalId.set(nationalId, voter);
        summary.added++;
      }
    });

    this.persist();
    return summary;
  }

  async resetToDemo(): Promise<void> {
    await latency();
    this.data = generateDataset();
    removeKey(STORE_KEY);
  }

  async clearAll(): Promise<void> {
    await latency();
    this.data = { voters: [], activists: [], stations: [], events: [] };
    this.persist();
  }

  // --------------------------------------------------------------- election day

  async importElectionDayVoters(rows: NewElectionDayVoter[]): Promise<{ count: number }> {
    await latency();
    this.electionDayVoters = rows.map((r) => ({
      ...r,
      id: `edv-${crypto.randomUUID().slice(0, 8)}`,
      notes: "",
      rideRequested: false,
      rideRequestedAt: null,
      rideArranged: false,
      rideArrangedAt: null,
      rideCompleted: false,
      rideCompletedAt: null,
      reminderAt: null,
      voted: false,
      votedAt: null,
    }));
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    // A fresh import is a new ride-list for the day - last time's log no longer applies.
    this.rideStatusEvents = [];
    saveJson(ELECTION_DAY_EVENTS_KEY, this.rideStatusEvents);
    return { count: this.electionDayVoters.length };
  }

  async listElectionDayVoters(): Promise<ElectionDayVoter[]> {
    await latency();
    return [...this.electionDayVoters];
  }

  async clearElectionDayVoters(): Promise<void> {
    await latency();
    this.electionDayVoters = [];
    this.rideStatusEvents = [];
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    saveJson(ELECTION_DAY_EVENTS_KEY, this.rideStatusEvents);
  }

  async setRideRequested(id: string, requested: boolean): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.rideRequested = requested;
    contact.rideRequestedAt = requested ? new Date().toISOString() : null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async setRideArranged(id: string, arranged: boolean): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    const from = contact.rideArranged;
    contact.rideArranged = arranged;
    contact.rideArrangedAt = arranged ? new Date().toISOString() : null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);

    this.rideStatusEvents.push({
      id: `ede-${crypto.randomUUID().slice(0, 8)}`,
      contactId: contact.id,
      contactName: `${contact.firstName} ${contact.lastName}`,
      coordinator: contact.coordinator,
      from,
      to: arranged,
      at: new Date().toISOString(),
    });
    saveJson(ELECTION_DAY_EVENTS_KEY, this.rideStatusEvents);

    return contact;
  }

  async setRideCompleted(id: string, completed: boolean): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.rideCompleted = completed;
    contact.rideCompletedAt = completed ? new Date().toISOString() : null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async listRideStatusEvents(): Promise<RideStatusEvent[]> {
    await latency();
    return [...this.rideStatusEvents].reverse();
  }

  async setReminder(
    id: string,
    minutesFromNow: number | null,
  ): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.reminderAt =
      minutesFromNow === null
        ? null
        : new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async setVoted(id: string, voted: boolean): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.voted = voted;
    contact.votedAt = voted ? new Date().toISOString() : null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async getElectionDayDeadline(): Promise<string | null> {
    await latency();
    return this.electionDayDeadline;
  }

  async setElectionDayDeadline(deadline: string | null): Promise<string | null> {
    await latency();
    this.electionDayDeadline = deadline;
    saveJson(ELECTION_DAY_DEADLINE_KEY, deadline);
    return deadline;
  }

  async setElectionDayNotes(id: string, notes: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.notes = notes;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async setPhone(id: string, phone: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.phone = phone;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async listRideCoordinators(): Promise<RideCoordinator[]> {
    await latency();
    return [...this.rideCoordinators];
  }

  async addRideCoordinator(input: NewRideCoordinator): Promise<RideCoordinator> {
    await latency();
    const coordinator: RideCoordinator = {
      id: `rc-${crypto.randomUUID().slice(0, 8)}`,
      ...input,
    };
    this.rideCoordinators.push(coordinator);
    saveJson(RIDE_COORDINATORS_KEY, this.rideCoordinators);
    return coordinator;
  }

  async deleteRideCoordinator(id: string): Promise<void> {
    await latency();
    this.rideCoordinators = this.rideCoordinators.filter((c) => c.id !== id);
    saveJson(RIDE_COORDINATORS_KEY, this.rideCoordinators);
  }

  async listPermissionUsers(): Promise<PermissionUser[]> {
    await latency();
    return this.permissionUsers.map(toPublicPermissionUser);
  }

  async addPermissionUser(input: NewPermissionUser): Promise<PermissionUser> {
    await latency();
    const roleId =
      this.roles.find((r) => r.legacyRoleKey === input.role)?.id ??
      `legacy-${input.role}`;
    const user: StoredPermissionUser = {
      id: `pu-${crypto.randomUUID().slice(0, 8)}`,
      roleId,
      ...input,
    };
    this.permissionUsers.push(user);
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
    return toPublicPermissionUser(user);
  }

  async deletePermissionUser(id: string): Promise<void> {
    await latency();
    this.permissionUsers = this.permissionUsers.filter((u) => u.id !== id);
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
  }

  async verifyPermissionUserLogin(
    name: string,
    password: string,
  ): Promise<PermissionUser | null> {
    await latency();
    const match = this.permissionUsers.find(
      (u) => u.name === name.trim() && u.password === password,
    );
    return match ? toPublicPermissionUser(match) : null;
  }

  /** Interface compliance only - never actually reached in the running app
   * (`services/api/index.ts` always delegates every Election Day method to
   * `SupabaseElectionDayApi`). Returns the same 3 built-in roles the Phase 0
   * migration seeded, so `MockApi` behaves sanely if ever exercised
   * directly. */
  async listElectionDayRoles(): Promise<RoleRecord[]> {
    await latency();
    return [...this.roles];
  }

  /** Interface compliance only (see `listElectionDayRoles`'s comment) - a
   * minimal, non-persisted mirror of the real RPCs' shape, not their full
   * validation/guard behavior. */
  async createRole(input: NewRole): Promise<RoleRecord> {
    await latency();
    const role: RoleRecord = {
      id: `role-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      scopeType: input.scopeType,
      scopeValue: null,
      legacyRoleKey: null,
    };
    this.roles.push(role);
    return role;
  }

  async updateRole(input: RoleUpdate): Promise<RoleRecord> {
    await latency();
    const existing = this.roles.find((r) => r.id === input.id);
    if (!existing) throw new Error("התפקיד לא נמצא");
    const updated: RoleRecord = {
      ...existing,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      scopeType: input.scopeType,
    };
    this.roles = this.roles.map((r) => (r.id === input.id ? updated : r));
    return updated;
  }

  async deleteRole(id: string): Promise<void> {
    await latency();
    if (this.permissionUsers.some((u) => u.roleId === id)) {
      throw new Error("לא ניתן למחוק תפקיד שיש לו משתמשים משויכים");
    }
    this.roles = this.roles.filter((r) => r.id !== id);
  }

  async cloneRole(id: string, newName: string): Promise<RoleRecord> {
    await latency();
    const source = this.roles.find((r) => r.id === id);
    if (!source) throw new Error("התפקיד לא נמצא");
    const clone: RoleRecord = {
      ...source,
      id: `role-${crypto.randomUUID().slice(0, 8)}`,
      name: newName,
      legacyRoleKey: null,
    };
    this.roles.push(clone);
    return clone;
  }

  async createPermissionUserForRole(
    input: NewPermissionUserForRole,
  ): Promise<PermissionUser> {
    await latency();
    const user: StoredPermissionUser = {
      id: `pu-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      password: input.password,
      role: null,
      roleId: input.roleId,
    };
    this.permissionUsers.push(user);
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
    return toPublicPermissionUser(user);
  }
}
