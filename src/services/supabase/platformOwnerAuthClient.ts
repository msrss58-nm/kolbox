import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY - copy .env.example to .env.local",
  );
}

/**
 * Platform Stage 2: a SEPARATE Supabase Auth client for the Platform Owner
 * console, isolated from BOTH existing Supabase Auth clients in this app:
 *   - `./client.ts` (the campaign user - activist/manager), which uses
 *     `@supabase/supabase-js`'s DEFAULT storage key.
 *   - `./ownerAuthClient.ts` (the Election Owner), key `kb-owner-auth-token`.
 *
 * The isolation is NOT cosmetic. supabase-js derives its default storage key
 * from the project ref (`sb-<ref>-auth-token`), so a second client created
 * against the same project WITHOUT an explicit `storageKey` silently shares -
 * and overwrites - the campaign user's localStorage session. That collision
 * was runtime-proven on this project (signing in on one surface logged the
 * other one out / swapped its identity), which is exactly why every non-
 * default identity in this codebase gets its own explicit key.
 *
 * Corollary, deliberately NOT fixed here: `./client.ts` still has no explicit
 * `storageKey`. Adding one now would change where the campaign session is
 * read from and would immediately sign out every currently signed-in user, so
 * it is tracked as a separate migration - do not "tidy" it as part of this
 * feature.
 *
 * The Platform Owner is a FOURTH, fully independent identity (campaign user /
 * Election Day PermissionUser cookie session / Election Owner / Platform
 * Owner). Nothing in this file may be reused by the other three, and this
 * client must never be signed out by their logout paths.
 */
export const platformOwnerAuthClient = createClient(url, publishableKey, {
  auth: {
    storageKey: "kb-platform-owner-auth-token",
    persistSession: true,
    autoRefreshToken: true,
  },
});
