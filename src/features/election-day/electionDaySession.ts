import { create } from "zustand";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import { api } from "../../services/api";
import { loadJson, removeKey, saveJson } from "../../services/storage/localStore";
import { ELECTION_DAY_TEXT } from "./election-day.constants";
import { useElectionDayReauthProof } from "./electionDayReauthProof";

const SESSION_KEY = "election-day-session-v1";

export interface ElectionDaySessionUser {
  id: string;
  name: string;
  /** Always present (NOT NULL in the DB since Phase 0) - the permission
   * engine resolves this session's `RoleRecord` by this id
   * (`resolveSessionRole`). The only identity a session carries since the
   * Phase 3 legacy cleanup. */
  roleId: string;
}

interface ElectionDaySessionState {
  user: ElectionDaySessionUser | null;
  /** Returns an error message on failure, or null on success. */
  login: (name: string, password: string) => Promise<string | null>;
  logout: () => void;
}

/**
 * A lightweight, local-only "session" for the Election Day screen -
 * deliberately not real authentication (no server, no hashing): it checks
 * the entered name/password against the same local roster managed in
 * "ניהול הרשאות משתמשים" (`PermissionUser`, via `ApiClient`/`MockApi`), then
 * persists just `{id, name, roleId}` to localStorage so a page refresh
 * doesn't sign the user out.
 */
export const useElectionDaySession = create<ElectionDaySessionState>((set) => ({
  user: loadJson<ElectionDaySessionUser>(SESSION_KEY),

  login: async (name, password) => {
    const match = await api.verifyPermissionUserLogin(name, password);
    if (!match) return ELECTION_DAY_TEXT.session.errors.invalidCredentials;
    const sessionUser: ElectionDaySessionUser = {
      id: match.id,
      name: match.name,
      roleId: match.roleId,
    };
    // Security Hardening (Reauth): a successful login changes the signed-in
    // actor - drop any reauth proof left over from a previous session (there
    // shouldn't normally be one, since `logout()` below already clears it,
    // but this login path is the other place the actor identity can change,
    // so it clears defensively too rather than assuming the invariant always
    // held). No revoke call here (unlike `logout()`) - a proof surviving
    // from before this login was never valid for the newly-signed-in actor
    // to use anyway, so there's nothing to notify the server about beyond
    // what its own expiry already handles.
    useElectionDayReauthProof.getState().clearProof();
    saveJson(SESSION_KEY, sessionUser);
    set({ user: sessionUser });
    // Kick off the role-catalog fetch immediately on a real, interactive
    // login (Dynamic Roles & Permissions Phase 1) instead of waiting for
    // the first `usePermissions()` mount - a no-op if already
    // loading/loaded. Fire-and-forget: `usePermissions()` reads the
    // store's status reactively, and a failure here still leaves the
    // engine fail-closed (see `computePermissions`), never blocks login.
    void useRoleCatalogStore.getState().ensureLoaded();
    return null;
  },

  logout: () => {
    // Security Hardening (Reauth): best-effort revoke of whatever proof is
    // currently cached - fire-and-forget, never awaited, since
    // `revokeReauthProof()` itself never throws (see its own doc comment)
    // and logout must never be blocked or failed by a network hiccup here.
    const { proof, clearProof } = useElectionDayReauthProof.getState();
    if (proof) void api.revokeReauthProof(proof);
    clearProof();
    removeKey(SESSION_KEY);
    set({ user: null });
  },
}));
