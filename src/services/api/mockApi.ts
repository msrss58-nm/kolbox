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
import { APP_CONFIG } from "../../constants/config";
import { generateDataset, type Dataset } from "../../data/generator";
import { isValidIsraeliId } from "../../lib/israeliId";
import { loadJson, removeKey, saveJson } from "../storage/localStore";
import type {
  ApiClient,
  ImportRow,
  ImportSummary,
  NewActivist,
  NewVoter,
  Paged,
  VoterQuery,
} from "./types";

const STORE_KEY = "dataset-v1";
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

  constructor() {
    this.data = loadJson<Dataset>(STORE_KEY) ?? generateDataset();
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
    const activist: Activist = { ...info, id, joinedAt: now, lastActiveAt: now, tagCount: 0 };
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
}
