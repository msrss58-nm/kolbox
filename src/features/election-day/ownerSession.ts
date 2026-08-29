import { create } from "zustand";
import { ownerAuthClient } from "../../services/supabase/ownerAuthClient";
import { fetchOwnerSession, type OwnerContext } from "./electionDayOwnerClient";

/**
 * Phase 3C Roles Mutations: the frontend half of the Election Owner login
 * bridge - a THIRD, independent identity in this app, distinct from both:
 *   - the main app's Supabase Auth session (`src/features/auth/authStore.ts`,
 *     `supabase` client) - a different Supabase Auth client instance
 *     (`ownerAuthClient`, isolated `storageKey`) is used here specifically so
 *     signing in/out as an Owner never touches that session.
 *   - the PermissionUser HttpOnly Election Day session (`electionDaySession.ts`)
 *     - a completely different mechanism (server-side cookie session, no
 *     Supabase Auth involved at all), untouched by anything in this file.
 *
 * `owner` caches only display/UX metadata (ownerId/workspaceId/email) - it is
 * NEVER trusted as authorization authority by itself. Every Owner mutation
 * still independently re-verifies the JWT server-side (`_ownerAuth.ts`'s
 * `verifyOwnerJwt`) and re-resolves {owner_id, workspace_id} live from
 * `election_owners` on every call - exactly like `ElectionDaySessionUser`'s
 * own `workspaceId` field is documented as "server-derived metadata only".
 */
export interface OwnerSessionUser extends OwnerContext {
  email: string;
}

export type OwnerLoginResult =
  | { status: "success" }
  | { status: "error"; message: string }
  | { status: "ignored" };

interface OwnerSessionState {
  owner: OwnerSessionUser | null;
  loggingIn: boolean;
  loggingOut: boolean;
  bootstrapped: boolean;
  login: (email: string, password: string) => Promise<OwnerLoginResult>;
  logout: () => Promise<void>;
  /** Restores a persisted Owner Auth session on reload/mount and LIVE-
   * re-validates it against `election_owners` (never trusts the locally
   * cached session alone) - a stale/removed Owner membership is signed out
   * immediately, matching `election_day_resolve_owner_context`'s own
   * "live lookup, never cached" guarantee end-to-end. */
  bootstrap: () => Promise<void>;
  /** Returns the current Owner access token for an authenticated request, or
   * `null` if no Owner session exists. Reads directly from `ownerAuthClient`
   * (never cached in this store) so a token refresh performed by the
   * Supabase client itself is always reflected immediately. */
  getAccessToken: () => Promise<string | null>;
}

export const useOwnerSession = create<OwnerSessionState>((set, get) => ({
  owner: null,
  loggingIn: false,
  loggingOut: false,
  bootstrapped: false,

  login: async (email, password) => {
    if (get().loggingIn) return { status: "ignored" };
    set({ loggingIn: true });
    try {
      const { data, error } = await ownerAuthClient.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.session) {
        return { status: "error", message: "פרטי ההתחברות שגויים" };
      }
      const result = await fetchOwnerSession(data.session.access_token);
      if (result.status !== "ok") {
        // A valid Supabase Auth account that is NOT a registered Election
        // Owner - never leave this session sitting in isolated storage.
        await ownerAuthClient.auth.signOut();
        return { status: "error", message: "המשתמש אינו בעלים רשום של קמפיין" };
      }
      set({ owner: { ...result.context, email: data.session.user.email ?? email } });
      return { status: "success" };
    } catch {
      return { status: "error", message: "אין חיבור לאינטרנט - בדקו את החיבור ונסו שוב" };
    } finally {
      set({ loggingIn: false });
    }
  },

  logout: async () => {
    if (get().loggingOut) return;
    set({ loggingOut: true });
    try {
      await ownerAuthClient.auth.signOut();
      set({ owner: null });
    } finally {
      set({ loggingOut: false });
    }
  },

  bootstrap: async () => {
    try {
      const { data } = await ownerAuthClient.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        set({ owner: null, bootstrapped: true });
        return;
      }
      const result = await fetchOwnerSession(accessToken);
      if (result.status === "ok") {
        set({
          owner: { ...result.context, email: data.session?.user.email ?? "" },
          bootstrapped: true,
        });
        return;
      }
      if (result.status === "unauthorized") {
        // Stale/removed Owner membership - sign out of the isolated client
        // too, not just this store's own cache.
        await ownerAuthClient.auth.signOut();
      }
      set({ owner: null, bootstrapped: true });
    } catch {
      // Transport failure - not proof the session is invalid. Leave `owner`
      // exactly as it was, matching `electionDaySession.ts`'s own bootstrap
      // contract, but still mark bootstrapped so a first-load failure
      // doesn't spin forever.
      set({ bootstrapped: true });
    }
  },

  getAccessToken: async () => {
    const { data } = await ownerAuthClient.auth.getSession();
    return data.session?.access_token ?? null;
  },
}));
