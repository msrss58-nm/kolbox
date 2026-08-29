import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY - copy .env.example to .env.local",
  );
}

/**
 * Phase 3C Roles Mutations: a SEPARATE Supabase Auth client for the Election
 * Owner login bridge, isolated from the main app's own `supabase` client
 * (`./client.ts`) via a distinct `storageKey`. Both clients share the same
 * project URL/anon key (there is only one Supabase Auth user pool), but
 * `@supabase/supabase-js`'s default storage key is derived from the project
 * ref (`sb-<ref>-auth-token`) - two clients pointed at the same project would
 * silently share and overwrite the SAME localStorage session unless given
 * distinct keys. A signed-in Owner and a signed-in main-app user (activist/
 * manager) are two independent identities that must never corrupt each
 * other's session - see the session-isolation proof in useOwnerSession.ts's
 * own tests.
 */
export const ownerAuthClient = createClient(url, publishableKey, {
  auth: {
    storageKey: "kb-owner-auth-token",
    persistSession: true,
    autoRefreshToken: true,
  },
});
