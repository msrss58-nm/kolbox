import { create } from "zustand";
import { COMMON_TEXT } from "../../constants/common-text";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import { api } from "../../services/api";
import { removeKey } from "../../services/storage/localStore";
import { useCoordinatorAllocationReauthProof } from "./coordinatorAllocationReauthProof";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayReauthProof } from "./electionDayReauthProof";
import {
  getSession,
  login as loginRequest,
  logout as logoutRequest,
  type ServerSessionUser,
  type SessionClientResult,
} from "./electionDaySessionClient";

const LEGACY_SESSION_KEY = "election-day-session-v1";

/**
 * `login()`'s result contract. Deliberately a 3-way discriminated union, not
 * `string | null` - a suppressed duplicate submit must resolve to a value
 * the caller cannot mistake for a real, server-confirmed outcome. (Found and
 * fixed: the previous `string | null` contract had the duplicate-guard's
 * synchronous early-return resolve to the same `null` a real success
 * returned, so `ElectionDayLoginScreen.tsx`'s `if (err) {...} else
 * navigate(...)` could - and in a real near-simultaneous double-submit, did
 * - navigate away before the real, still-in-flight attempt had actually
 * resolved, regardless of whether that real attempt was going to succeed or
 * fail.)
 */
export type LoginActionResult =
  | { status: "success" }
  | { status: "error"; message: string }
  /** A duplicate/overlapping call was suppressed while a real attempt was
   * already in flight - no network request was made, `user` is untouched,
   * and the caller must take NO action (no navigation, no error message):
   * the real, already-in-flight call owns this outcome and will resolve it
   * on its own turn. */
  | { status: "ignored" };

export interface ElectionDaySessionUser {
  id: string;
  name: string;
  /** Always present (NOT NULL in the DB since Phase 0) - the permission
   * engine resolves this session's `RoleRecord` by this id
   * (`resolveSessionRole`). */
  roleId: string;
  /** Phase 3B: server-derived metadata only, from the trusted session
   * endpoint's response - never consulted by the permission engine or any
   * authorization decision on the frontend (see CLAUDE.md). */
  workspaceId: string;
}

interface ElectionDaySessionState {
  user: ElectionDaySessionUser | null;
  /** Guards against a double-submit firing a second overlapping POST while
   * one is already in flight - checked/set at the very top of `login()`,
   * before any `await`, independent of whatever the calling component's own
   * render/disabled-state cycle looks like (a fast enough double-click or
   * double Enter can fire a second submit event before React re-renders the
   * form's own `submitting` state, let alone the `Button`'s `disabled`
   * prop). A suppressed duplicate resolves to `{status:"ignored"}` (see
   * `LoginActionResult` above) without making any network request, so it
   * never consumes an additional rate-limited login attempt. Mirrors
   * `loggingOut` below. */
  loggingIn: boolean;
  /** Guards against a double-click firing a second overlapping DELETE while
   * one is already in flight - checked/set at the very top of `logout()`,
   * independent of whatever the calling component's own render cycle looks
   * like (a component-level `busy` flag alone can't guarantee this, since a
   * fast enough double-click can fire before React re-renders). */
  loggingOut: boolean;
  /** Deliberately does NOT hydrate `user` on `"success"` - the POST response
   * only proves credentials and establishes the `__Host-kb_ed_session`
   * cookie; `ElectionDayGuard`'s own GET (`bootstrap()` below) is the single
   * revalidation gate before `user` is ever set and the protected route
   * renders (Phase 3B Step 2/3). See `LoginActionResult` above for why a
   * suppressed duplicate resolves to `"ignored"` rather than something a
   * caller could mistake for `"success"`. */
  login: (name: string, password: string) => Promise<LoginActionResult>;
  /** Phase 3B logout cutover: DELETE `/api/election-day/session` first: on
   * success, clears the cached reauth proof (best-effort server revoke +
   * local clear) and `user`; on failure, throws and touches NOTHING else -
   * `user` stays exactly as it was. A DELETE failure must never be reported
   * as a successful logout while the server-side session/cookie is still
   * live - see this function's own body for why. Throws (rather than
   * returning a string like `login()`) so callers can use this codebase's
   * standard `useAsyncAction` toast-on-error convention, matching a
   * button-click action rather than a form submission. */
  logout: () => Promise<void>;
  /** Called only from `ElectionDayGuard` on mount - never globally (see
   * CLAUDE.md's "Election Day's own local login" section: unrelated
   * main-app pages must never trigger an Election Day session request).
   * Resolves the current server-side session via GET and hydrates/clears
   * `user` accordingly - see this function's own inline comments for the
   * exact per-status semantics. */
  bootstrap: () => Promise<SessionClientResult>;
}

/**
 * Removes the pre-Phase-3B localStorage session key. Idempotent - safe to
 * call unconditionally every time (a no-op once the key is already gone),
 * so this needs no separate "have I already cleaned up" flag. Nothing in
 * this file (or anywhere else) ever reads this key for authentication -
 * `user` above is populated exclusively from `login()`'s and `bootstrap()`'s
 * server responses. Called from `bootstrap()` and from
 * `ElectionDayLoginScreen`'s mount effect - never at module-import time,
 * so it never fires for a main-app page that merely imports this module.
 */
export function clearLegacySession(): void {
  removeKey(LEGACY_SESSION_KEY);
}

function mapLoginFailureMessage(result: SessionClientResult): string {
  switch (result.status) {
    case "unauthenticated":
      return ELECTION_DAY_TEXT.session.errors.invalidCredentials;
    case "rate_limited":
      return ELECTION_DAY_TEXT.session.errors.rateLimited;
    default:
      return COMMON_TEXT.networkError;
  }
}

function toStoredUser(user: ServerSessionUser): ElectionDaySessionUser {
  return {
    id: user.id,
    name: user.name,
    roleId: user.roleId,
    workspaceId: user.workspaceId,
  };
}

/**
 * Phase 3B: the frontend half of the trusted server-side session model
 * (`electionDaySessionClient.ts` + `api/election-day/session.ts`). Replaces
 * the pre-Phase-3B design, which read/wrote a plaintext session object to
 * localStorage and trusted it with zero server validation.
 */
export const useElectionDaySession = create<ElectionDaySessionState>((set, get) => ({
  user: null,
  loggingIn: false,
  loggingOut: false,

  login: async (name, password) => {
    // Duplicate-submit guard - a login POST is already in flight, so this
    // call is a silent no-op (no network request, no rate-limit attempt
    // consumed) rather than firing a second overlapping request. Checked
    // before any `await`, so it's synchronous with the call itself -
    // independent of React's own render timing (see this field's own doc
    // comment above).
    if (get().loggingIn) return { status: "ignored" };
    set({ loggingIn: true });
    try {
      const result = await loginRequest(name, password);
      // Security Hardening (Reauth): a successful login changes the
      // signed-in actor - drop any reauth proof left over from a previous
      // session regardless of this attempt's outcome, same defensive
      // reasoning as before this rewrite. Coordinator/Allocation V3 Frontend
      // Cutover: the dedicated coordinator_allocation proof cache is a
      // separate bearer credential from the legacy one (see
      // coordinatorAllocationReauthProof.ts) and must be dropped at the
      // same lifecycle point for the same reason.
      useElectionDayReauthProof.getState().clearProof();
      useCoordinatorAllocationReauthProof.getState().clearProof();
      if (result.status === "authenticated") {
        // Kick off the role-catalog fetch immediately on a real,
        // interactive login (Dynamic Roles & Permissions Phase 1) instead
        // of waiting for the first `usePermissions()` mount - a no-op if
        // already loading/loaded. Fire-and-forget: this doesn't depend on
        // `user` being hydrated yet (the catalog itself isn't
        // role-specific), so it can start before `ElectionDayGuard`'s own
        // GET even runs.
        void useRoleCatalogStore.getState().ensureLoaded();
        return { status: "success" };
      }
      return { status: "error", message: mapLoginFailureMessage(result) };
    } finally {
      set({ loggingIn: false });
    }
  },

  logout: async () => {
    // Duplicate-click guard - a logout DELETE is already in flight, so this
    // call is a silent no-op rather than firing a second overlapping
    // request. Independent of React's own render timing (see this field's
    // own doc comment above).
    if (get().loggingOut) return;
    set({ loggingOut: true });
    try {
      const result = await logoutRequest();
      if (result.status !== "ok") {
        // Security requirement: never report a successful logout - and
        // never clear `user` or the cached reauth proof - while the
        // server-side session/cookie may still be live. The caller (via
        // `useAsyncAction`) surfaces this as a toast; `user` is left
        // completely untouched, so the next Guard bootstrap (or any
        // already-rendered authenticated screen) keeps working exactly as
        // before this failed attempt.
        throw new Error(COMMON_TEXT.networkError);
      }
      // Only reached once the server has confirmed the session/cookie is
      // actually gone - only now is it safe to drop the cached reauth
      // proof too. Security Hardening (Reauth): a cached proof is a
      // separate, shorter-lived bearer credential (see
      // `electionDayReauthProof.ts`) usable by the 11 still-legacy `_v2`
      // reauth-gated mutations independent of the session cookie itself -
      // it must not survive a successful logout in the same tab. Best-
      // effort server-side revoke (never throws, never awaited) + local
      // clear, same as before this rewrite.
      const { proof, clearProof } = useElectionDayReauthProof.getState();
      if (proof) void api.revokeReauthProof(proof);
      clearProof();
      // Coordinator/Allocation V3 Frontend Cutover: the dedicated
      // coordinator_allocation proof has no server-side revoke call (unlike
      // the legacy proof's best-effort `revokeReauthProof` - the v3 proof
      // simply becomes unusable the instant the session row it's bound to
      // is gone, see election_day_verify_reauth_proof_v3's own workspace/
      // actor re-check) - only the local cache needs clearing here.
      useCoordinatorAllocationReauthProof.getState().clearProof();
      set({ user: null });
    } finally {
      set({ loggingOut: false });
    }
  },

  bootstrap: async () => {
    clearLegacySession();
    const result = await getSession();
    if (result.status === "authenticated") {
      set({ user: toStoredUser(result.user) });
    } else if (result.status === "unauthenticated") {
      // Coordinator/Allocation V3 Frontend Cutover: a bootstrap-detected
      // session loss (expiry, revocation, or any other server-confirmed
      // "no longer authenticated" outcome) must not leave a client-side-
      // "valid" coordinator_allocation proof cached - the approved design
      // requires clearing it at this exact lifecycle point, not only on an
      // explicit logout click. The legacy proof's own cleanup here is
      // deliberately left unchanged (it was never cleared at this branch
      // before this fix, and this correction is scoped to the new store
      // only).
      useCoordinatorAllocationReauthProof.getState().clearProof();
      set({ user: null });
    }
    // status === "error": `user` is left exactly as it was - a transport/
    // server failure is not proof the session is invalid, so it must never
    // silently log an already-known user out.
    return result;
  },
}));
