import { create } from "zustand";
import { COMMON_TEXT } from "../../constants/common-text";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import { api } from "../../services/api";
import { removeKey } from "../../services/storage/localStore";
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
  /** Guards against a double-click firing a second overlapping DELETE while
   * one is already in flight - checked/set at the very top of `logout()`,
   * independent of whatever the calling component's own render cycle looks
   * like (a component-level `busy` flag alone can't guarantee this, since a
   * fast enough double-click can fire before React re-renders). */
  loggingOut: boolean;
  /** Returns an error message on failure, or null on success. Deliberately
   * does NOT hydrate `user` on success - the POST response only proves
   * credentials and establishes the `__Host-kb_ed_session` cookie;
   * `ElectionDayGuard`'s own GET (`bootstrap()` below) is the single
   * revalidation gate before `user` is ever set and the protected route
   * renders (Phase 3B Step 2/3). */
  login: (name: string, password: string) => Promise<string | null>;
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
  loggingOut: false,

  login: async (name, password) => {
    const result = await loginRequest(name, password);
    // Security Hardening (Reauth): a successful login changes the signed-in
    // actor - drop any reauth proof left over from a previous session
    // regardless of this attempt's outcome, same defensive reasoning as
    // before this rewrite.
    useElectionDayReauthProof.getState().clearProof();
    if (result.status === "authenticated") {
      // Kick off the role-catalog fetch immediately on a real, interactive
      // login (Dynamic Roles & Permissions Phase 1) instead of waiting for
      // the first `usePermissions()` mount - a no-op if already
      // loading/loaded. Fire-and-forget: this doesn't depend on `user`
      // being hydrated yet (the catalog itself isn't role-specific), so it
      // can start before `ElectionDayGuard`'s own GET even runs.
      void useRoleCatalogStore.getState().ensureLoaded();
      return null;
    }
    return mapLoginFailureMessage(result);
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
      set({ user: null });
    }
    // status === "error": `user` is left exactly as it was - a transport/
    // server failure is not proof the session is invalid, so it must never
    // silently log an already-known user out.
    return result;
  },
}));
