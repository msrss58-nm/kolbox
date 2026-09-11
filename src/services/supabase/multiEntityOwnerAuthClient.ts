import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY - copy .env.example to .env.local",
  );
}

/**
 * Platform Stage 5: a SEPARATE Supabase Auth client for the Multi-Entity
 * Owner - the fifth independent identity in this app, isolated from the
 * campaign client (default key), the Election Owner (`kb-owner-auth-token`)
 * and the Platform Owner (`kb-platform-owner-auth-token`). Same reason as
 * `platformOwnerAuthClient.ts`: a client without its own `storageKey` would
 * silently share and overwrite another identity's session.
 *
 * `detectSessionInUrl: false` - deliberately unlike the three existing
 * clients. Every client module is evaluated on every surface bundle (routes
 * are tree-shaken, client modules are not), so a fourth client left at the
 * default `true` would join the existing URL-token race and could adopt, say,
 * a campaign magic-link session into this key on the Election origin. This
 * client never needs URL detection: the set-password screen redeems its
 * `token_hash` explicitly with `verifyOtp()` (see
 * `multiEntityOwnerRecoveryUrl.ts`).
 *
 * Nothing in this file may be reused by the other identities, and this client
 * must never be signed out by their logout paths.
 */
export const multiEntityOwnerAuthClient = createClient(url, publishableKey, {
  auth: {
    storageKey: "kb-multi-entity-owner-auth-token",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});
