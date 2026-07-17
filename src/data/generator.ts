import { APP_CONFIG } from "../constants/config";
import type {
  Activist,
  Classification,
  ClassificationEvent,
  PollingStation,
  Voter,
} from "../types";
import { israeliIdCheckDigit } from "../lib/israeliId";
import { CITIES, FIRST_NAMES, LAST_NAMES, STATION_VENUES } from "./pools";

export interface Dataset {
  voters: Voter[];
  activists: Activist[];
  stations: PollingStation[];
  events: ClassificationEvent[];
}

/** mulberry32 - tiny seeded PRNG so demo data is deterministic. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;

export function generateDataset(opts?: {
  voterCount?: number;
  seed?: number;
  now?: number;
}): Dataset {
  const voterCount = opts?.voterCount ?? APP_CONFIG.demoVoterCount;
  const rnd = mulberry32(opts?.seed ?? APP_CONFIG.demoSeed);
  const now = opts?.now ?? Date.now();

  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const int = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const iso = (t: number) => new Date(t).toISOString();

  // --- weighted city picker -------------------------------------------------
  const totalWeight = CITIES.reduce((s, c) => s + c.weight, 0);
  const pickCity = () => {
    let r = rnd() * totalWeight;
    for (const c of CITIES) {
      r -= c.weight;
      if (r <= 0) return c;
    }
    return CITIES[0];
  };

  // --- polling stations (~1 per 500 voters per city, min 2) ------------------
  const stations: PollingStation[] = [];
  const stationsByCity = new Map<string, PollingStation[]>();
  let stationNumber = 1;
  for (const city of CITIES) {
    const count = Math.max(
      2,
      Math.round((voterCount * (city.weight / totalWeight)) / 500),
    );
    const list: PollingStation[] = [];
    for (let i = 0; i < count; i++) {
      const st: PollingStation = {
        id: `st-${stationNumber}`,
        number: stationNumber++,
        city: city.name,
        address: `${pick(STATION_VENUES)}, רח' ${pick(city.streets)} ${int(1, 80)}`,
        registeredVoters: 0,
      };
      list.push(st);
      stations.push(st);
    }
    stationsByCity.set(city.name, list);
  }

  // --- activists (power-law productivity for an interesting leaderboard) -----
  const activists: Activist[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < 25; i++) {
    let first = pick(FIRST_NAMES);
    let last = pick(LAST_NAMES);
    while (usedNames.has(`${first} ${last}`)) {
      first = pick(FIRST_NAMES);
      last = pick(LAST_NAMES);
    }
    usedNames.add(`${first} ${last}`);
    activists.push({
      id: `act-${i + 1}`,
      firstName: first,
      lastName: last,
      phone: `05${int(0, 4)}-${int(1000000, 9999999)}`,
      area: pickCity().name,
      joinedAt: iso(now - int(30, 90) * DAY_MS),
      lastActiveAt: iso(now - int(0, 10) * DAY_MS - int(0, 23) * 3_600_000),
      tagCount: 0,
    });
  }
  // productivity weights: a few stars, a long tail
  const productivity = activists.map((_, i) => 1 / (i + 1));
  const prodSum = productivity.reduce((s, p) => s + p, 0);
  const pickActivist = () => {
    let r = rnd() * prodSum;
    for (let i = 0; i < activists.length; i++) {
      r -= productivity[i];
      if (r <= 0) return activists[i];
    }
    return activists[0];
  };

  // --- voters, generated household-by-household ------------------------------
  const voters: Voter[] = [];
  const events: ClassificationEvent[] = [];
  let voterIdx = 0;
  let familyIdx = 0;
  let eventIdx = 0;

  while (voters.length < voterCount) {
    const city = pickCity();
    const cityStations = stationsByCity.get(city.name)!;
    const station = pick(cityStations);
    const lastName = pick(LAST_NAMES);
    const street = pick(city.streets);
    const house = int(1, 120);
    const householdSize = Math.min(int(1, 6), voterCount - voters.length);
    const familyId = householdSize > 1 ? `fam-${++familyIdx}` : null;

    for (let m = 0; m < householdSize; m++) {
      voterIdx++;
      const first8 = String(int(10000000, 59999999));
      const voter: Voter = {
        id: `v-${voterIdx}`,
        nationalId: first8 + israeliIdCheckDigit(first8),
        firstName: pick(FIRST_NAMES),
        lastName,
        city: city.name,
        street,
        houseNumber: house,
        phone: rnd() < 0.85 ? `05${int(0, 4)}-${int(1000000, 9999999)}` : null,
        birthYear: m < 2 ? int(1950, 1985) : int(1986, 2008), // parents then kids
        pollingStationId: station.id,
        classification: "unclassified",
        classifiedBy: null,
        classifiedAt: null,
        notes: null,
        familyId,
        votedAt: null,
      };
      station.registeredVoters++;
      voters.push(voter);

      // ~35% classified, ramping up toward "today" so trend charts grow
      if (rnd() < 0.35) {
        const r = rnd();
        const classification: Classification =
          r < 0.6 ? "supporter" : r < 0.85 ? "potential" : "opponent";
        const activist = pickActivist();
        // quadratic bias toward recent days across a 60-day window
        const daysAgo = Math.floor(60 * (1 - Math.sqrt(rnd())));
        const at = now - daysAgo * DAY_MS - int(0, 14) * 3_600_000;
        voter.classification = classification;
        voter.classifiedBy = activist.id;
        voter.classifiedAt = iso(at);
        activist.tagCount++;
        events.push({
          id: `ev-${++eventIdx}`,
          voterId: voter.id,
          activistId: activist.id,
          classification,
          at: iso(at),
        });
      }
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return { voters, activists, stations, events };
}
