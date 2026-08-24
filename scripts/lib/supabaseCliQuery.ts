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
 *
 * ============================================================================
 * WHY invokeSupabaseCli EXISTS (do not replace with a bare `execFileSync`)
 * ============================================================================
 * A bare `execFileSync("npx", [...])` (this module's original approach)
 * fails outright on Windows: `npx` on Windows is a `.cmd` batch-file shim,
 * not a directly-executable binary, and Node.js deliberately refuses to
 * `execFileSync`/`spawn` a `.cmd`/`.bat` file at all without `shell: true`
 * (a security fix - CVE-2024-27980 / GHSA-9qxr-qj54-h672 - since `.cmd`
 * execution is inherently shell-adjacent: `cmd.exe` re-parses the command
 * line regardless of Node's own argv quoting). Verified live on this
 * project's own Windows/Node 24 environment: bare `execFileSync("npx", ...)`
 * -> `ENOENT`; explicit `execFileSync("npx.cmd", ...)` -> `EINVAL`.
 *
 * Rather than opt into `shell: true` (which reopens exactly the quoting/
 * injection surface these SQL-carrying calls should never have),
 * `invokeSupabaseCli` resolves and runs `npx`'s own JS entry point
 * (`npx-cli.js`, bundled with the npm that ships alongside any standard
 * `node` install, right next to the currently-running `node` binary -
 * `npx.cmd` itself is nothing but a ~12-line batch stub that does exactly
 * this: `node <npx-cli.js> %*`) directly via `node`, which is a genuine
 * executable, never a shell, identically on every OS. Argument arrays flow
 * through completely untouched - `shell: false` throughout, no quoting or
 * escaping of any kind is performed or needed, because there is no shell
 * anywhere in this chain to escape for. Verified empirically with
 * deliberately dangerous argument content (SQL punctuation/semicolons,
 * quotes, backticks, `cmd.exe` metacharacters, Hebrew/Unicode, embedded
 * newlines) round-tripping byte-for-byte exactly.
 *
 * Falls back to the original bare `"npx"` command name if `npx-cli.js`
 * can't be found at the expected location (a non-standard Node install
 * layout) - harmless on POSIX, where `.cmd`/`.bat` files and this entire
 * problem class don't exist, so the original invocation already worked
 * there and continues to.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SqlQueryOne } from "./backfillPreflight";

/** Resolves how to invoke `npx` without ever touching a `.cmd`/`.bat` shim
 * or a shell - see the module doc comment. Pure path/existence check, no
 * process spawned here. */
export function resolveNpxInvocation(): { command: string; prefixArgs: string[] } {
  const npxCliJs = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  if (existsSync(npxCliJs)) {
    return { command: process.execPath, prefixArgs: [npxCliJs] };
  }
  return { command: "npx", prefixArgs: [] };
}

/** Runs `supabase <args>` via the resolved, shell-free invocation above.
 * The one place both `sqlQueryLinkedSync` and `checkMigrationsInSyncLinked`
 * go through - no duplicated platform-specific logic. `shell: false`
 * (Node's own default, stated explicitly here so it can never be silently
 * dropped) - every element of `args` is passed as an untouched, separate
 * argv entry, exactly as given, to the real `supabase` binary. */
export function invokeSupabaseCli(args: string[]): string {
  const { command, prefixArgs } = resolveNpxInvocation();
  return execFileSync(command, [...prefixArgs, "supabase", ...args], {
    encoding: "utf8",
    shell: false,
  });
}

export function sqlQueryLinkedSync<T>(sql: string): T {
  let out: string;
  try {
    out = invokeSupabaseCli(["db", "query", "--linked", sql]);
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
    const out = invokeSupabaseCli(["migration", "list", "--linked"]);
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
