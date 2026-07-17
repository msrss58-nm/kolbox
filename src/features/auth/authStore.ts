import { create } from "zustand";
import { supabase } from "../../services/supabase/client";
import type { CurrentUser } from "../../types";
import { DEV_BYPASS_EMAIL } from "./auth.constants";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthState {
  user: CurrentUser | null;
  status: AuthStatus;
  /**
   * Emails a 6-digit sign-in code. `shouldCreateUser: false` means an email
   * with no existing account errors instead of silently creating one -
   * account creation only ever happens through the manager's team page (or
   * the one-time bootstrap). Returns the error's Supabase status code (e.g.
   * "over_email_send_rate_limit"), or null on success - the UI maps that
   * code to an accurate message instead of assuming every failure means
   * "email not found".
   */
  requestCode: (email: string) => Promise<string | null>;
  /** Completes sign-in with the code emailed by `requestCode`. */
  verifyCode: (email: string, code: string) => Promise<string | null>;
  /** Dev-only: signs in locally as a manager, bypassing OTP and Supabase entirely. */
  devBypassLogin: () => void;
  signOut: () => Promise<void>;
  /** Re-reads the profiles row (e.g. after a role/name change elsewhere). */
  refreshProfile: () => Promise<void>;
}

async function loadProfile(userId: string, email: string): Promise<CurrentUser | null> {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (!data) return null;
  return {
    id: data.id,
    email,
    name: data.name,
    role: data.role,
    activistId: data.role === "activist" ? data.id : null,
  };
}

/**
 * Real Supabase-session-backed auth store. `onAuthStateChange` fires once
 * immediately with the current session on subscribe (INITIAL_SESSION), so
 * no separate `getSession()` bootstrap call is needed - subscribing here,
 * once, at module load is enough to hydrate `user`/`status` at app start.
 */
export const useAuth = create<AuthState>((set, get) => {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (!session?.user) {
      set({ user: null, status: "unauthenticated" });
      return;
    }
    void loadProfile(session.user.id, session.user.email ?? "").then((user) =>
      set({ user, status: "authenticated" }),
    );
  });

  return {
    user: null,
    status: "loading",

    requestCode: async (email) => {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      return error?.code ?? error?.message ?? null;
    },

    verifyCode: async (email, code) => {
      const { error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      return error?.message ?? null;
    },

    devBypassLogin: () => {
      set({
        user: {
          id: "dev-bypass",
          email: DEV_BYPASS_EMAIL,
          name: "מנהל (בדיקה)",
          role: "manager",
          activistId: null,
        },
        status: "authenticated",
      });
    },

    signOut: async () => {
      await supabase.auth.signOut();
      // dev-bypass sessions have no real Supabase session, so no SIGNED_OUT
      // event fires to clear them - set state directly as well.
      set({ user: null, status: "unauthenticated" });
    },

    refreshProfile: async () => {
      const current = get().user;
      if (!current) return;
      const user = await loadProfile(current.id, current.email);
      if (user) set({ user });
    },
  };
});
