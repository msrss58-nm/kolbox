import type {
  Activist,
  CampaignStats,
  CityBreakdown,
  Classification,
  ClassificationEvent,
  Coordinator,
  ElectionDayVoter,
  NonVotingReason,
  PermissionUser,
  PollingStation,
  ReminderEvent,
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
  AllocationAssignment,
  ApiClient,
  ApplyInitialAllocationResult,
  CoordinatorAction,
  EndCoordinatorActivityMode,
  EndCoordinatorActivityResult,
  ImportRow,
  ImportSummary,
  NewActivist,
  NewElectionDayVoter,
  NewNonVotingReason,
  NewPermissionUser,
  NewRideCoordinator,
  NewRole,
  NewVoter,
  NonVotingReasonUpdate,
  Paged,
  RebalanceAssignmentsResult,
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
  return { id: u.id, name: u.name, roleId: u.roleId };
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
  /** Interface compliance only - Election Day always delegates to
   * `SupabaseElectionDayApi` in the real app (see `services/api/index.ts`),
   * so this never actually backs the running UI. Not persisted, reset on
   * every reload. */
  private nonVotingReasons: NonVotingReason[];
  /** Coordinator Allocation Management: interface compliance only, same
   * reasoning as `roles`/`nonVotingReasons` above - Election Day always
   * delegates to `SupabaseElectionDayApi`. A minimal, non-persisted,
   * deterministic in-memory mirror of the 4 real RPCs' shape - NOT a second
   * copy of their full server-side validation (cross-column name-collision
   * invariant, per-coordinator participation locks, advisory-lock
   * concurrency, exact locked-id pinning). Good enough to keep `MockApi`
   * type-checking as `ApiClient` and behave sanely if ever exercised
   * directly (e.g. a future unit test); never treat this as a security or
   * business-rule reference for the real RPCs. */
  private coordinators: Coordinator[];

  constructor() {
    this.data = loadJson<Dataset>(STORE_KEY) ?? generateDataset();
    this.electionDayVoters = loadJson<ElectionDayVoter[]>(ELECTION_DAY_VOTERS_KEY) ?? [];
    this.electionDayDeadline = loadJson<string | null>(ELECTION_DAY_DEADLINE_KEY) ?? null;
    this.rideStatusEvents = loadJson<RideStatusEvent[]>(ELECTION_DAY_EVENTS_KEY) ?? [];
    this.rideCoordinators = loadJson<RideCoordinator[]>(RIDE_COORDINATORS_KEY) ?? [];
    this.permissionUsers = loadJson<StoredPermissionUser[]>(PERMISSION_USERS_KEY) ?? [];
    this.roles = [...BUILT_IN_ROLE_SEED];
    this.nonVotingReasons = [];
    this.coordinators = [];
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

  async importElectionDayVoters(
    _proof: string,
    rows: NewElectionDayVoter[],
  ): Promise<{ count: number }> {
    await latency();
    this.electionDayVoters = rows.map((r) => ({
      ...r,
      // ElectionDayVoter.coordinator stays a plain string - "" is this app's
      // existing sentinel for "no coordinator" (see toVoter's identical
      // coercion in supabaseElectionDayApi.ts).
      coordinator: r.coordinator ?? "",
      id: `edv-${crypto.randomUUID().slice(0, 8)}`,
      notes: "",
      rideRequested: false,
      rideRequestedAt: null,
      rideArranged: false,
      rideArrangedAt: null,
      rideCompleted: false,
      rideCompletedAt: null,
      reminderAt: null,
      reminderClosedAt: null,
      reminderClosedReason: null,
      reminderClosedBy: null,
      voted: false,
      votedAt: null,
      notVotingReasonId: null,
      notVotingReasonSetAt: null,
      notVotingReasonSetBy: null,
      callAttempts: 0,
      callAttemptsThreshold: 3,
      lastCallAttemptAt: null,
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

  /** Reminder Lifecycle v1: creating/rescheduling a reminder resets any
   * previous closure metadata - mirrors `election_day_set_reminder`'s
   * behavior (no in-memory reminder-events log is maintained here, see this
   * class's own doc comment on `listReminderEvents`). */
  async setReminder(id: string, minutesFromNow: number): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.reminderAt = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
    contact.reminderClosedAt = null;
    contact.reminderClosedReason = null;
    contact.reminderClosedBy = null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  async setReminderAt(id: string, at: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.reminderAt = at;
    contact.reminderClosedAt = null;
    contact.reminderClosedReason = null;
    contact.reminderClosedBy = null;
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  /** Reminder Lifecycle v1: explicit "mark handled". Idempotent no-op if no
   * reminder is currently open - mirrors `election_day_close_reminder`. */
  async closeReminder(id: string, actorName: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    if (contact.reminderAt !== null) {
      contact.reminderAt = null;
      contact.reminderClosedAt = new Date().toISOString();
      contact.reminderClosedReason = "handled";
      contact.reminderClosedBy = actorName;
      saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    }
    return contact;
  }

  /** Reminder Lifecycle v1: explicit cancel. Idempotent no-op if no reminder
   * is currently open - mirrors `election_day_cancel_reminder`. */
  async cancelReminder(id: string, actorName: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    if (contact.reminderAt !== null) {
      contact.reminderAt = null;
      contact.reminderClosedAt = new Date().toISOString();
      contact.reminderClosedReason = "cancelled";
      contact.reminderClosedBy = actorName;
      saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    }
    return contact;
  }

  /** Reminder Lifecycle v1: setting `voted = true` also closes any currently
   * open reminder (`reason: "voted"`) - un-voting never touches reminder
   * state. Mirrors `election_day_set_voted`. */
  async setVoted(
    id: string,
    voted: boolean,
    actorName: string,
  ): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.voted = voted;
    contact.votedAt = voted ? new Date().toISOString() : null;
    if (voted && contact.reminderAt !== null) {
      contact.reminderAt = null;
      contact.reminderClosedAt = new Date().toISOString();
      contact.reminderClosedReason = "voted";
      contact.reminderClosedBy = actorName;
    }
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  /** Reminder Lifecycle v1: if the newly-set reason's `requiresFollowUp` is
   * `false`, also closes any currently open reminder (`reason:
   * "case_closed"`) - mirrors `election_day_set_non_voting_reason`. Since
   * `this.nonVotingReasons` is never actually populated in the running app
   * (see that field's own doc comment - Election Day always delegates to
   * `SupabaseElectionDayApi`), this lookup is here for behavioral parity
   * only and will typically find nothing. */
  async setNonVotingReason(
    id: string,
    reasonId: string | null,
    setByName: string | null,
  ): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    contact.notVotingReasonId = reasonId;
    contact.notVotingReasonSetAt = reasonId ? new Date().toISOString() : null;
    contact.notVotingReasonSetBy = reasonId ? setByName : null;
    const reason = reasonId
      ? this.nonVotingReasons.find((r) => r.id === reasonId)
      : undefined;
    if (reason && !reason.requiresFollowUp && contact.reminderAt !== null) {
      contact.reminderAt = null;
      contact.reminderClosedAt = new Date().toISOString();
      contact.reminderClosedReason = "case_closed";
      contact.reminderClosedBy = setByName;
    }
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return contact;
  }

  /** Reminder Lifecycle v1: no consumer reads mock reminder-event history
   * today (Election Day always delegates to `SupabaseElectionDayApi` in the
   * real app - see `nonVotingReasons`' field comment for the same pattern) -
   * an empty array is the simplest correct choice rather than maintaining a
   * parallel in-memory events log nothing reads. Deliberate scope-limiting
   * decision, not an oversight. */
  async listReminderEvents(): Promise<ReminderEvent[]> {
    await latency();
    return [];
  }

  async incrementCallAttempts(id: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    // Server-side quota guard mirror (see election_day_increment_call_attempts):
    // once the quota is reached, return the row unchanged rather than
    // incrementing past callAttemptsThreshold.
    if (contact.callAttempts < contact.callAttemptsThreshold) {
      contact.callAttempts += 1;
      contact.lastCallAttemptAt = new Date().toISOString();
      saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    }
    return contact;
  }

  async extendCallAttemptsThreshold(id: string): Promise<ElectionDayVoter> {
    await latency();
    const contact = this.electionDayVoters.find((v) => v.id === id);
    if (!contact) throw new Error("רשומה לא נמצאה");
    // Server-side quota guard mirror (see election_day_extend_call_attempts_threshold):
    // extension is only valid while the quota has actually been reached -
    // a duplicate/concurrent extend request returns the row unchanged.
    if (contact.callAttempts === contact.callAttemptsThreshold) {
      contact.callAttemptsThreshold += 3;
      saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    }
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

  async deletePermissionUser(_proof: string, id: string): Promise<void> {
    await latency();
    this.permissionUsers = this.permissionUsers.filter((u) => u.id !== id);
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
  }

  /** Interface compliance only - never actually reached in the running app
   * (see `listElectionDayRoles`'s comment). Unlike the real
   * `_v2` RPC (which resolves the actor from a real, server-issued proof),
   * this stub has no equivalent proof registry to resolve `proof` against,
   * so it only checks the target/new-password shape - not a meaningful
   * re-authentication mirror. */
  async resetPermissionUserPassword(
    _proof: string,
    targetId: string,
    newPassword: string,
  ): Promise<PermissionUser> {
    await latency();
    const target = this.permissionUsers.find((u) => u.id === targetId);
    if (!target) throw new Error("המשתמש לא נמצא");
    target.password = newPassword;
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
    return toPublicPermissionUser(target);
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
   * (see `listElectionDayRoles`'s comment). Returns a fake opaque token
   * after checking the given actor id/password against this class's own
   * plaintext password store, mirroring the real `election_day_reauth`
   * RPC's shape closely enough for MockApi to behave sanely if ever
   * exercised directly. */
  async reauth(actorId: string, actorPassword: string): Promise<string> {
    await latency();
    const actor = this.permissionUsers.find((u) => u.id === actorId);
    if (!actor || actor.password !== actorPassword) {
      throw new Error("הסיסמה שהזנת אינה נכונה");
    }
    return `mock-proof-${crypto.randomUUID()}`;
  }

  /** Interface compliance only - a no-op mirror of the real RPC's
   * best-effort, never-throws contract. */
  async revokeReauthProof(): Promise<void> {
    await latency();
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
  async createRole(_proof: string, input: NewRole): Promise<RoleRecord> {
    await latency();
    const role: RoleRecord = {
      id: `role-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      scopeType: input.scopeType,
      scopeValue: null,
    };
    this.roles.push(role);
    return role;
  }

  async updateRole(_proof: string, input: RoleUpdate): Promise<RoleRecord> {
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

  async deleteRole(_proof: string, id: string): Promise<void> {
    await latency();
    if (this.permissionUsers.some((u) => u.roleId === id)) {
      throw new Error("לא ניתן למחוק תפקיד שיש לו משתמשים משויכים");
    }
    this.roles = this.roles.filter((r) => r.id !== id);
  }

  async cloneRole(_proof: string, id: string, newName: string): Promise<RoleRecord> {
    await latency();
    const source = this.roles.find((r) => r.id === id);
    if (!source) throw new Error("התפקיד לא נמצא");
    const clone: RoleRecord = {
      ...source,
      id: `role-${crypto.randomUUID().slice(0, 8)}`,
      name: newName,
    };
    this.roles.push(clone);
    return clone;
  }

  async createPermissionUser(
    _proof: string,
    input: NewPermissionUser,
  ): Promise<PermissionUser> {
    await latency();
    const user: StoredPermissionUser = {
      id: `pu-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      password: input.password,
      roleId: input.roleId,
    };
    this.permissionUsers.push(user);
    saveJson(PERMISSION_USERS_KEY, this.permissionUsers);
    return toPublicPermissionUser(user);
  }

  /** Interface compliance only (see `nonVotingReasons`' field comment) - a
   * minimal, non-persisted mirror of the real RPCs' shape, not their full
   * validation/guard behavior. */
  async listNonVotingReasons(): Promise<NonVotingReason[]> {
    await latency();
    return [...this.nonVotingReasons];
  }

  async createNonVotingReason(input: NewNonVotingReason): Promise<NonVotingReason> {
    await latency();
    const reason: NonVotingReason = {
      id: `nvr-${crypto.randomUUID().slice(0, 8)}`,
      name: input.name,
      description: input.description,
      isActive: true,
      sortOrder: this.nonVotingReasons.length,
      requiresFollowUp: input.requiresFollowUp,
    };
    this.nonVotingReasons.push(reason);
    return reason;
  }

  async updateNonVotingReason(input: NonVotingReasonUpdate): Promise<NonVotingReason> {
    await latency();
    const existing = this.nonVotingReasons.find((r) => r.id === input.id);
    if (!existing) throw new Error("הסיבה לא נמצאה");
    const updated: NonVotingReason = {
      ...existing,
      name: input.name,
      description: input.description,
      requiresFollowUp: input.requiresFollowUp,
    };
    this.nonVotingReasons = this.nonVotingReasons.map((r) =>
      r.id === input.id ? updated : r,
    );
    return updated;
  }

  async setNonVotingReasonActive(
    id: string,
    isActive: boolean,
  ): Promise<NonVotingReason> {
    await latency();
    const existing = this.nonVotingReasons.find((r) => r.id === id);
    if (!existing) throw new Error("הסיבה לא נמצאה");
    const updated: NonVotingReason = { ...existing, isActive };
    this.nonVotingReasons = this.nonVotingReasons.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  async deleteNonVotingReason(id: string): Promise<void> {
    await latency();
    if (this.electionDayVoters.some((v) => v.notVotingReasonId === id)) {
      throw new Error("לא ניתן למחוק סיבה המשויכת לבוחרים");
    }
    this.nonVotingReasons = this.nonVotingReasons.filter((r) => r.id !== id);
  }

  async reorderNonVotingReasons(orderedIds: string[]): Promise<NonVotingReason[]> {
    await latency();
    this.nonVotingReasons = orderedIds
      .map((id, index) => {
        const existing = this.nonVotingReasons.find((r) => r.id === id);
        return existing ? { ...existing, sortOrder: index } : null;
      })
      .filter((r): r is NonVotingReason => r !== null);
    return [...this.nonVotingReasons];
  }

  /** Interface compliance only (see `coordinators`' field comment) - mirrors
   * the real RPCs' 2-step server-side re-auth (bcrypt-equivalent plaintext
   * compare against this store, then the actor role's
   * `electionDay.manageCoordinatorAllocation`), same pattern as
   * `resetPermissionUserPassword` above. */
  private authorizeCoordinatorActor(actorId: string, actorPassword: string): void {
    const actor = this.permissionUsers.find((u) => u.id === actorId);
    if (!actor || actor.password !== actorPassword) {
      throw new Error("הסיסמה שהזנת אינה נכונה");
    }
    const actorRole = this.roles.find((r) => r.id === actor.roleId);
    if (!actorRole?.permissions.includes("electionDay.manageCoordinatorAllocation")) {
      throw new Error("אין לך הרשאה לבצע פעולה זו");
    }
  }

  /** A voter still "remaining" (transferable) per this mock's simplified
   * mirror of `resolveFollowUpStatus`'s "remaining" branch - `nonVotingReasons`
   * is always empty in `MockApi` (interface compliance only, see that
   * field's comment), so any `notVotingReasonId` is always unresolvable and
   * therefore always fails open to "still requires follow-up", same
   * direction as the real `election_day_voter_is_remaining` SQL helper -
   * this collapses to a plain `!voted` check here. */
  private isRemainingVoter(v: ElectionDayVoter): boolean {
    return !v.voted;
  }

  async listCoordinators(): Promise<Coordinator[]> {
    await latency();
    return [...this.coordinators];
  }

  /** Interface compliance only - a minimal, non-persisted mirror of
   * `election_day_manage_coordinators`'s add/edit/remove/link/relink/unlink
   * shape, not its full validation (no cross-column name-collision
   * invariant, no per-coordinator participation lock). */
  async manageCoordinators(
    actorId: string,
    actorPassword: string,
    actions: CoordinatorAction[],
  ): Promise<Coordinator[]> {
    await latency();
    this.authorizeCoordinatorActor(actorId, actorPassword);
    const now = new Date().toISOString();
    for (const a of actions) {
      if (a.action === "add") {
        if (!a.displayName?.trim()) throw new Error("יש להזין שם תקין לרכז");
        this.coordinators.push({
          id: `coord-${crypto.randomUUID().slice(0, 8)}`,
          displayName: a.displayName.trim(),
          status: "active",
          linkedAssignmentName: null,
          createdAt: now,
          endedAt: null,
        });
      } else if (a.action === "edit") {
        const c = this.coordinators.find((x) => x.id === a.coordinatorId);
        if (!c) throw new Error("הרכז לא נמצא");
        if (!a.displayName?.trim()) throw new Error("יש להזין שם תקין לרכז");
        c.displayName = a.displayName.trim();
      } else if (a.action === "remove") {
        if (!this.coordinators.some((x) => x.id === a.coordinatorId)) {
          throw new Error("הרכז לא נמצא");
        }
        this.coordinators = this.coordinators.filter((x) => x.id !== a.coordinatorId);
      } else if (a.action === "link" || a.action === "relink") {
        const c = this.coordinators.find((x) => x.id === a.coordinatorId);
        if (!c) throw new Error("הרכז לא נמצא");
        if (!a.linkedAssignmentName?.trim()) throw new Error("נתוני הקישור אינם תקינים");
        c.linkedAssignmentName = a.linkedAssignmentName.trim();
      } else if (a.action === "unlink") {
        const c = this.coordinators.find((x) => x.id === a.coordinatorId);
        if (!c) throw new Error("הרכז לא נמצא");
        c.linkedAssignmentName = null;
      } else {
        throw new Error("פעולה לא מוכרת");
      }
    }
    return [...this.coordinators];
  }

  /** Interface compliance only - distributes every currently-unassigned
   * voter (`coordinator === ""`, this app's sentinel - see
   * `ElectionDayVoter.coordinator`'s own comment) across the given
   * coordinators in array order, deterministically. Not a full mirror of
   * the real RPC's row-locking/count-revalidation. */
  async applyInitialAllocation(
    actorId: string,
    actorPassword: string,
    assignments: AllocationAssignment[],
  ): Promise<ApplyInitialAllocationResult> {
    await latency();
    this.authorizeCoordinatorActor(actorId, actorPassword);
    const unassigned = this.electionDayVoters.filter((v) => v.coordinator === "");
    const sumQuantities = assignments.reduce((sum, a) => sum + a.quantity, 0);
    if (unassigned.length === 0) throw new Error("אין בוחרים לא-מוקצים כרגע");
    if (sumQuantities !== unassigned.length) {
      throw new Error(
        "כמות ההקצאה אינה תואמת את מספר הבוחרים הלא-מוקצים בפועל - רעננו ונסו שוב",
      );
    }
    let cursor = 0;
    for (const a of assignments) {
      const coordinator = this.coordinators.find((c) => c.id === a.coordinatorId);
      if (!coordinator) throw new Error("הרכז לא נמצא");
      for (let i = 0; i < a.quantity; i++) {
        unassigned[cursor].coordinator = coordinator.displayName;
        cursor++;
      }
    }
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return {
      operationId: `op-${crypto.randomUUID().slice(0, 8)}`,
      allocatedCount: unassigned.length,
      remainingUnassignedCount: 0,
    };
  }

  /** Interface compliance only - transfers `quantity` "remaining" voters
   * (see `isRemainingVoter`) from each source coordinator to each
   * destination coordinator, in array order. Not a full mirror of the real
   * RPC's row-locking/count-revalidation/exact-id pinning. */
  async rebalanceAssignments(
    actorId: string,
    actorPassword: string,
    sources: AllocationAssignment[],
    destinations: AllocationAssignment[],
  ): Promise<RebalanceAssignmentsResult> {
    await latency();
    this.authorizeCoordinatorActor(actorId, actorPassword);
    const transferred: ElectionDayVoter[] = [];
    for (const s of sources) {
      const source = this.coordinators.find((c) => c.id === s.coordinatorId);
      if (!source) throw new Error("הרכז לא נמצא");
      const names = [source.displayName, source.linkedAssignmentName].filter(
        (n): n is string => n !== null,
      );
      const eligible = this.electionDayVoters.filter(
        (v) => names.includes(v.coordinator) && this.isRemainingVoter(v),
      );
      if (eligible.length < s.quantity) {
        throw new Error("אין מספיק בוחרים זמינים אצל הרכז המקור - רעננו ונסו שוב");
      }
      transferred.push(...eligible.slice(0, s.quantity));
    }
    let cursor = 0;
    for (const d of destinations) {
      const destination = this.coordinators.find((c) => c.id === d.coordinatorId);
      if (!destination) throw new Error("הרכז לא נמצא");
      for (let i = 0; i < d.quantity && cursor < transferred.length; i++, cursor++) {
        transferred[cursor].coordinator = destination.displayName;
      }
    }
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return {
      operationId: `op-${crypto.randomUUID().slice(0, 8)}`,
      transferredCount: transferred.length,
    };
  }

  /** Interface compliance only - moves every "remaining" voter of
   * `coordinatorId` either to `targetCoordinatorId` (`mode: "transfer"`) or
   * split evenly across every other active coordinator (`mode:
   * "equal_split"`), then marks the source `status: "ended"`. Not a full
   * mirror of the real RPC's row-locking/last-active-coordinator guard
   * ordering/exact-id pinning. */
  async endCoordinatorActivity(
    actorId: string,
    actorPassword: string,
    coordinatorId: string,
    mode: EndCoordinatorActivityMode,
    targetCoordinatorId: string | null,
  ): Promise<EndCoordinatorActivityResult> {
    await latency();
    this.authorizeCoordinatorActor(actorId, actorPassword);
    const source = this.coordinators.find((c) => c.id === coordinatorId);
    if (!source) throw new Error("הרכז לא נמצא");
    const names = [source.displayName, source.linkedAssignmentName].filter(
      (n): n is string => n !== null,
    );
    const remaining = this.electionDayVoters.filter(
      (v) => names.includes(v.coordinator) && this.isRemainingVoter(v),
    );

    if (mode === "transfer") {
      const target = this.coordinators.find((c) => c.id === targetCoordinatorId);
      if (!target || target.id === source.id) {
        throw new Error("יש לבחור רכז יעד תקין, שאינו הרכז המסיים עצמו");
      }
      for (const v of remaining) v.coordinator = target.displayName;
    } else {
      const otherActive = this.coordinators.filter(
        (c) => c.status === "active" && c.id !== source.id,
      );
      if (remaining.length > 0 && otherActive.length === 0) {
        throw new Error(
          "לא ניתן לסיים את פעילות הרכז האחרון הפעיל כל עוד יש לו בוחרים שנותרו לטיפול",
        );
      }
      remaining.forEach((v, i) => {
        v.coordinator = otherActive[i % otherActive.length].displayName;
      });
    }

    source.status = "ended";
    source.endedAt = new Date().toISOString();
    saveJson(ELECTION_DAY_VOTERS_KEY, this.electionDayVoters);
    return {
      operationId: `op-${crypto.randomUUID().slice(0, 8)}`,
      transferredCount: remaining.length,
      endedCoordinatorId: source.id,
      endedCoordinatorDisplayName: source.displayName,
    };
  }
}
