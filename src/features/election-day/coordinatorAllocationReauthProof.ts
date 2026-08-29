import { create } from "zustand";

/** Server-side TTL of a `coordinator_allocation` v3 proof
 * (`election_day_reauth_v3`, `v_expires_at := now() + interval '5 minutes'`
 * - see `20260826010000_multi_tenant_phase3a_session_rpcs.sql:429`).
 * Matches the client-side optimism window exactly - unlike
 * `electionDayReauthProof.ts`'s 15-minute legacy figure, which belongs to a
 * different server-side proof lifetime entirely and must not be reused
 * here. */
const REAUTH_PROOF_TTL_MS = 5 * 60_000;

interface CoordinatorAllocationReauthProofState {
  proof: string | null;
  expiresAt: number | null;
  /** Caches a freshly-issued `coordinator_allocation` proof (from
   * `reauthForCoordinatorAllocation`) for `REAUTH_PROOF_TTL_MS`. */
  setProof: (proof: string) => void;
  /** Drops the cached proof - called on a server-rejected `UNAUTHORIZED`
   * from any of the 4 Coordinator/Allocation trusted mutations (the proof
   * was rejected server-side - expired or the session/proof no longer
   * matches), and wherever the Election Day session itself becomes
   * unauthenticated (explicit logout, or a bootstrap-detected session
   * loss) - see `electionDaySession.ts`. Deliberately NOT cleared on a
   * `FORBIDDEN` response - the proof itself is still valid, only the
   * live permission check failed (see
   * `useCoordinatorAllocationReauth.ts`). */
  clearProof: () => void;
  /** Imperative validity check - a currently-cached, non-expired proof.
   * Deliberately a plain method (not a memoized selector), same reasoning
   * as `electionDayReauthProof.ts`'s own `hasValidProof` - never called
   * synchronously during render (React Compiler purity rule, see
   * CLAUDE.md). */
  hasValidProof: () => boolean;
}

/**
 * Coordinator/Allocation V3 Frontend Cutover: short-lived, memory-only
 * cache for the feature-scoped `coordinator_allocation` reauth proof
 * (`election_day_reauth_v3` / `election_day_verify_reauth_proof_v3`).
 * Deliberately a SEPARATE store from `electionDayReauthProof.ts` - the two
 * proofs are different bearer credentials verified by different Postgres
 * functions, with different TTLs and different action scopes, and must
 * coexist safely without ever being confused for one another. Deliberately
 * NOT persisted (no `persist` middleware, no localStorage/sessionStorage) -
 * same reasoning as the legacy store: a reload simply means the next
 * Coordinator/Allocation mutation prompts for a password again.
 *
 * Deliberately no cross-store `subscribe()` on the Election Day session
 * store - cleanup is instead wired explicitly into `electionDaySession.ts`,
 * at 3 lifecycle points: the start of every `login()` attempt (regardless of
 * outcome), a successful `logout()`, and a bootstrap-detected unauthenticated
 * session (session expiry/revocation discovered on mount, not just an
 * explicit logout click). This is one more clearing point than the legacy
 * `electionDayReauthProof.ts` has (it is not cleared on bootstrap-detected
 * session loss) - a deliberate, approved difference for this store, not an
 * inconsistency to reconcile.
 */
export const useCoordinatorAllocationReauthProof =
  create<CoordinatorAllocationReauthProofState>((set, get) => ({
    proof: null,
    expiresAt: null,
    setProof: (proof) => set({ proof, expiresAt: Date.now() + REAUTH_PROOF_TTL_MS }),
    clearProof: () => set({ proof: null, expiresAt: null }),
    hasValidProof: () => {
      const { proof, expiresAt } = get();
      return proof !== null && expiresAt !== null && expiresAt > Date.now();
    },
  }));
