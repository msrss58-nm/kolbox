/**
 * Domain model for KolBox - types and interfaces only.
 * Display labels for these enums live in `constants/labels.ts`.
 * See CLAUDE.md for the Hebrew↔English vocabulary.
 */

/** סיווג - how a voter relates to the campaign. */
export type Classification = "supporter" | "potential" | "opponent" | "unclassified";

/** בוחר - a voter registry record. */
export interface Voter {
  id: string; // internal id
  nationalId: string; // ת"ז, 9 digits with valid checksum
  firstName: string;
  lastName: string;
  city: string;
  street: string;
  houseNumber: number;
  phone: string | null;
  birthYear: number;
  pollingStationId: string;
  classification: Classification;
  classifiedBy: string | null; // Activist.id
  classifiedAt: string | null; // ISO timestamp
  notes: string | null;
  familyId: string | null; // shared by household members (auto-family classification)
  /** Election-day only (post-MVP): ISO timestamp when marked as voted. */
  votedAt: string | null;
}

/** Gamified activist ranks, by tag count (thresholds in lib/ranks.ts). */
export type ActivistRank =
  | "turai" // טוראי
  | "rabat" // רב"ט
  | "samal" // סמל
  | "rasar" // רס"ר
  | "segen" // סגן
  | "seren" // סרן
  | "aluf"; // אלוף

/** פעיל - a field user who classifies voters. */
export interface Activist {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  area: string; // city / region scope
  joinedAt: string; // ISO
  lastActiveAt: string; // ISO
  tagCount: number; // derived, kept denormalized for lists
}

/** קלפי - a polling station. */
export interface PollingStation {
  id: string;
  number: number;
  city: string;
  address: string; // e.g. school name + street
  registeredVoters: number;
}

/** A single classification action - powers history & trend charts. */
export interface ClassificationEvent {
  id: string;
  voterId: string;
  activistId: string;
  classification: Classification;
  at: string; // ISO
}

/** Roles for real (Supabase-backed) auth. */
export type UserRole = "manager" | "activist" | "observer";

/** A signed-in user, built from their Supabase auth session + profiles row. */
export interface CurrentUser {
  id: string; // Supabase auth user id - also profiles.id
  email: string;
  name: string;
  /** null = pending approval (see profiles.role in the Supabase schema). */
  role: UserRole | null;
  activistId: string | null; // set when role === "activist" (mirrors `id`)
}

/**
 * יום הבחירות - a ride-coordination contact. Loaded from its own dedicated
 * Excel file (שם פרטי/שם משפחה/רחוב/מס בית/עיר/טלפון/אחראי) - independent of
 * the voter registry above.
 */
export interface ElectionDayVoter {
  id: string;
  masad: string; // מסד - polling/registration number, optional, set at import time
  firstName: string;
  lastName: string;
  street: string;
  houseNumber: number;
  city: string;
  phone: string;
  coordinator: string; // אחראי הסעה - free text, set at import time
  notes: string; // free-text notes, autosaved from the contact modal
  rideRequested: boolean; // the voter needs a ride - noted before any driver is involved
  rideRequestedAt: string | null; // ISO timestamp
  rideArranged: boolean;
  rideArrangedAt: string | null; // ISO timestamp
  rideCompleted: boolean; // the actual ride happened (reported by the driver, marked in the ride-coordination table)
  rideCompletedAt: string | null; // ISO timestamp
  reminderAt: string | null; // ISO timestamp - when a follow-up reminder should fire
  voted: boolean;
  votedAt: string | null; // ISO timestamp
}

/** נהג/אחראי הסעות - a fixed, pre-registered ride-coordinator contact that a
 * voter's ride request can be routed to (distinct from the per-voter
 * `coordinator` free-text field imported from the ride list). */
export interface RideCoordinator {
  id: string;
  name: string;
  phone: string;
}

/** Election Day's local user/manager roster ("ניהול הרשאות משתמשים") - a
 * simple directory, not a real login/auth system. */
export type PermissionRole = "user" | "manager";

export interface PermissionUser {
  id: string;
  name: string;
  password: string;
  role: PermissionRole;
}

/** A single ride-status change on an `ElectionDayVoter` - powers the recent
 * activity log (unlike the voter's own `rideArranged` field, this survives
 * a later toggle back). Denormalizes name/coordinator so the log reads
 * correctly even if the contact is later removed by a re-import. */
export interface RideStatusEvent {
  id: string;
  contactId: string;
  contactName: string;
  coordinator: string;
  from: boolean;
  to: boolean;
  at: string; // ISO timestamp
}

/** Aggregates for the dashboard. */
export interface CampaignStats {
  totalVoters: number;
  byClassification: Record<Classification, number>;
  coveragePct: number; // classified / total
  activeActivists: number; // active in the last 7 days
  goal: number; // campaign supporter target
  classificationsLast7Days: number;
}

export interface CityBreakdown {
  city: string;
  total: number;
  supporters: number;
}

export interface TrendPoint {
  date: string; // yyyy-mm-dd
  supporter: number;
  potential: number;
  opponent: number;
}
