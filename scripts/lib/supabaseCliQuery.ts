/**
 * Shared, credential-safe read-only SQL execution against the linked
 * Production project via the already-authenticated Supabase CLI
 * (`supabase db query --linked`). The CLI manages the connection/credential
 * internally - this module never sees, constructs, or prints a connection
 * string or key. Used by the production runner, the post-flight verifier,
 * and the recovery tool, so the parsing/error handling is written once.
 *
 * Every failure mode is a thrown Error with a specific, actionable message -
 * never a silent empty result - so a caller's own try/catch can fail closed
 * cleanly instead of proceeding on bad data.
 */
import { execFileSync } from "node:child_process";
import type { SqlQueryOne } from "./backfillPreflight";

export function sqlQueryLinkedSync<T>(sql: string): T {
  let out: string;
  try {
    out = execFileSync("npx", ["supabase", "db", "query", "--linked", sql], {
      encoding: "utf8",
    });
  } catch (err) {
    throw new Error(
      `sqlQueryLinkedSync: \`supabase db query --linked\` failed to execute: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const jsonStart = out.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(
      "sqlQueryLinkedSync: no JSON object found in `supabase db query --linked` output - malformed CLI output.",
    );
  }
  let parsed: { rows?: T[] };
  try {
    parsed = JSON.parse(out.slice(jsonStart)) as { rows?: T[] };
  } catch {
    throw new Error(
      "sqlQueryLinkedSync: `supabase db query --linked` output was not valid JSON - malformed CLI output.",
    );
  }
  if (!Array.isArray(parsed.rows)) {
    throw new Error(
      "sqlQueryLinkedSync: `supabase db query --linked` output had no `rows` array - malformed CLI output.",
    );
  }
  if (parsed.rows.length === 0) {
    throw new Error("sqlQueryLinkedSync: query returned zero rows.");
  }
  return parsed.rows[0];
}

/** Promise-returning adapter matching the `SqlQueryOne` contract shared with
 * backfillPreflight.ts/backfillPostflight.ts. */
export const sqlQueryLinked: SqlQueryOne = async <T>(sql: string) =>
  sqlQueryLinkedSync<T>(sql);

/** Best-effort migration local/remote sync check via `supabase migration
 * list --linked`. Returns `null` (not `false`) on any parse/execution
 * failure - "could not be verified" is a distinct, honestly-reported state
 * from "verified and found drifted", per this check's own documented
 * "if safely obtainable" scope. */
export function checkMigrationsInSyncLinked(): boolean | null {
  try {
    const out = execFileSync("npx", ["supabase", "migration", "list", "--linked"], {
      encoding: "utf8",
    });
    const jsonStart = out.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(out.slice(jsonStart)) as {
      migrations?: Array<{ local?: string; remote?: string }>;
    };
    if (!Array.isArray(parsed.migrations) || parsed.migrations.length === 0) return null;
    return parsed.migrations.every(
      (m) => !!m.local && !!m.remote && m.local === m.remote,
    );
  } catch {
    return null;
  }
}
