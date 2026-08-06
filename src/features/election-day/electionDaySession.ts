import { create } from "zustand";
import { useRoleCatalogStore } from "../../permissions/roleCatalogStore";
import { api } from "../../services/api";
import { loadJson, removeKey, saveJson } from "../../services/storage/localStore";
import { ELECTION_DAY_TEXT } from "./election-day.constants";

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
    removeKey(SESSION_KEY);
    set({ user: null });
  },
}));
