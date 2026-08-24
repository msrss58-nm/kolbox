/**
 * Multi-Tenant Phase 2 - Production target identity hard gate.
 *
 * Proves BOTH execution paths the production runner uses actually target the
 * same, approved Production project - never a substring match, never an
 * assumption:
 *
 * A. `SUPABASE_URL` (used for the Admin API / RPC client) - parsed with
 *    `new URL()`, its hostname required to match `<ref>.supabase.co`
 *    exactly, never `.includes()`.
 * B. The Supabase CLI's own linked project (used by every
 *    `supabase db query --linked` call) - determined from the CLI's own
 *    local link-state files under `supabase/.temp/`, written by
 *    `supabase link` and never containing a credential. Two independent
 *    files (`project-ref` and `linked-project.json`) are read and required
 *    to agree, so a stale/partially-written link state is caught rather
 *    than trusted.
 *
 * Both refs, plus the fixed `APPROVED_PRODUCTION_PROJECT_REF`, must all be
 * identical or `requireProductionIdentityMatch` throws - callers must treat
 * any thrown error here as a hard stop before password generation or any
 * mutation. No connection string, key, or token is ever read or exposed by
 * this module - only small, non-secret project-identity metadata files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const APPROVED_PRODUCTION_PROJECT_REF = "nbymfgphnsounqncfjgl";

export function parseProductionUrlRef(supabaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new Error(
      `parseProductionUrlRef: SUPABASE_URL is not a valid URL: "${supabaseUrl}"`,
    );
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match) {
    throw new Error(
      `parseProductionUrlRef: SUPABASE_URL hostname "${parsed.hostname}" does not match the expected "<ref>.supabase.co" shape - refusing a substring/partial match.`,
    );
  }
  return match[1];
}

export interface CliLinkedProjectRef {
  ref: string;
  source: string;
}

/** Reads the Supabase CLI's own local link-state files - never queries a
 * live service, never touches a credential. `supabaseDir` is the path to
 * the project's `supabase/` directory (parameterized so this is testable
 * against a fabricated fixture directory without touching the real repo). */
export function getCliLinkedProjectRef(supabaseDir: string): CliLinkedProjectRef {
  const projectRefPath = join(supabaseDir, ".temp", "project-ref");
  const linkedProjectJsonPath = join(supabaseDir, ".temp", "linked-project.json");

  if (!existsSync(projectRefPath)) {
    throw new Error(
      `getCliLinkedProjectRef: no linked project found (missing ${projectRefPath}) - run \`supabase link\` first. Refusing to guess.`,
    );
  }
  const refFromFile = readFileSync(projectRefPath, "utf8").trim();
  if (!refFromFile) {
    throw new Error(`getCliLinkedProjectRef: ${projectRefPath} is empty.`);
  }

  if (!existsSync(linkedProjectJsonPath)) {
    throw new Error(
      `getCliLinkedProjectRef: no linked project metadata found (missing ${linkedProjectJsonPath}) - cannot corroborate the linked project ref. Refusing to guess.`,
    );
  }
  let linkedJson: { ref?: string };
  try {
    linkedJson = JSON.parse(readFileSync(linkedProjectJsonPath, "utf8")) as {
      ref?: string;
    };
  } catch {
    throw new Error(
      `getCliLinkedProjectRef: ${linkedProjectJsonPath} is not valid JSON.`,
    );
  }
  if (!linkedJson.ref) {
    throw new Error(
      `getCliLinkedProjectRef: ${linkedProjectJsonPath} has no "ref" field.`,
    );
  }

  if (linkedJson.ref !== refFromFile) {
    throw new Error(
      `getCliLinkedProjectRef: the CLI's two link-state sources disagree - ${projectRefPath} says "${refFromFile}", ${linkedProjectJsonPath} says "${linkedJson.ref}". Refusing to trust an inconsistent link state.`,
    );
  }

  return {
    ref: refFromFile,
    source: `${projectRefPath} + ${linkedProjectJsonPath} (agree)`,
  };
}

/**
 * Hard gate: throws unless env-target-ref == CLI-linked-ref ==
 * `APPROVED_PRODUCTION_PROJECT_REF`. Callers must run this before
 * generating a password or performing any mutation, and must treat any
 * thrown error as a hard stop, not a warning.
 */
export function requireProductionIdentityMatch(
  supabaseUrl: string,
  supabaseDir: string,
): { urlRef: string; cliRef: string } {
  const urlRef = parseProductionUrlRef(supabaseUrl);
  const cli = getCliLinkedProjectRef(supabaseDir);

  if (urlRef !== APPROVED_PRODUCTION_PROJECT_REF) {
    throw new Error(
      `requireProductionIdentityMatch: SUPABASE_URL project ref "${urlRef}" does not match the approved Production ref "${APPROVED_PRODUCTION_PROJECT_REF}".`,
    );
  }
  if (cli.ref !== APPROVED_PRODUCTION_PROJECT_REF) {
    throw new Error(
      `requireProductionIdentityMatch: Supabase CLI linked project ref "${cli.ref}" (${cli.source}) does not match the approved Production ref "${APPROVED_PRODUCTION_PROJECT_REF}".`,
    );
  }
  if (urlRef !== cli.ref) {
    throw new Error(
      `requireProductionIdentityMatch: SUPABASE_URL ref "${urlRef}" and CLI-linked ref "${cli.ref}" disagree - env target and CLI target are not the same project.`,
    );
  }

  return { urlRef, cliRef: cli.ref };
}
