import { useEffect } from "react";
import { api } from "../../services/api";
import type { CurrentUser } from "../../types";

/**
 * A real activist's Supabase account has no matching record in the local
 * mock voter/activist store (which is per-browser localStorage, not a real
 * shared backend yet). This ensures one exists - keyed to their real user
 * id - so classifying voters and the leaderboard work the same for a real
 * login as for the seeded demo activists.
 */
export function useSyncActivistProfile(user: CurrentUser | null) {
  useEffect(() => {
    if (!user || user.role !== "activist") return;
    const [firstName, ...rest] = user.name.split(" ");
    void api.ensureActivistProfile(user.id, {
      firstName: firstName || user.name,
      lastName: rest.join(" ") || "",
      phone: "",
      area: "",
    });
  }, [user]);
}
