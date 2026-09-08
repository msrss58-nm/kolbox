import { create } from "zustand";
import { platformOwnerAuthClient } from "../../services/supabase/platformOwnerAuthClient";
import { PLATFORM_OWNER_MFA_FACTOR_NAME } from "./platform-owner.constants";
import {
  fetchPlatformOwnerSession,
  type PlatformOwnerContext,
} from "./platformOwnerClient";

/**
 * Platform Stage 2: the frontend half of the Platform Owner console - a
 * FOURTH, fully independent identity in this app, structurally separate from:
 *   - the campaign Supabase user (`src/features/auth/authStore.ts`, the
 *     default `supabase` client),
 *   - the Election Day PermissionUser cookie session
 *     (`src/features/election-day/electionDaySession.ts`),
 *   - the Election Owner (`src/features/election-day/ownerSession.ts`,
 *     storage key `kb-owner-auth-token`).
 * Nothing here reads or writes any of those three, and none of them read this
 * one. The isolation is enforced at the Supabase-client level by
 * `platformOwnerAuthClient`'s own `storageKey`.
 *
 * Like `ownerSession.ts`, this store deliberately has NO
 * `onAuthStateChange` listener - state transitions happen only through the
 * explicit actions below (`bootstrap`/`login`/`verifyMfa`/`logout`/
 * `refreshStatus`), so there is exactly one place that can decide the
 * console is reachable.
 *
 * SECURITY MODEL - `owner` is display metadata only, never authority:
 *   - `status === "authorized"` is set ONLY after `GET /api/platform/session`
 *     returns 200. The server independently verifies the JWT, requires
 *     `claims.aal === "aal2"`, and requires membership of the singleton
 *     `platform_owners` row.
 *   - The privileged endpoint is NEVER called while the session is at
 *     `aal1` - `refreshStatus()` returns early on the MFA branches, above
 *     the fetch. Production signup is open, so any self-registered user can
 *     reach `aal1` (and even `aal2` by self-enrolling a TOTP factor); the
 *     403-equivalent ("forbidden") state exists precisely for that case.
 *   - Every non-"authorized" outcome (loading, transport error, unknown)
 *     fails CLOSED. There is no optimistic path.
 */

export type PlatformOwnerStatus =
  /** Bootstrap/refresh in flight - fail closed, render a spinner. */
  | "checking"
  /** No Supabase session on the platform client at all. */
  | "signed_out"
  /** aal1 + no verified TOTP factor - enrollment is the only thing reachable. */
  | "mfa_enroll"
  /** aal1 + a verified TOTP factor - the challenge is the only thing reachable. */
  | "mfa_challenge"
  /** aal2, but the server said 401 - a real MFA user who is NOT the Platform Owner. */
  | "forbidden"
  /** aal2 AND `GET /api/platform/session` returned 200. The ONLY console state. */
  | "authorized"
  /** Transport/config failure - fail closed, offer retry. */
  | "error";

export interface PlatformOwnerMfaState {
  /** The TOTP factor being challenged (verified) or enrolled (pending). */
  factorId: string | null;
  /** SVG data URI from `mfa.enroll()`, normalized for use as an `<img src>`. */
  qrCode: string | null;
  /** The manual-entry secret, shown alongside the QR code. */
  secret: string | null;
  enrolling: boolean;
  enrollFailed: boolean;
  verifying: boolean;
}

const EMPTY_MFA_STATE: PlatformOwnerMfaState = {
  factorId: null,
  qrCode: null,
  secret: null,
  enrolling: false,
  enrollFailed: false,
  verifying: false,
};

export type PlatformOwnerLoginResult =
  | { status: "success" }
  | { status: "error"; code: "invalid_credentials" | "network" }
  | { status: "ignored" };

export type PlatformOwnerVerifyResult =
  | { status: "success" }
  | { status: "invalid_code" }
  | { status: "no_factor" }
  | { status: "error" }
  | { status: "ignored" };

interface PlatformOwnerSessionState {
  owner: PlatformOwnerContext | null;
  status: PlatformOwnerStatus;
  loggingIn: boolean;
  loggingOut: boolean;
  bootstrapped: boolean;
  mfaState: PlatformOwnerMfaState;
  /** Signs in with email+password. A successful sign-in only ever produces an
   * `aal1` session - it never authorizes anything by itself; the resulting
   * state is decided entirely by `refreshStatus()`. */
  login: (email: string, password: string) => Promise<PlatformOwnerLoginResult>;
  /** One-shot on guard/login mount: resolves the real state from the
   * persisted session. No-op once already bootstrapped. */
  bootstrap: () => Promise<void>;
  /** Signs out of the PLATFORM client only - `supabase` (campaign) and
   * `ownerAuthClient` (Election Owner) are never touched. */
  logout: () => Promise<void>;
  /** Idempotent TOTP enrollment - reuses an existing verified factor instead
   * of ever creating a second one. */
  enrollMfa: () => Promise<void>;
  /** `mfa.challenge()` + `mfa.verify()` for the factor currently in
   * `mfaState` - shared by the enrollment and challenge screens (this is
   * `challengeAndVerify()`'s own two-step expansion, kept explicit so a
   * challenge-creation failure is distinguishable from a wrong code). */
  verifyMfa: (code: string) => Promise<PlatformOwnerVerifyResult>;
  /** The single state resolver. Everything else delegates here. */
  refreshStatus: () => Promise<void>;
}

/** Supabase returns the QR either as a full data URI or as a bare SVG
 * document, depending on version - normalize both to something an `<img>`
 * can render. Never logged. */
function toQrDataUri(qrCode: string): string {
  return qrCode.startsWith("data:")
    ? qrCode
    : `data:image/svg+xml;utf-8,${encodeURIComponent(qrCode)}`;
}

/**
 * Monotonic generation counter for session-resolution requests.
 *
 * `refreshStatus()` is async and multi-step, and `logout()` can land while one
 * is still in flight (e.g. Retry then Logout on the blocked screen). Without
 * this guard the late `set({status:"authorized"})` would win last-writer and
 * render the console for a session that was just signed out. Every state
 * transition that can outlive its own request is gated on still being the
 * current generation; `logout()` bumps the counter so any in-flight resolution
 * is abandoned rather than allowed to resurrect a dead session.
 */
let resolveGeneration = 0;

export const usePlatformOwnerSession = create<PlatformOwnerSessionState>((set, get) => ({
  owner: null,
  status: "checking",
  loggingIn: false,
  loggingOut: false,
  bootstrapped: false,
  mfaState: EMPTY_MFA_STATE,

  refreshStatus: async () => {
    // Claim this resolution's generation. Every `apply(...)` below is a no-op
    // if a newer refresh, or a logout, has since superseded us - so a slow
    // in-flight resolution can never resurrect a session the user just ended.
    const generation = ++resolveGeneration;
    const apply = (next: Partial<PlatformOwnerSessionState>) => {
      if (generation !== resolveGeneration) return;
      set(next);
    };
    try {
      const { data: sessionData } = await platformOwnerAuthClient.auth.getSession();
      const session = sessionData.session;
      if (!session) {
        apply({
          owner: null,
          status: "signed_out",
          mfaState: EMPTY_MFA_STATE,
          bootstrapped: true,
        });
        return;
      }

      const { data: aal, error: aalError } =
        await platformOwnerAuthClient.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalError || !aal) {
        apply({ owner: null, status: "error", bootstrapped: true });
        return;
      }

      if (aal.currentLevel !== "aal2") {
        // aal1 branch. Returns BEFORE the privileged fetch below - an
        // aal1 session can never trigger a call to
        // `GET /api/platform/session`, and can never reach "authorized".
        const { data: factors, error: factorsError } =
          await platformOwnerAuthClient.auth.mfa.listFactors();
        if (factorsError || !factors) {
          apply({ owner: null, status: "error", bootstrapped: true });
          return;
        }
        const verified =
          factors.totp.find((factor) => factor.status === "verified") ?? null;
        apply({
          owner: null,
          status: verified ? "mfa_challenge" : "mfa_enroll",
          mfaState: { ...EMPTY_MFA_STATE, factorId: verified?.id ?? null },
          bootstrapped: true,
        });
        return;
      }

      const result = await fetchPlatformOwnerSession(session.access_token);
      if (result.status === "ok") {
        apply({
          owner: result.context,
          status: "authorized",
          mfaState: EMPTY_MFA_STATE,
          bootstrapped: true,
        });
        return;
      }
      if (result.status === "unauthorized") {
        // Two very different causes share this status code: (a) a valid
        // aal2 user who is simply not the Platform Owner, and (b) a
        // token that was revoked/expired mid-session. Re-read the session
        // to tell them apart, so an expiry drops back to login instead of
        // parking the user on a misleading "not authorized" screen.
        const { data: recheck } = await platformOwnerAuthClient.auth.getSession();
        apply({
          owner: null,
          status: recheck.session ? "forbidden" : "signed_out",
          mfaState: EMPTY_MFA_STATE,
          bootstrapped: true,
        });
        return;
      }
      apply({ owner: null, status: "error", bootstrapped: true });
    } catch {
      // Fail closed: an unexpected throw never leaves a stale
      // "authorized" status behind.
      apply({ owner: null, status: "error", bootstrapped: true });
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
      const { data, error } = await platformOwnerAuthClient.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.session) {
        return { status: "error", code: "invalid_credentials" };
      }
      // A successful password sign-in is only aal1. Authorization is
      // decided exclusively by `refreshStatus()` (MFA first, then the
      // server's own 200/401) - never by the fact that sign-in worked.
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
    // Supersede any in-flight refreshStatus() so a late-arriving 200 cannot
    // write `authorized` back over the signed-out state we are about to set.
    resolveGeneration += 1;
    set({ loggingOut: true });
    try {
      await platformOwnerAuthClient.auth.signOut();
    } finally {
      set({
        owner: null,
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
        await platformOwnerAuthClient.auth.mfa.listFactors();
      if (factorsError || !factors) {
        fail();
        return;
      }

      // Idempotency: an already-verified factor is reused as-is - never
      // enroll a second one on top of it.
      const verified = factors.totp.find((factor) => factor.status === "verified");
      if (verified) {
        set({
          status: "mfa_challenge",
          mfaState: { ...EMPTY_MFA_STATE, factorId: verified.id },
        });
        return;
      }

      // Abandoned unverified TOTP factors (a reload mid-enrollment) would
      // otherwise pile up and collide on the friendly name - drop them
      // first so enrollment is repeatable.
      for (const stale of factors.all) {
        if (stale.factor_type === "totp" && stale.status !== "verified") {
          await platformOwnerAuthClient.auth.mfa.unenroll({ factorId: stale.id });
        }
      }

      const { data, error } = await platformOwnerAuthClient.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: PLATFORM_OWNER_MFA_FACTOR_NAME,
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
        await platformOwnerAuthClient.auth.mfa.challenge({ factorId });
      if (challengeError || !challenge) {
        return { status: "error" };
      }
      const { error: verifyError } = await platformOwnerAuthClient.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) {
        return { status: "invalid_code" };
      }
      // Verification upgraded this client's session to aal2 - re-resolve
      // from scratch (the server still gets the final word).
      await get().refreshStatus();
      return { status: "success" };
    } catch {
      return { status: "error" };
    } finally {
      set((s) => ({ mfaState: { ...s.mfaState, verifying: false } }));
    }
  },
}));
