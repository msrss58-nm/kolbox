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
 *
 * ============================================================================
 * WHY sqlQueryLinkedSync WRITES SQL TO A TEMP FILE (do not pass SQL as the
 * positional `<sql>` argv element)
 * ============================================================================
 * `supabase db query --linked <sql>` (this function's original approach)
 * mishandles multi-line SQL passed as the positional argument: depending on
 * the exact query shape it either throws a `400` from the Management API
 * (`syntax error at end of input`) or - worse - silently returns a truncated,
 * empty-looking result (`{"rows":[{}]}`) instead of erroring, which is not a
 * safe fail-closed behavior. Verified live against the real linked Production
 * project: a single-line query always worked; the exact multi-line
 * `jsonb_build_object(...)` shape `checkRpcAcl` below constructs did not.
 *
 * `supabase db query` has an officially documented `--file, -f <path>` flag
 * ("Path to a SQL file to execute.") as its only other SQL input mechanism -
 * there is no stdin or JSON-query-file option. Verified live against
 * Production that `--file` reproduces the same previously-failing multi-line
 * query correctly. `sqlQueryLinkedSync` now always writes its `sql` argument
 * verbatim (no normalization/collapsing) to an effectively-unique,
 * cryptographically-random-named temp file and invokes `--file <path>`
 * through the same `shell: false` `invokeSupabaseCli` helper - no positional
 * SQL argv element remains, and the SQL text never has to survive an argv
 * round-trip at all.
 *
 * Temp-file cleanup is fail-closed, not best-effort: if the query succeeds
 * but the temp file can't be removed afterward (anything other than
 * `ENOENT`, i.e. it wasn't already gone), the caller does NOT get a
 * successful result back - a residual on-disk SQL file is never silently
 * treated as a harmless side effect. If both the query and cleanup fail,
 * both facts are reported together, path-only, with no SQL content
 * (impossible anyway, since SQL text never touches argv or any error
 * message in this path) and no credentials in either message.
 */
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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

/** Writes `sql` verbatim (no normalization/collapsing) to an
 * effectively-unique, cryptographically-random-named temp file, restricted
 * to the owning user's permissions where the platform honors POSIX mode
 * bits, so `sqlQueryLinkedSync` never has to pass SQL text through argv -
 * see the module doc comment. */
function writeTempSqlFile(sql: string): string {
  const tmpPath = join(tmpdir(), `kolbox-backfill-sql-${randomUUID()}.sql`);
  writeFileSync(tmpPath, sql, { encoding: "utf8", mode: 0o600 });
  return tmpPath;
}

/** `Error#message` only - never the original error object, so a caller can
 * never accidentally serialize a `.stdout`/`.stderr` buffer that could carry
 * unrelated output. Every message in this module comes from Node's own
 * fs/child_process errors, which describe paths and OS-level failures only -
 * SQL text never reaches argv or any error path here, so there is nothing
 * SQL-shaped for these messages to ever contain. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Combines the query-execution and temp-file-cleanup outcomes into the
 * correct fail-closed decision: a cleanup failure must not be silently
 * swallowed even when the query itself succeeded, and both failures must be
 * reported together when they co-occur - neither ever masks the other.
 * Throws on any failure; returns normally only when both `queryError` and
 * `cleanupError` are `undefined`. Pure and side-effect-free (no filesystem/
 * CLI access of its own) - exported as a deterministic testing seam so all
 * four query/cleanup outcome combinations can be exercised directly,
 * without needing to fabricate real fs/CLI failures. `tmpPath` is used only
 * for path-only reporting, never SQL content or credentials. */
export function throwOnQueryOrCleanupFailure(
  tmpPath: string,
  queryError: unknown,
  cleanupError: unknown,
): void {
  if (queryError !== undefined && cleanupError !== undefined) {
    throw new Error(
      `sqlQueryLinkedSync: the query failed AND the temporary SQL file could not be removed (path: ${tmpPath}) - a residual SQL file may remain on disk. Query error: ${describeError(queryError)}. Cleanup error: ${describeError(cleanupError)}.`,
    );
  }
  if (queryError !== undefined) {
    throw new Error(
      `sqlQueryLinkedSync: \`supabase db query --linked --file\` failed to execute: ${describeError(queryError)}`,
    );
  }
  if (cleanupError !== undefined) {
    throw new Error(
      `sqlQueryLinkedSync: the query itself succeeded, but the temporary SQL file at ${tmpPath} could not be removed afterward - refusing to report success while a residual SQL file may remain on disk. Cleanup error: ${describeError(cleanupError)}.`,
    );
  }
}

export function sqlQueryLinkedSync<T>(sql: string): T {
  const tmpPath = writeTempSqlFile(sql);

  let out: string | undefined;
  let queryError: unknown;
  try {
    out = invokeSupabaseCli(["db", "query", "--linked", "--file", tmpPath]);
  } catch (err) {
    queryError = err;
  }

  let cleanupError: unknown;
  try {
    unlinkSync(tmpPath);
  } catch (err) {
    // ENOENT means the file is already gone - already-cleaned, not a
    // failure. Anything else means a residual SQL file may remain on disk
    // and must not be silently treated as a harmless side effect.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      cleanupError = err;
    }
  }

  throwOnQueryOrCleanupFailure(tmpPath, queryError, cleanupError);

  // throwOnQueryOrCleanupFailure did not throw, so both queryError and
  // cleanupError are undefined, meaning `out` was definitely assigned by
  // invokeSupabaseCli above.
  const cliOutput = out as string;
  const jsonStart = cliOutput.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(
      "sqlQueryLinkedSync: no JSON object found in `supabase db query --linked` output - malformed CLI output.",
    );
  }
  let parsed: { rows?: T[] };
  try {
    parsed = JSON.parse(cliOutput.slice(jsonStart)) as { rows?: T[] };
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
