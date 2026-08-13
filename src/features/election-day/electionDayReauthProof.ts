import { create } from "zustand";

/** How long a `election_day_reauth` proof stays usable client-side before
 * this store treats it as expired and forces a fresh password prompt -
 * matches the server-side proof lifetime the DB migration issues (~15
 * minutes). Deliberately shorter would just mean extra prompts; deliberately
 * longer would mean this store claims a proof is valid when the server has
 * already expired it, so `hasValidProof()` alone is only an optimistic,
 * client-side check - the server is still the real authority and a stale-
 * but-locally-"valid" proof still gets rejected (`UNAUTHORIZED`) and cleared
 * by the caller, see `useElectionDayReauth.ts`. */
const REAUTH_PROOF_TTL_MS = 15 * 60_000;

interface ElectionDayReauthProofState {
  proof: string | null;
  expiresAt: number | null;
  /** Caches a freshly-issued proof (from `api.reauth()`) for
   * `REAUTH_PROOF_TTL_MS`. */
  setProof: (proof: string) => void;
  /** Drops the cached proof - called on explicit logout, on a `UNAUTHORIZED`
   * response from any of the 8 reauth-gated admin/import RPCs (the proof was
   * rejected server-side - expired or revoked), and whenever
   * `electionDaySession`'s signed-in user changes, so a different actor
   * logging in can never reuse a stale proof from the previous session. */
  clearProof: () => void;
  /** Imperative validity check - a currently-cached, non-expired proof.
   * Deliberately a plain method (not a memoized selector) so callers only
   * ever invoke it from event handlers/async mutation flows, never
   * synchronously during a component's render phase (`Date.now()` inside
   * render would violate this codebase's React Compiler purity rule - see
   * CLAUDE.md). */
  hasValidProof: () => boolean;
}

/**
 * Short-lived, memory-only cache for the Election Day admin re-auth proof
 * (`election_day_reauth`). Deliberately NOT persisted (no `persist`
 * middleware, no localStorage/sessionStorage) - the proof is a bearer
 * credential for the 8 hardened admin/import RPCs and must not survive a
 * page reload or be readable outside this tab's JS heap; a reload simply
 * means the next admin action prompts for a password again, exactly like
 * today's `AllocationPasswordDialog` flow already does for every
 * coordinator-allocation mutation.
 */
export const useElectionDayReauthProof = create<ElectionDayReauthProofState>(
  (set, get) => ({
    proof: null,
    expiresAt: null,
    setProof: (proof) => set({ proof, expiresAt: Date.now() + REAUTH_PROOF_TTL_MS }),
    clearProof: () => set({ proof: null, expiresAt: null }),
    hasValidProof: () => {
      const { proof, expiresAt } = get();
      return proof !== null && expiresAt !== null && expiresAt > Date.now();
    },
  }),
);
