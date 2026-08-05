import type { DatabaseRole, EffectiveRole } from "./types";

/**
 * The one and only place that knows how today's `DatabaseRole`
 * ("manager" | "user" | "voting") maps onto the three final `EffectiveRole`s.
 *
 * `"user"` is a legacy value - approved product decision is to treat it as
 * `"operations"`. No other file in the codebase should compare a role
 * against `"user"` or `"operations"` directly - everything downstream reads
 * an `EffectiveRole` that already came out of this function.
 */
export function resolveEffectiveRole(role: DatabaseRole): EffectiveRole {
  if (role === "manager") return "manager";
  if (role === "voting") return "voting";
  return "operations"; // legacy: "user" → "operations"
}
