import { create } from "zustand";
import { multiEntityOwnerAuthClient } from "../../services/supabase/multiEntityOwnerAuthClient";
import { MULTI_ENTITY_OWNER_MFA_FACTOR_NAME } from "./multi-entity-owner.constants";
import {
  fetchMultiEntityOwnerSession,
  type MultiEntityOwnerContext,
} from "./multiEntityOwnerClient";

/**
 * Platform Stage 5: the frontend half of the Multi-Entity Owner surface.
 *
 * Mirrors `platformOwnerSession.ts`'s state machine deliberately (same
 * statuses, same aal1-before-fetch rule, same generation guard) but shares
 * none of its state, its client, or its server verdict. It reads and writes
 * ONLY `multiEntityOwnerAuthClient`'s own storage key.
 *
 * SECURITY MODEL - everything here is UX; the server is the boundary:
 *   - `status === "authorized"` is set ONLY after `GET /api/multi-entity/
 *     session` returns 200. The server verifies the JWT, requires aal2, and
 *     requires the CURRENT exclusive Multi-Entity seat - on every call.
 *   - At aal1 the store returns BEFORE the privileged fetch: an aal1 session
 *     never even calls the endpoint (and would be refused 401 if it did).
 *   - `context` (including the assigned-workspace list) is display metadata
 *     re-fetched from the server; it is never used to authorize anything.
 *   - Every non-"authorized" outcome fails CLOSED.
 *
 * No `onAuthStateChange` listener, matching the Platform/Election Owner
 * stores: state changes only through the explicit actions below.
 */

export type MultiEntityOwnerStatus =
  | "checking"
  | "signed_out"
  | "mfa_enroll"
  | "mfa_challenge"
  /** aal2, but the server said 401 - not (or no longer) the seat holder. */
  | "forbidden"
  | "authorized"
  | "error";

export interface MultiEntityOwnerMfaState {
  factorId: string | null;
  qrCode: string | null;
  secret: string | null;
  enrolling: boolean;
  enrollFailed: boolean;
  verifying: boolean;
}

const EMPTY_MFA_STATE: MultiEntityOwnerMfaState = {
  factorId: null,
  qrCode: null,
  secret: null,
  enrolling: false,
  enrollFailed: false,
  verifying: false,
};

export type MultiEntityOwnerLoginResult =
  | { status: "success" }
  | { status: "error"; code: "invalid_credentials" | "network" }
  | { status: "ignored" };

export type MultiEntityOwnerVerifyResult =
  | { status: "success" }
  | { status: "invalid_code" }
  | { status: "no_factor" }
  | { status: "error" }
  | { status: "ignored" };

interface MultiEntityOwnerSessionState {
  context: MultiEntityOwnerContext | null;
  status: MultiEntityOwnerStatus;
  loggingIn: boolean;
  loggingOut: boolean;
  bootstrapped: boolean;
  mfaState: MultiEntityOwnerMfaState;
  login: (email: string, password: string) => Promise<MultiEntityOwnerLoginResult>;
  bootstrap: () => Promise<void>;
  logout: () => Promise<void>;
  enrollMfa: () => Promise<void>;
  verifyMfa: (code: string) => Promise<MultiEntityOwnerVerifyResult>;
  /** The single state resolver - also the revalidation path (route entry,
   * tab regaining visibility, the home page's refresh button). */
  refreshStatus: () => Promise<void>;
}

function toQrDataUri(qrCode: string): string {
  return qrCode.startsWith("data:")
    ? qrCode
    : `data:image/svg+xml;utf-8,${encodeURIComponent(qrCode)}`;
}

/** Monotonic generation counter - a slow in-flight resolution can never write
 * `authorized` over a logout or a newer resolution (see platformOwnerSession). */
let resolveGeneration = 0;

export const useMultiEntityOwnerSession = create<MultiEntityOwnerSessionState>(
  (set, get) => ({
    context: null,
    status: "checking",
    loggingIn: false,
    loggingOut: false,
    bootstrapped: false,
    mfaState: EMPTY_MFA_STATE,

    refreshStatus: async () => {
      const generation = ++resolveGeneration;
      const apply = (next: Partial<MultiEntityOwnerSessionState>) => {
        if (generation !== resolveGeneration) return;
        set(next);
      };
      try {
        const { data: sessionData } = await multiEntityOwnerAuthClient.auth.getSession();
        const session = sessionData.session;
        if (!session) {
          apply({
            context: null,
            status: "signed_out",
            mfaState: EMPTY_MFA_STATE,
            bootstrapped: true,
          });
          return;
        }

        const { data: aal, error: aalError } =
          await multiEntityOwnerAuthClient.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalError || !aal) {
          apply({ context: null, status: "error", bootstrapped: true });
          return;
        }

        if (aal.currentLevel !== "aal2") {
          // aal1 - returns BEFORE the privileged fetch below.
          const { data: factors, error: factorsError } =
            await multiEntityOwnerAuthClient.auth.mfa.listFactors();
          if (factorsError || !factors) {
            apply({ context: null, status: "error", bootstrapped: true });
            return;
          }
          const verified =
            factors.totp.find((factor) => factor.status === "verified") ?? null;
          apply({
            context: null,
            status: verified ? "mfa_challenge" : "mfa_enroll",
            mfaState: { ...EMPTY_MFA_STATE, factorId: verified?.id ?? null },
            bootstrapped: true,
          });
          return;
        }

        const result = await fetchMultiEntityOwnerSession(session.access_token);
        if (result.status === "ok") {
          apply({
            context: result.context,
            status: "authorized",
            mfaState: EMPTY_MFA_STATE,
            bootstrapped: true,
          });
          return;
        }
        if (result.status === "unauthorized") {
          // Not the seat holder (or replaced/revoked) vs. an expired session:
          // re-read the session so an expiry drops back to login.
          const { data: recheck } = await multiEntityOwnerAuthClient.auth.getSession();
          apply({
            context: null,
            status: recheck.session ? "forbidden" : "signed_out",
            mfaState: EMPTY_MFA_STATE,
            bootstrapped: true,
          });
          return;
        }
        apply({ context: null, status: "error", bootstrapped: true });
      } catch {
        apply({ context: null, status: "error", bootstrapped: true });
      }
    },

    bootstrap: async () => {
      if (get().bootstrapped) return;
      await get().refreshStatus();
    },

    login: async (email, password) => {
      if (get().loggingIn) return { status: "ignored" };
      set({ loggingIn: true });
      try {
        const { data, error } = await multiEntityOwnerAuthClient.auth.signInWithPassword({
          email,
          password,
        });
        if (error || !data.session) {
          return { status: "error", code: "invalid_credentials" };
        }
        // Password sign-in is only aal1 - it authorizes nothing by itself.
        set({ bootstrapped: true });
        await get().refreshStatus();
        return { status: "success" };
      } catch {
        return { status: "error", code: "network" };
      } finally {
        set({ loggingIn: false });
      }
    },

    logout: async () => {
      if (get().loggingOut) return;
      resolveGeneration += 1;
      set({ loggingOut: true });
      try {
        // Default scope is "global": every refresh token of this account is
        // revoked, not only this tab's session.
        await multiEntityOwnerAuthClient.auth.signOut();
      } finally {
        set({
          context: null,
          status: "signed_out",
          mfaState: EMPTY_MFA_STATE,
          bootstrapped: true,
          loggingOut: false,
        });
      }
    },

    enrollMfa: async () => {
      if (get().mfaState.enrolling) return;
      set((s) => ({
        mfaState: { ...s.mfaState, enrolling: true, enrollFailed: false },
      }));
      const fail = () =>
        set((s) => ({
          mfaState: { ...s.mfaState, enrolling: false, enrollFailed: true },
        }));
      try {
        const { data: factors, error: factorsError } =
          await multiEntityOwnerAuthClient.auth.mfa.listFactors();
        if (factorsError || !factors) {
          fail();
          return;
        }
        const verified = factors.totp.find((factor) => factor.status === "verified");
        if (verified) {
          set({
            status: "mfa_challenge",
            mfaState: { ...EMPTY_MFA_STATE, factorId: verified.id },
          });
          return;
        }
        for (const stale of factors.all) {
          if (stale.factor_type === "totp" && stale.status !== "verified") {
            await multiEntityOwnerAuthClient.auth.mfa.unenroll({ factorId: stale.id });
          }
        }
        const { data, error } = await multiEntityOwnerAuthClient.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: MULTI_ENTITY_OWNER_MFA_FACTOR_NAME,
        });
        if (error || !data) {
          fail();
          return;
        }
        set({
          mfaState: {
            factorId: data.id,
            qrCode: toQrDataUri(data.totp.qr_code),
            secret: data.totp.secret,
            enrolling: false,
            enrollFailed: false,
            verifying: false,
          },
        });
      } catch {
        fail();
      }
    },

    verifyMfa: async (code) => {
      const { factorId, verifying } = get().mfaState;
      if (verifying) return { status: "ignored" };
      if (!factorId) return { status: "no_factor" };
      set((s) => ({ mfaState: { ...s.mfaState, verifying: true } }));
      try {
        const { data: challenge, error: challengeError } =
          await multiEntityOwnerAuthClient.auth.mfa.challenge({ factorId });
        if (challengeError || !challenge) {
          return { status: "error" };
        }
        const { error: verifyError } = await multiEntityOwnerAuthClient.auth.mfa.verify({
          factorId,
          challengeId: challenge.id,
          code,
        });
        if (verifyError) {
          return { status: "invalid_code" };
        }
        await get().refreshStatus();
        return { status: "success" };
      } catch {
        return { status: "error" };
      } finally {
        set((s) => ({ mfaState: { ...s.mfaState, verifying: false } }));
      }
    },
  }),
);
